// Human-readable build label for the game. See
// docs/plans/03-server-info-contract.md §1 (the three version axes).

/**
 * Display-only semver build label, surfaced in ServerInfo.gameVersion. NEVER
 * gate on it — joinability is decided exclusively by PROTOCOL_VERSION
 * (protocol.ts). Hand-maintained one-liner; bump it every release. May drift
 * from package.json `version`; that drift is cosmetic by design.
 */
export const GAME_VERSION = "0.1.0";
