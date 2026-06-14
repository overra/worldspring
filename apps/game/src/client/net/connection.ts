// WebSocket connection lifecycle + server message handling. Module-level
// singleton: the game has exactly one connection. Only the contract-named
// functions are exported; snapshot routing into prediction/interpolation and
// the UI store happens here at message rate.

import {
  CHAT_MAX_LENGTH,
  MAX_NAME_LENGTH,
} from "@worldspring/shared/constants";
import { clampConfig, effectiveGameHour } from "@worldspring/shared/config";
import { ITEM_DEFS } from "@worldspring/shared/items";
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import type { ClientMsg, ServerMsg, Vitals, YouState } from "@worldspring/shared/protocol";
import { createWorld } from "@worldspring/shared/world";
import { clientWorld, resetClientWorld } from "@/client/runtime";
import { cueSound } from "@/client/audio/cues";
import { useUIStore } from "@/client/state/store";
import { clearPending, reconcile, resetPrediction } from "./prediction";
import { pushSnap, resetInterpolation, setTimeBase } from "./interpolation";
import type { SnapMsg } from "./interpolation";

const PING_INTERVAL_MS = 2000;

let socket: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
// Last name used to join — remembered so the preview testbed QA panel (doc 10
// M4) can re-provision (RESET / set-switch) by rejoining with the same name.
let lastName = "Survivor";

// --- Identity token: 32 hex chars, persisted so the server can restore the
// same character across page loads. localStorage can throw (private browsing,
// blocked storage) — fall back to an in-memory token for the session.

const TOKEN_STORAGE_KEY = "ws_token";
// Pre-Worldspring key; read once as a fallback and migrated forward (below) so
// existing players keep the same character across the rename.
const LEGACY_TOKEN_KEY = "dc_token";

let memoryToken: string | null = null;

function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function getToken(): string {
  if (memoryToken !== null) return memoryToken;
  try {
    const stored =
      localStorage.getItem(TOKEN_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_TOKEN_KEY);
    if (stored !== null && /^[0-9a-f]{32,64}$/i.test(stored)) {
      memoryToken = stored;
      localStorage.setItem(TOKEN_STORAGE_KEY, stored);
      return stored;
    }
    const fresh = generateToken();
    localStorage.setItem(TOKEN_STORAGE_KEY, fresh);
    memoryToken = fresh;
    return fresh;
  } catch {
    memoryToken = generateToken();
    return memoryToken;
  }
}

export function connect(name: string, scenario?: string): void {
  if (socket !== null) disconnect();
  lastName = name;

  const ui = useUIStore.getState();
  ui.setError(null);
  ui.setPhase("connecting");

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    sendMsg({
      t: "join",
      name: name.slice(0, MAX_NAME_LENGTH),
      token: getToken(),
      proto: PROTOCOL_VERSION, // two-sided join gate (doc 03 §1)
      // doc 10 M3/M4: preview-only testbed set selector. The server ignores it
      // unless env.TESTBED is on, so it is inert in prod.
      ...(scenario ? { scenario } : {}),
    });
    startPing();
  };
  ws.onmessage = (ev: MessageEvent) => {
    if (socket !== ws) return;
    handleMessage(ev.data);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    handleClosed();
  };
  ws.onerror = () => {
    if (socket !== ws) return;
    handleClosed();
  };
}

/** Replace the persisted identity with a brand-new token so the NEXT join is a
 * fresh life (handleJoin path 3 → provisionTestbed re-seeds), not a resume.
 * Used only by the preview testbed QA panel. */
function forceFreshToken(): void {
  const fresh = generateToken();
  memoryToken = fresh;
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, fresh);
  } catch {
    /* in-memory token only (private browsing / blocked storage) */
  }
}

/** Testbed RESET / set-switch (doc 10 M4): rejoin as a fresh life provisioned
 * with `scenario`. Fresh token → handleJoin path 3 → provisionTestbed. Preview-
 * only — the server ignores the scenario field unless env.TESTBED is on. */
export function reprovision(scenario: string): void {
  forceFreshToken();
  connect(lastName, scenario);
}

export function disconnect(): void {
  stopPing();
  const ws = socket;
  socket = null;
  if (ws !== null) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
  }
  resetPrediction();
  resetInterpolation();
  resetClientWorld();
  const ui = useUIStore.getState();
  ui.setRecap(null);
  ui.setDeathCause(null);
  ui.setRealm("overworld");
  ui.closeChat();
  ui.clearChatLog(); // stale chatOpen would pop the input open on the next join
  if (ui.phase !== "menu") ui.setPhase("menu");
}

/** Send a message if the socket is open; silently a no-op otherwise. */
export function sendMsg(msg: ClientMsg): void {
  if (socket === null || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(msg));
}

// --- Action helpers (thin wrappers used by input + UI) ---

export function doAttack(): void {
  // Aim timestamp: the game-time of the interpolated world on the shooter's
  // screen. The server rewinds hit targets to it (clamped server-side).
  const at = clientWorld.renderGameTime;
  sendMsg(at > 0 ? { t: "attack", at } : { t: "attack" });
}

export function doUse(slot: number): void {
  sendMsg({ t: "use", slot });
  // Optimistic local feedback; the server confirms via the next inv message.
  const stack = useUIStore.getState().inventory[slot];
  if (!stack) return;
  const kind = ITEM_DEFS[stack.type].kind;
  if (kind === "food") cueSound("eat");
  else if (kind === "drink") cueSound("drink");
  else if (kind === "heal") cueSound("bandage");
  else if (kind === "placeable") cueSound("campfire_place");
}

export function doEquip(slot: number): void {
  sendMsg({ t: "equip", slot });
}

export function doPickup(id: number): void {
  sendMsg({ t: "pickup", id });
  cueSound("pickup");
}

export function doDrop(slot: number): void {
  sendMsg({ t: "drop", slot });
}

export function doRespawn(): void {
  sendMsg({ t: "respawn" });
}

/** Send a proximity-chat line; a no-op when the socket is closed (sendMsg).
 * The input enforces CHAT_MAX_LENGTH already — the slice is paste-proofing. */
export function sendChat(text: string): void {
  const trimmed = text.trim().slice(0, CHAT_MAX_LENGTH);
  if (trimmed.length === 0) return;
  sendMsg({ t: "chat", text: trimmed });
}

// --- Internals ---

function startPing(): void {
  stopPing();
  pingTimer = setInterval(() => {
    sendMsg({ t: "ping", ts: Date.now() });
  }, PING_INTERVAL_MS);
}

function stopPing(): void {
  if (pingTimer === null) return;
  clearInterval(pingTimer);
  pingTimer = null;
}

/** Unexpected close/error (intentional disconnects detach handlers first). */
function handleClosed(): void {
  stopPing();
  socket = null;
  const ui = useUIStore.getState();
  const phase = ui.phase;
  resetPrediction();
  resetInterpolation();
  resetClientWorld();
  ui.setRecap(null);
  ui.setDeathCause(null);
  ui.setRealm("overworld");
  ui.closeChat();
  ui.clearChatLog();
  if (phase === "playing" || phase === "dead") {
    ui.setError("Connection lost");
  } else if (phase === "connecting") {
    ui.setError("Could not connect");
  }
  ui.setPhase("menu");
}

function handleMessage(data: unknown): void {
  if (typeof data !== "string") return;
  let msg: ServerMsg;
  try {
    msg = JSON.parse(data) as ServerMsg;
  } catch (err) {
    console.error("net: malformed server message", err);
    return;
  }

  const ui = useUIStore.getState();
  switch (msg.t) {
    case "welcome":
      onWelcome(msg);
      return;
    case "snap":
      onSnap(msg);
      return;
    case "inv":
      ui.setInventory(msg.slots, msg.selected);
      return;
    case "chat":
      ui.pushChat(msg.name, msg.text);
      return;
    case "death":
      ui.setDeathCause(msg.by);
      ui.setRecap(msg.recap);
      ui.closeChat(); // a half-typed line must not sit over the death screen
      ui.setPhase("dead"); // socket stays open; respawn reuses it
      return;
    case "notice":
      ui.pushNotice(msg.msg);
      return;
    case "pong":
      ui.setPingMs(Date.now() - msg.ts);
      return;
    case "error":
      ui.setError(msg.msg);
      disconnect();
      return;
  }
}

function vitalsOf(you: YouState): Vitals {
  return { hp: you.hp, food: you.food, water: you.water, temp: you.temp };
}

function setMeFrom(you: YouState): void {
  const me = clientWorld.me;
  me.x = you.x;
  me.y = you.y;
  me.z = you.z;
  me.vy = you.vy;
  me.grounded = you.grounded;
}

function onWelcome(msg: Extract<ServerMsg, { t: "welcome" }>): void {
  // Client-side half of the two-sided protocol gate (doc 03 §1): refuse a
  // server whose protocol differs from ours BEFORE building the world, so a
  // desync never starts. An absent `proto` (an older server that predates the
  // field) reads as undefined !== PROTOCOL_VERSION, so the same check treats it
  // as a mismatch. This catches new-client-vs-old-server; the server-side gate
  // covers the other direction.
  if (msg.proto !== PROTOCOL_VERSION) {
    const ui = useUIStore.getState();
    ui.setError("This server runs an incompatible version. Update your game or pick another server.");
    disconnect();
    return;
  }

  resetPrediction();
  resetInterpolation();

  clientWorld.world = createWorld(msg.seed);
  // Clamp the server's config before storing — NEVER store the raw object. A
  // hostile open-source server (doc 02's first-party join path) could send
  // zombieDensity:1e9 (OOM) or dayLengthMin:0 (NaN clock); clampConfig bounds
  // every field. Absent config → DEFAULT_CONFIG (clampConfig's base). M1 stores
  // it but does not yet drive runtime behavior off it (clock swap deferred to
  // M4 to keep this PR byte-identical).
  clientWorld.config = clampConfig(msg.config);
  clientWorld.myId = msg.id;
  setMeFrom(msg.you);
  clientWorld.me.yaw = 0;
  clientWorld.me.pitch = 0;
  clientWorld.ready = true;
  setTimeBase(msg.time, performance.now());

  const ui = useUIStore.getState();
  if (msg.resumed) ui.pushNotice("character restored");
  // Set unconditionally: null CLEARS any recap left over from a previous
  // session (die -> leave -> rejoin must not show a stale LAST LIFE toast).
  ui.setRecap(msg.recap);
  ui.setInventory(msg.inv, msg.selected);
  ui.setVitals(vitalsOf(msg.you));
  ui.setRealm(msg.you.realm);
  ui.setClockHours(effectiveGameHour(clientWorld.config.time, msg.time));
  if (msg.you.hp > 0) {
    ui.setPhase("playing");
  } else {
    // Defensive: a welcome for a dead character (e.g. taking over a session
    // that sat on the death screen). The server also re-sends the death
    // message in that case; entering "dead" here covers any path it misses.
    ui.setDeathCause(msg.recap?.by ?? "the wasteland");
    ui.setPhase("dead");
  }
}

function onSnap(msg: SnapMsg): void {
  const now = performance.now();
  const ui = useUIStore.getState();

  if (ui.phase === "dead") {
    // Server confirmed respawn: snap back to life at the authoritative spot.
    if (msg.you.hp > 0) {
      clearPending();
      setMeFrom(msg.you);
      ui.setRecap(null); // the finished life's stats leave with the screen
      ui.setPhase("playing");
    }
  } else {
    reconcile(msg.ack, msg.you);
  }

  pushSnap(msg, now);

  // Realm + portals flow straight in: realm re-themes terrain/sky (store-driven
  // React re-render of the world components), portals feed the per-frame renderer.
  ui.setRealm(msg.you.realm);
  clientWorld.portals = msg.portals;

  ui.setVitals(vitalsOf(msg.you));
  ui.setPlayerCount(msg.count);
  ui.setClockHours(effectiveGameHour(clientWorld.config.time, msg.time));
  if (msg.events.length > 0) {
    clientWorld.events.push(...msg.events);
    clientWorld.audioEvents.push(...msg.events);
  }
}
