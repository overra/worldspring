import type { Tree } from "./world";

export type TreeSpecies = "conifer" | "oak";
export type TreeGrowthStage = "sapling" | "young" | "mature";

/** Persistent/wire identity for a player-planted tree. Geometry is derived. */
export interface PlantedTreeRecord {
  id: number;
  species: TreeSpecies;
  appearanceSeed: number;
  x: number;
  z: number;
  groundY: number;
  plantedAtMs: number;
  stage: TreeGrowthStage;
}

export interface PlantedTree extends PlantedTreeRecord, Tree {
  kind: TreeSpecies;
}

export type PlantedTreeDelta =
  | { op: "upsert"; tree: PlantedTreeRecord }
  | { op: "remove"; id: number };

const GRID_CELL = 16;

/** Wall-clock growth: offline/idle time counts, while the server owns stages. */
export function treeStageAt(plantedAtMs: number, nowMs: number): TreeGrowthStage {
  const ageMs = Math.max(0, nowMs - plantedAtMs);
  if (ageMs < 15 * 60_000) return "sapling";
  if (ageMs < 60 * 60_000) return "young";
  return "mature";
}

/** Stable dimensions from species, stage and appearance seed (no RNG draws). */
export function plantedTreeGeometry(record: PlantedTreeRecord): Pick<Tree, "r" | "height" | "kind"> {
  const unit = ((record.appearanceSeed >>> 8) & 0xffff) / 0xffff;
  const matureHeight = (record.species === "conifer" ? 8.2 : 7.2) * (0.9 + unit * 0.2);
  const matureRadius = record.species === "conifer" ? 0.34 : 0.42;
  const scale = record.stage === "sapling" ? 0.16 : record.stage === "young" ? 0.52 : 1;
  return {
    kind: record.species,
    height: matureHeight * scale,
    // Saplings are intentionally walk-through; the index excludes them from queries.
    r: record.stage === "sapling" ? 0 : matureRadius * (record.stage === "young" ? 0.65 : 1),
  };
}

function materialize(record: PlantedTreeRecord): PlantedTree {
  return { ...record, ...plantedTreeGeometry(record) };
}

export interface PlantedTreeIndex {
  readonly trees: Map<number, PlantedTree>;
  upsert(record: PlantedTreeRecord): PlantedTree;
  remove(id: number): boolean;
  query(x: number, z: number, radius: number): PlantedTree[];
}

/** Mutable, deterministic spatial index shared by server authority and prediction. */
export function createPlantedTreeIndex(): PlantedTreeIndex {
  const trees = new Map<number, PlantedTree>();
  const grid = new Map<string, Set<number>>();
  const keyOf = (x: number, z: number): string => `${Math.floor(x / GRID_CELL)},${Math.floor(z / GRID_CELL)}`;

  const detach = (tree: PlantedTree): void => {
    const cell = grid.get(keyOf(tree.x, tree.z));
    cell?.delete(tree.id);
    if (cell?.size === 0) grid.delete(keyOf(tree.x, tree.z));
  };

  return {
    trees,
    upsert(record) {
      const previous = trees.get(record.id);
      if (previous) detach(previous);
      const tree = materialize(record);
      trees.set(tree.id, tree);
      let cell = grid.get(keyOf(tree.x, tree.z));
      if (!cell) {
        cell = new Set();
        grid.set(keyOf(tree.x, tree.z), cell);
      }
      cell.add(tree.id);
      return tree;
    },
    remove(id) {
      const tree = trees.get(id);
      if (!tree) return false;
      detach(tree);
      return trees.delete(id);
    },
    query(x, z, radius) {
      const out: PlantedTree[] = [];
      const minX = Math.floor((x - radius) / GRID_CELL);
      const maxX = Math.floor((x + radius) / GRID_CELL);
      const minZ = Math.floor((z - radius) / GRID_CELL);
      const maxZ = Math.floor((z + radius) / GRID_CELL);
      for (let ix = minX; ix <= maxX; ix++) {
        for (let iz = minZ; iz <= maxZ; iz++) {
          const cell = grid.get(`${ix},${iz}`);
          if (!cell) continue;
          for (const id of cell) {
            const tree = trees.get(id);
            if (!tree || tree.stage === "sapling") continue;
            if (Math.abs(tree.x - x) <= radius + tree.r && Math.abs(tree.z - z) <= radius + tree.r) out.push(tree);
          }
        }
      }
      return out;
    },
  };
}
