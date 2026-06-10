// UI-facing state. Updated at low frequency (snapshots / discrete events),
// safe for React subscriptions. High-frequency data lives in runtime.ts.

import { create } from "zustand";
import { INVENTORY_SLOTS } from "@/shared/constants";
import type { ItemStack } from "@/shared/items";
import type { Vitals } from "@/shared/protocol";

export type GamePhase = "menu" | "connecting" | "playing" | "dead";

export interface Notice {
  id: number;
  msg: string;
  ts: number;
}

export interface UIState {
  phase: GamePhase;
  error: string | null;
  playerName: string;
  vitals: Vitals;
  inventory: (ItemStack | null)[];
  selectedSlot: number;
  /** Human-readable pickup prompt, e.g. "Canned Beans" — null hides it. */
  prompt: string | null;
  notices: Notice[];
  deathCause: string | null;
  playerCount: number;
  /** Hour of day [0,24) at snapshot rate — for the HUD clock only. */
  clockHours: number;
  pingMs: number;
  invOpen: boolean;
  /** Escape menu (resume/settings/leave). Gates gameplay input like invOpen. */
  menuOpen: boolean;

  setPhase(phase: GamePhase): void;
  setError(error: string | null): void;
  setPlayerName(name: string): void;
  setVitals(vitals: Vitals): void;
  setInventory(slots: (ItemStack | null)[], selected: number): void;
  setSelectedSlot(slot: number): void;
  setPrompt(prompt: string | null): void;
  pushNotice(msg: string): void;
  setDeathCause(cause: string | null): void;
  setPlayerCount(count: number): void;
  setClockHours(hours: number): void;
  setPingMs(ms: number): void;
  setInvOpen(open: boolean): void;
  setMenuOpen(open: boolean): void;
}

let noticeId = 0;

export const useUIStore = create<UIState>((set) => ({
  phase: "menu",
  error: null,
  playerName: "",
  vitals: { hp: 100, food: 100, water: 100, temp: 37 },
  inventory: Array.from({ length: INVENTORY_SLOTS }, () => null),
  selectedSlot: 0,
  prompt: null,
  notices: [],
  deathCause: null,
  playerCount: 0,
  clockHours: 9,
  pingMs: 0,
  invOpen: false,
  menuOpen: false,

  setPhase: (phase) => set({ phase }),
  setError: (error) => set({ error }),
  setPlayerName: (playerName) => set({ playerName }),
  setVitals: (vitals) => set({ vitals }),
  setInventory: (inventory, selectedSlot) => set({ inventory, selectedSlot }),
  setSelectedSlot: (selectedSlot) => set({ selectedSlot }),
  setPrompt: (prompt) =>
    set((s) => (s.prompt === prompt ? s : { prompt })),
  pushNotice: (msg) =>
    set((s) => ({
      notices: [...s.notices.slice(-5), { id: noticeId++, msg, ts: Date.now() }],
    })),
  setDeathCause: (deathCause) => set({ deathCause }),
  setPlayerCount: (playerCount) => set({ playerCount }),
  setClockHours: (clockHours) => set({ clockHours }),
  setPingMs: (pingMs) => set({ pingMs }),
  setInvOpen: (invOpen) => set({ invOpen }),
  setMenuOpen: (menuOpen) => set({ menuOpen }),
}));
