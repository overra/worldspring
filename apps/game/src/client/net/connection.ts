// WebSocket connection lifecycle + server message handling. Module-level
// singleton: the game has exactly one connection. Only the contract-named
// functions are exported; snapshot routing into prediction/interpolation and
// the UI store happens here at message rate.

import {
  CHAT_MAX_LENGTH,
  MAX_NAME_LENGTH,
} from "@worldspring/shared/constants";
import { clampConfig, effectiveGameHour, worldParamsOf } from "@worldspring/shared/config";
import { decodeExplored, setExploredIndices } from "@worldspring/shared/fog";
import { ITEM_DEFS, UNKNOWN_DEF } from "@worldspring/shared/items";
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import type { ClientMsg, ServerMsg, Vitals, WearSlot, WirePiece, YouState } from "@worldspring/shared/protocol";
import type { PlaceTarget } from "@worldspring/shared/structures";
import { createWorld } from "@worldspring/shared/world";
import { clientWorld, resetClientWorld } from "@/client/runtime";
import { cueSound } from "@/client/audio/cues";
import { useUIStore } from "@/client/state/store";
import { clearPending, reconcile, resetPrediction } from "./prediction";
import { isDelayedFxEvent, pushSnap, resetInterpolation, setTimeBase } from "./interpolation";
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
//
// lastName/lastScenario are the join params, remembered so a reconnect re-sends
// them (and so the preview testbed QA panel can reprovision, doc 10 M4). A null
// lastName means no active session — handleClosed won't auto-reconnect.
let lastName: string | null = null;
let lastScenario: string | undefined;
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

export function connect(name: string, scenario?: string): void {
  cancelReconnect();
  if (socket !== null) disconnect();
  lastName = name.slice(0, MAX_NAME_LENGTH);
  lastScenario = scenario;
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
      // doc 10 M3/M4: preview-only testbed set selector. Remembered (lastScenario)
      // so a reconnect re-sends it. The server ignores it unless env.TESTBED is
      // on, so it is inert in prod.
      ...(lastScenario ? { scenario: lastScenario } : {}),
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
  connect(lastName ?? "Survivor", scenario);
}

export function disconnect(): void {
  // Intentional close: stop any pending reconnect and forget the session, so a
  // stray close event can never trigger an auto-reconnect after a real leave.
  cancelReconnect();
  lastName = null;
  lastScenario = undefined;
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
  ui.setCodePad(null); // doc 06 — overlays never survive a session
  ui.setContainer(null);
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
  const kind = (ITEM_DEFS[stack.type] ?? UNKNOWN_DEF).kind;
  if (kind === "food") cueSound("eat");
  else if (kind === "drink") cueSound("drink");
  else if (kind === "heal") cueSound("bandage");
  else if (kind === "placeable") cueSound("campfire_place");
}

export function doEquip(slot: number): void {
  sendMsg({ t: "equip", slot });
}

/** Request crafting RECIPES[recipe]; the server validates and confirms via inv. */
export function doCraft(recipe: number): void {
  sendMsg({ t: "craft", recipe });
}

/** Wear the kind:"wear" item in `slot` (doc 05 M6); confirmed via inv.worn. */
export function doWear(slot: number): void {
  sendMsg({ t: "wear", slot });
}

/** Remove the worn item in `ws` (doc 05 M6); the server rejects with a notice
 * when it doesn't fit — never silently dropped. */
export function doUnwear(ws: WearSlot): void {
  sendMsg({ t: "unwear", ws });
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

/** doc 06 — request a structure placement at a snapped grid address. The
 * server re-validates everything; the ghost's shared canPlace makes a
 * rejection rare (occupancy races aside). Crates carry their free in-cell
 * position (x/z). */
export function doPlace(target: PlaceTarget): void {
  sendMsg({
    t: "place",
    kind: target.kind,
    tier: target.tier,
    gx: target.gx,
    gz: target.gz,
    ...(target.edge !== undefined ? { edge: target.edge } : {}),
    ...(target.x !== undefined && target.z !== undefined
      ? { x: target.x, z: target.z }
      : {}),
  });
}

/** doc 06 — owner-only demolish (the server enforces ownership). */
export function doDemolish(id: number): void {
  sendMsg({ t: "demolish", id });
}

/** doc 06 — toggle a door/gate. Not client-predicted: the ~1 RTT latency on
 * a door swing is acceptable (doc 06:174). */
export function doDoor(id: number): void {
  sendMsg({ t: "door", id });
}

/** doc 06 M5 — owner: set/change a door code ("" removes the lock). */
export function doSetCode(id: number, code: string): void {
  sendMsg({ t: "setCode", id, code });
}

/** doc 06 M5 — the door id of OUR last tryCode submit. sState `open` is a
 * GLOBAL broadcast, so without this a third party opening the door while our
 * try-pad happens to be up would poison unlockedDoors: the pad would never
 * show again for that door this session while the server keeps rejecting the
 * bare toggle. Only an open that follows our own submit earns the cache. */
let pendingTryId: number | null = null;

/** doc 06 M5 — try a 4-digit code on a locked door (the code-pad submit). */
export function doTryCode(id: number, code: string): void {
  pendingTryId = id;
  sendMsg({ t: "tryCode", id, code });
}

/** doc 06 M6 — request a crate's contents; the server replies `cont`. */
export function doContainerOpen(id: number): void {
  sendMsg({ t: "cOpen", id });
}

/** doc 06 M6 — move one whole stack between inventory and a crate slot. */
export function doContainerMove(id: number, from: number, to: number, dir: "in" | "out"): void {
  sendMsg({ t: "cMove", id, from, to, dir });
}

/** doc 13 M4 — board vehicle `id` at `seat` (0 driver, 1 passenger). */
export function doEnterVehicle(id: number, seat: number): void {
  sendMsg({ t: "enterVehicle", id, seat });
}

/** doc 13 M4 — leave the vehicle (server places you beside it). */
export function doExitVehicle(): void {
  sendMsg({ t: "exitVehicle" });
}

/** doc 13 M4 — driver control (server-authoritative; NOT predicted). Sent at the
 * input cadence from NetSystem while seated as driver. */
export function doDrive(throttle: number, steer: number, brake: number): void {
  sendMsg({ t: "drive", throttle, steer, brake });
}

/** doc 13 M4 — refuel a nearby vehicle from a jerry can in inventory. */
export function doRefuel(id: number): void {
  sendMsg({ t: "refuel", id });
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
  ui.setRealm("overworld");
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
      ui.setInventory(msg.slots, msg.selected, msg.worn);
      return;
    case "chat":
      ui.pushChat(msg.name, msg.text);
      return;
    case "death":
      ui.setDeathCause(msg.by);
      ui.setRecap(msg.recap);
      ui.closeChat(); // a half-typed line must not sit over the death screen
      ui.setCodePad(null); // doc 06 — no overlays over the death screen
      ui.setContainer(null);
      ui.setPhase("dead"); // socket stays open; respawn reuses it
      return;
    case "notice":
      ui.pushNotice(msg.msg);
      return;
    // doc 06 — structure sync. The wire records are applied to the shared
    // index VERBATIM (no client-side derivation of floorY or ids), so both
    // sides run identical mutations on identical records — the prediction
    // parity guarantee. sFull batches arrive right after welcome (the index
    // is freshly empty from createWorld); deltas are global.
    case "sFull": {
      const idx = clientWorld.world?.structures;
      if (!idx) return;
      for (const piece of msg.pieces) idx.add(piece);
      clientWorld.structuresVersion++;
      return;
    }
    case "sAdd": {
      clientWorld.world?.structures.add(msg.piece);
      clientWorld.structuresVersion++;
      return;
    }
    case "sRemove": {
      clientWorld.world?.structures.remove(msg.id);
      clientWorld.unlockedDoors.delete(msg.id);
      // The piece under an open pad/panel is gone (demolished/destroyed).
      if (ui.codePad?.id === msg.id) ui.setCodePad(null);
      if (ui.container?.id === msg.id) ui.setContainer(null);
      clientWorld.structuresVersion++;
      return;
    }
    case "sState": {
      const idx = clientWorld.world?.structures;
      if (msg.open !== undefined) idx?.setOpen(msg.id, msg.open);
      // hp (damage-tier tint, M7) + locked (code pad prompt, M5) ride the
      // stored record — the index stores wire records verbatim.
      const piece = idx?.pieces.get(msg.id) as WirePiece | undefined;
      if (piece) {
        if (msg.hp !== undefined) piece.hp = msg.hp;
        if (msg.locked !== undefined) piece.locked = msg.locked;
      }
      // A lock set/changed revokes everyone — drop the UX cache entry.
      if (msg.locked === true) clientWorld.unlockedDoors.delete(msg.id);
      // The door we were code-padding swung open: drop the pad either way,
      // but only cache the unlock when the open follows OUR submit — a
      // third-party toggle must not hide the pad for the rest of the session.
      if (msg.open === true && ui.codePad?.id === msg.id && ui.codePad.mode === "try") {
        if (pendingTryId === msg.id) clientWorld.unlockedDoors.add(msg.id);
        ui.setCodePad(null);
      }
      if (msg.open === true && pendingTryId === msg.id) pendingTryId = null;
      clientWorld.structuresVersion++;
      return;
    }
    case "cont": {
      // doc 06 M6 — authoritative crate view: opens the panel on a cOpen
      // reply, refreshes it after every cMove.
      ui.setContainer({ id: msg.id, slots: msg.slots });
      return;
    }
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
  pendingTryId = null; // stale pre-reconnect submits must not earn the cache

  resetPrediction();
  resetInterpolation();
  // Drop stale remote views from before a reconnect drop (resetInterpolation
  // only clears the snapshot buffer) so they don't render for a frame at old
  // positions before the first post-welcome snapshot prunes them. No-op on an
  // initial connect (the maps are already empty).
  clientWorld.players.clear();
  clientWorld.zombies.clear();
  clientWorld.animals.clear();

  // Clamp the server's config BEFORE building the world — NEVER build from (or
  // store) the raw object. A hostile open-source server (doc 02's first-party
  // join path) could send zombieDensity:1e9 (OOM) or dayLengthMin:0 (NaN
  // clock); clampConfig bounds every field. Absent config → DEFAULT_CONFIG
  // (clampConfig's base).
  clientWorld.config = clampConfig(msg.config);
  // doc 07 M2: the world is built from the clamped config (tier-derived
  // size/counts via worldParamsOf). welcome.seed stays for legacy compat and
  // MUST equal config.world.seed — on a disagreement trust the top-level seed
  // (the pre-config source of truth): log + coerce, never throw.
  if (clientWorld.config.world.seed !== msg.seed) {
    console.error(
      `[config] welcome.seed ${msg.seed} != config.world.seed ${clientWorld.config.world.seed}; using welcome.seed`,
    );
    clientWorld.config.world.seed = msg.seed;
  }
  clientWorld.world = createWorld(worldParamsOf(clientWorld.config.world));
  // doc 12 — mirror the server-blessed explored set on fog servers (else null,
  // and the map renders full). createWorld + the map bake both derive from
  // world.size, so the grid's cell indices line up with the snapshot deltas
  // below (both ends compute the fog dim from the same config-derived size).
  clientWorld.explored =
    clientWorld.config.map.reveal === "explored"
      ? decodeExplored(clientWorld.world.size, msg.explored)
      : null;
  // doc 13 M2 — the server's full felled-tree set (per-snap deltas fold in
  // below). Rebuilt from scratch on every welcome: a reconnect must not keep
  // stale indices from a previous world/session.
  clientWorld.felledTrees.clear();
  for (const idx of msg.felled ?? []) clientWorld.felledTrees.add(idx);
  clientWorld.felledVersion++;
  // Tree lifecycle — the server's full planted-tree collection. createWorld
  // above gave us a fresh empty plantedTrees index (the felled/structures
  // precedent), so upsert the welcome set straight in. Prediction collides with
  // these via the shared queryStatics; PlantedTrees renders them on the bump.
  for (const rec of msg.planted ?? []) clientWorld.world.plantedTrees.upsert(rec);
  clientWorld.plantedVersion++;
  // doc 06 — the fresh world's structure index is empty; the sFull batches
  // that follow this welcome on the same socket fill it. Version bump so the
  // renderer drops any stale meshes from a previous session.
  clientWorld.structuresVersion++;
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
  ui.setInventory(msg.inv, msg.selected, msg.worn);
  ui.setVitals(vitalsOf(msg.you));
  ui.setAction(msg.you.action); // doc 11 M2: cast-bar progress (render-only)
  ui.setRealm(msg.you.realm);
  ui.setVehicleSeat(msg.you.seat ?? null); // doc 13 M4 (never seated on welcome)
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

  // doc 12 — fold in any newly-explored cells the server revealed this tick.
  if (msg.fog && clientWorld.explored) setExploredIndices(clientWorld.explored, msg.fog);
  // Tree lifecycle — planted deltas (plant/grow/fell) apply to the SHARED index
  // immediately: a planted change alters COLLISION, not just visuals, so
  // prediction's queryStatics must see it now. The RENDER version bump does
  // NOT happen here — it rides the delayed interp timeline (pushSnap buffered
  // this snap's `planted` flag), so PlantedTrees/Stumps rebuild in lock-step
  // with the treeCut burst and trunk body instead of INTERP_DELAY_MS early.
  if (msg.planted && clientWorld.world) {
    for (const d of msg.planted) {
      if (d.op === "upsert") clientWorld.world.plantedTrees.upsert(d.tree);
      else clientWorld.world.plantedTrees.remove(d.id);
    }
  }
  // doc 13 M2 — felled-tree deltas ride the buffered snap (pushSnap above) and
  // fold in when the interpolation cursor reaches them, so the static tree
  // vanishes on the same delayed timeline the trunk body appears on. Folding
  // here at receipt would blank the tree INTERP_DELAY_MS before the trunk.
  // Realm + portals flow straight in: realm re-themes terrain/sky (store-driven
  // React re-render of the world components), portals feed the per-frame renderer.
  ui.setRealm(msg.you.realm);
  clientWorld.portals = msg.portals;

  ui.setVitals(vitalsOf(msg.you));
  ui.setAction(msg.you.action); // doc 11 M2: cast-bar progress (render-only)
  ui.setVehicleSeat(msg.you.seat ?? null); // doc 13 M4 seat + driver HUD readout
  ui.setPlayerCount(msg.count);
  ui.setClockHours(effectiveGameHour(clientWorld.config.time, msg.time));
  // Destruction FX (break + treeCut) are released from interpolation.ts when
  // their snapshot reaches the render cursor — in lock-step with the body
  // removal / tree vanish. Combat/audio events remain immediate.
  const immediateEvents = msg.events.filter((event) => !isDelayedFxEvent(event));
  if (immediateEvents.length > 0) {
    clientWorld.events.push(...immediateEvents);
    clientWorld.audioEvents.push(...immediateEvents);
  }
}
