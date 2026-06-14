// doc 12 M5/M6 — the fog-of-war grid: index scheme, disk marking + delta
// tracking, base64 round-trip, defensive decode, and (the load-bearing wire
// invariant) that a server delta applied on a fresh client grid reproduces the
// server's bits byte-identically.

import { describe, expect, it } from "vitest";

import {
  createExploredGrid,
  decodeExplored,
  encodeExplored,
  exploredCellAt,
  FOG_CELL_M,
  hasExploredAt,
  markExploredDisk,
  setExploredIndices,
} from "./fog";

describe("ExploredGrid", () => {
  it("sizes the grid by FOG_CELL_M over the world extent", () => {
    const g = createExploredGrid(800);
    expect(g.dim).toBe(Math.ceil(800 / FOG_CELL_M)); // 25
    expect(g.bits.length).toBe(Math.ceil((25 * 25) / 8)); // 79
  });

  it("maps the origin inside the grid and OOB points to -1", () => {
    const g = createExploredGrid(800);
    expect(exploredCellAt(g, 0, 0)).toBeGreaterThanOrEqual(0);
    expect(exploredCellAt(g, 9999, 0)).toBe(-1);
    expect(exploredCellAt(g, 0, -9999)).toBe(-1);
  });

  it("marks a contiguous disk and returns ONLY newly-lit cells", () => {
    const g = createExploredGrid(800);
    const first = markExploredDisk(g, 0, 0, 96);
    expect(first.length).toBeGreaterThan(0);
    expect(hasExploredAt(g, 0, 0)).toBe(true);
    // re-stamping the same spot reveals nothing new (delta is empty)
    expect(markExploredDisk(g, 0, 0, 96)).toEqual([]);
    // a far corner stays unexplored
    expect(hasExploredAt(g, 350, 350)).toBe(false);
  });

  it("round-trips through base64 byte-identically", () => {
    const g = createExploredGrid(800);
    markExploredDisk(g, 100, -50, 96);
    markExploredDisk(g, -200, 150, 96);
    const restored = decodeExplored(800, encodeExplored(g));
    expect(Array.from(restored.bits)).toEqual(Array.from(g.bits));
  });

  it("defensively decodes a wrong-length / absent blob to all-unexplored", () => {
    expect(decodeExplored(800, "AAAA").bits.every((b) => b === 0)).toBe(true);
    expect(decodeExplored(800, undefined).bits.every((b) => b === 0)).toBe(true);
  });

  it("a server delta applied to a fresh client grid reproduces the server bits", () => {
    const server = createExploredGrid(800);
    const delta = markExploredDisk(server, 40, -120, 96);
    const client = createExploredGrid(800);
    setExploredIndices(client, delta);
    expect(Array.from(client.bits)).toEqual(Array.from(server.bits));
  });
});
