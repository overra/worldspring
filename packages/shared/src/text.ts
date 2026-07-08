// Shared untrusted-text sanitization (doc 02 §7 M1 hoist). Dependency-free by
// design: apps/web and apps/prober import the one true regex from here instead
// of copy-syncing it out of the game's server tree (which drags game-state
// types). apps/game re-exports STRIP_TEXT_RE from systems/players.ts for its
// existing call sites — a pure move, zero behavior change.

/**
 * Characters stripped from all player/operator-supplied text (names, chat,
 * server names, MOTDs): C0 controls, DEL + C1 controls, zero-width chars
 * (ZWSP/ZWNJ/ZWJ U+200B-D, word joiner + invisible operators U+2060-2064),
 * bidi controls (LRM/RLM, embeddings/overrides U+202A-E, isolates
 * U+2066-2069), and BOM U+FEFF. Zero-width chars defeat empty-string guards
 * (\s does not match U+200B); bidi overrides visually reverse rendered text in
 * recipients' clients. Deliberately does NOT escape < > & or quotes —
 * render-as-text is the consumer's job (doc 03 §10 rule 8).
 */
export const STRIP_TEXT_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** Directory-side listing caps (doc 02 §7) — deliberately looser than the
 * game's MAX_SERVER_NAME_LENGTH (a community server on an older build may
 * legally send up to these). Code points, not UTF-16 units. */
export const SERVER_NAME_MAX = 48;
export const SERVER_MOTD_MAX = 140;

/**
 * The directory's sanitizer (doc 02 §7): NFC-normalize, replace stripped chars
 * with spaces, collapse whitespace, trim, cap by CODE POINTS. Applied on EVERY
 * write path (registration, heartbeat, probe refresh) — sender-side
 * sanitization is never trusted (doc 03 §9). Empty-after-sanitize server names
 * fall back to the URL's hostname (caller's job).
 */
export function sanitizeListingText(raw: string, maxCodePoints: number): string {
  return [...raw.normalize("NFC").replace(STRIP_TEXT_RE, " ").replace(/\s+/g, " ").trim()]
    .slice(0, maxCodePoints)
    .join("")
    .trim();
}
