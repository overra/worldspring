// Ranking (doc 02 §8, binding formula — vitest-covered in
// @worldspring/shared/directory). No votes, no paid placement, no
// raw-player-count default sort; ping is client-side only and never enters
// the stored score. Timestamps are epoch MILLISECONDS (the age term divides
// by 86400_000).
export { score, type ScorableServerRow } from "@worldspring/shared/directory";
