// UI-facing state. Updated at low frequency (snapshots / discrete events),
// safe for React subscriptions. High-frequency data lives in runtime.ts.

import { create } from "zustand";
import { INVENTORY_SLOTS } from "@worldspring/shared/constants";
import type { ItemStack } from "@worldspring/shared/items";
import type { DeathRecap, Vitals, YouState } from "@worldspring/shared/protocol";

// "reconnecting": the in-game socket dropped (e.g. the server DO instance was
// replaced under load, or a deploy/network blip) and we're auto-reconnecting
// with the persisted token — the last frame stays frozen under an overlay
// until the new welcome, distinct from a real disconnect that returns to menu.
export type GamePhase = "menu" | "connecting" | "playing" | "dead" | "reconnecting";

export interface Notice {
  id: number;
  msg: string;
  ts: number;
}

export interface ChatLine {
  id: number;
  name: string;
  text: string;
  /** performance.now() at receipt — drives the panel's fade-out. */
  at: number;
}

/** Rolling chat log cap — oldest lines drop past this. */
const CHAT_LOG_MAX = 50;

export interface UIState {
  phase: GamePhase;
  error: string | null;
  playerName: string;
  vitals: Vitals;
  /** In-progress channeled action for the cast bar (doc 11 M2); null = no cast.
   * Render-only, set from each snapshot's `you.action` (server-authoritative). */
  channelAction: YouState["action"] | null;
  inventory: (ItemStack | null)[];
  selectedSlot: number;
  /** Human-readable pickup prompt, e.g. "Canned Beans" — null hides it. */
  prompt: string | null;
  notices: Notice[];
  deathCause: string | null;
  /** Stats of the life that just ended: set with the death message, and on
   * welcome when the character died while offline (shown as a recap toast). */
  recap: DeathRecap | null;
  playerCount: number;
  /** Hour of day [0,24) at snapshot rate — for the HUD clock only. */
  clockHours: number;
  pingMs: number;
  invOpen: boolean;
  /** Full-screen map (doc 12). Gates gameplay input like invOpen. */
  mapOpen: boolean;
  /** Escape menu (resume/settings/leave). Gates gameplay input like invOpen. */
  menuOpen: boolean;
  /** Proximity-chat input row open. Gates gameplay input like invOpen. */
  chatOpen: boolean;
  /** Rolling proximity-chat log, newest last, capped at CHAT_LOG_MAX. */
  chatLog: ChatLine[];

  setPhase(phase: GamePhase): void;
  setError(error: string | null): void;
  setPlayerName(name: string): void;
  setVitals(vitals: Vitals): void;
  setAction(action: YouState["action"] | undefined): void;
  setInventory(slots: (ItemStack | null)[], selected: number): void;
  setSelectedSlot(slot: number): void;
  setPrompt(prompt: string | null): void;
  pushNotice(msg: string): void;
  setDeathCause(cause: string | null): void;
  setRecap(recap: DeathRecap | null): void;
  setPlayerCount(count: number): void;
  setClockHours(hours: number): void;
  setPingMs(ms: number): void;
  setInvOpen(open: boolean): void;
  setMapOpen(open: boolean): void;
  setMenuOpen(open: boolean): void;
  openChat(): void;
  closeChat(): void;
  pushChat(name: string, text: string): void;
  /** Wipe the log (disconnect/rejoin — a new identity must not see old lines). */
  clearChatLog(): void;
}

let noticeId = 0;
let chatLineId = 0;

export const useUIStore = create<UIState>((set) => ({
  phase: "menu",
  error: null,
  playerName: "",
  vitals: { hp: 100, food: 100, water: 100, temp: 37 },
  channelAction: null,
  inventory: Array.from({ length: INVENTORY_SLOTS }, () => null),
  selectedSlot: 0,
  prompt: null,
  notices: [],
  deathCause: null,
  recap: null,
  playerCount: 0,
  clockHours: 9,
  pingMs: 0,
  invOpen: false,
  mapOpen: false,
  menuOpen: false,
  chatOpen: false,
  chatLog: [],

  setPhase: (phase) => set({ phase }),
  setError: (error) => set({ error }),
  setPlayerName: (playerName) => set({ playerName }),
  setVitals: (vitals) => set({ vitals }),
  // Normalize the optional wire field to null. Hold the reference steady while
  // not channeling so the cast-bar subscription doesn't re-render every snap.
  setAction: (action) =>
    set((s) => {
      const next = action ?? null;
      return next === null && s.channelAction === null ? s : { channelAction: next };
    }),
  setInventory: (inventory, selectedSlot) => set({ inventory, selectedSlot }),
  setSelectedSlot: (selectedSlot) => set({ selectedSlot }),
  setPrompt: (prompt) =>
    set((s) => (s.prompt === prompt ? s : { prompt })),
  pushNotice: (msg) =>
    set((s) => ({
      notices: [...s.notices.slice(-5), { id: noticeId++, msg, ts: Date.now() }],
    })),
  setDeathCause: (deathCause) => set({ deathCause }),
  setRecap: (recap) => set({ recap }),
  setPlayerCount: (playerCount) => set({ playerCount }),
  setClockHours: (clockHours) => set({ clockHours }),
  setPingMs: (pingMs) => set({ pingMs }),
  setInvOpen: (invOpen) => set({ invOpen }),
  setMapOpen: (mapOpen) => set({ mapOpen }),
  setMenuOpen: (menuOpen) => set({ menuOpen }),
  openChat: () => set((s) => (s.chatOpen ? s : { chatOpen: true })),
  clearChatLog: () => set((s) => (s.chatLog.length === 0 ? s : { chatLog: [] })),
  closeChat: () => set((s) => (s.chatOpen ? { chatOpen: false } : s)),
  pushChat: (name, text) =>
    set((s) => ({
      chatLog: [
        ...s.chatLog.slice(-(CHAT_LOG_MAX - 1)),
        { id: chatLineId++, name, text, at: performance.now() },
      ],
    })),
}));
