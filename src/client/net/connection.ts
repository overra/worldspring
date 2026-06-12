// WebSocket connection lifecycle + server message handling. Module-level
// singleton: the game has exactly one connection. Only the contract-named
// functions are exported; snapshot routing into prediction/interpolation and
// the UI store happens here at message rate.

import {
  CHAT_MAX_LENGTH,
  DAY_DURATION_S,
  MAX_NAME_LENGTH,
  START_HOUR,
} from "@/shared/constants";
import { ITEM_DEFS } from "@/shared/items";
import { gameHours } from "@/shared/protocol";
import type { ClientMsg, ServerMsg, Vitals, YouState } from "@/shared/protocol";
import { createWorld } from "@/shared/world";
import { clientWorld, resetClientWorld } from "@/client/runtime";
import { cueSound } from "@/client/audio/cues";
import { useUIStore } from "@/client/state/store";
import { clearPending, reconcile, resetPrediction } from "./prediction";
import { pushSnap, resetInterpolation, setTimeBase } from "./interpolation";
import type { SnapMsg } from "./interpolation";

const PING_INTERVAL_MS = 2000;

let socket: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

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

  const ui = useUIStore.getState();
  ui.setError(null);
  ui.setPhase("connecting");

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    sendMsg({ t: "join", name: name.slice(0, MAX_NAME_LENGTH), token: getToken() });
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
  resetPrediction();
  resetInterpolation();
  resetClientWorld();
  ui.setRecap(null);
  ui.setDeathCause(null);
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
  resetPrediction();
  resetInterpolation();

  clientWorld.world = createWorld(msg.seed);
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
  ui.setClockHours(gameHours(msg.time, DAY_DURATION_S, START_HOUR));
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
  ui.setClockHours(gameHours(msg.time, DAY_DURATION_S, START_HOUR));
  if (msg.events.length > 0) {
    clientWorld.events.push(...msg.events);
    clientWorld.audioEvents.push(...msg.events);
  }
}
