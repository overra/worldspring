// Directory-side sanitization (doc 02 §7). STRIP_TEXT_RE and the sanitizer
// were hoisted to @worldspring/shared/text (M1) — the site imports the one
// true regex instead of keeping a copy-sync hazard. Applied on EVERY write
// path (registration, heartbeat, probe refresh); sender-side sanitization is
// never trusted (doc 03 §9). Rendering stays Astro auto-escaped text.
export {
  sanitizeListingText,
  SERVER_MOTD_MAX,
  SERVER_NAME_MAX,
  STRIP_TEXT_RE,
} from "@worldspring/shared/text";

import { sanitizeListingText, SERVER_NAME_MAX } from "@worldspring/shared/text";

/** Empty-after-sanitize server names fall back to the URL's hostname (doc 02 §7). */
export function listingNameOf(rawName: string, url: string): string {
  const cleaned = sanitizeListingText(rawName, SERVER_NAME_MAX);
  if (cleaned !== "") return cleaned;
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}
