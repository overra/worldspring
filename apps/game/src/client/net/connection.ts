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

// --- Auto-reconnect. The server's Durable Object instance can be replaced
// under load (a split-brain recycle severs the live socket and the old instance
// times it out with code 1001), and deploys / network blips also drop the
// connection. Rather than bailing to the menu, reopen with the SAME persisted
// token — the server restores the same character on the CURRENT instance
// (handleJoin restore path). Backoff caps the retry rate; after MAX_ATTEMPTS
// consecutive failures it's treated as a real disconnect.
let lastName: string | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_BASE_MS = 250;
const RECONNECT_CAP_MS = 3000;

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

export function connect(name: string): void {
  if (socket !== null) disconnect();

  lastName = name.slice(0, MAX_NAME_LENGTH);
  reconnectAttempts = 0;

  const ui = useUIStore.getState();
  ui.setError(null);
  ui.setPhase("connecting");

  openSocket();
}

/** Open the WebSocket and wire its handlers. Used for the initial connect AND
 * every auto-reconnect attempt — the join carries lastName + the persisted
 * token, so a reconnect restores the same character on the current instance. */
function openSocket(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    sendMsg({
      t: "join",
      name: (lastName ?? "").slice(0, MAX_NAME_LENGTH),
      token: getToken(),
      proto: PROTOCOL_VERSION, // two-sided join gate (doc 03 §1)
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

export function disconnect(): void {
  // Intentional close: stop any pending reconnect and forget the session, so a
  // stray close event can never trigger an auto-reconnect after a real leave.
  cancelReconnect();
  lastName = null;
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

  // In-game drop → auto-reconnect with the persisted token instead of bailing
  // to the menu. Keep the last rendered frame frozen under the "Reconnecting…"
  // overlay (do NOT reset the client world here); onWelcome rebuilds it on a
  // successful reconnect.
  if (lastName !== null && (phase === "playing" || phase === "dead" || phase === "reconnecting")) {
    scheduleReconnect();
    return;
  }

  // Initial connect failed, or no resumable session: return to the menu.
  resetPrediction();
  resetInterpolation();
  resetClientWorld();
  ui.setRecap(null);
  ui.setDeathCause(null);
  ui.closeChat();
  ui.clearChatLog();
  if (phase === "connecting") ui.setError("Could not connect");
  ui.setPhase("menu");
}

/** Cancel any scheduled reconnect and reset the backoff. */
function cancelReconnect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
}

/** Schedule the next reconnect attempt with exponential backoff, or give up
 * (real disconnect → menu) after MAX_RECONNECT_ATTEMPTS. */
function scheduleReconnect(): void {
  const ui = useUIStore.getState();
  reconnectAttempts += 1;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    cancelReconnect();
    resetPrediction();
    resetInterpolation();
    resetClientWorld();
    ui.setRecap(null);
    ui.setDeathCause(null);
    ui.closeChat();
    ui.clearChatLog();
    ui.setError("Connection lost");
    ui.setPhase("menu");
    return;
  }
  ui.setPhase("reconnecting");
  // Exponential backoff (250ms, 500, 1000, 2000, capped 3s) with ±50% jitter, so
  // a MASS drop — a recycle 1001-closing every connected player at once — doesn't
  // reconnect as a synchronized thundering herd against the new instance.
  const base = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1));
  const delay = base * (0.5 + Math.random() * 0.5);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (lastName === null) return; // disconnected while the timer was pending
    openSocket();
  }, delay);
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

  // A welcome means we're connected (initial join or a successful reconnect) —
  // clear the reconnect backoff so the next drop starts a fresh attempt budget.
  reconnectAttempts = 0;

  resetPrediction();
  resetInterpolation();
  // Drop stale remote views from before a reconnect drop (resetInterpolation
  // only clears the snapshot buffer) so they don't render for a frame at old
  // positions before the first post-welcome snapshot prunes them. No-op on an
  // initial connect (the maps are already empty).
  clientWorld.players.clear();
  clientWorld.zombies.clear();
  clientWorld.animals.clear();

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

  ui.setVitals(vitalsOf(msg.you));
  ui.setPlayerCount(msg.count);
  ui.setClockHours(effectiveGameHour(clientWorld.config.time, msg.time));
  if (msg.events.length > 0) {
    clientWorld.events.push(...msg.events);
    clientWorld.audioEvents.push(...msg.events);
  }
}
