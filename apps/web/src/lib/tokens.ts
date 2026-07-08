// Server-token mint/parse (doc 02 §2). The implementation lives in
// @worldspring/shared/directory so vitest covers the format and BOTH mint-time
// hashes (token_hash = sha256(secretHex); challenge_hash = sha256(prefix +
// full token), underivable later). This module is the doc-02-named seam.
export {
  challengeHashOfToken,
  mintServerToken,
  parseServerToken,
  sha256Hex,
  type MintedServerToken,
  type ParsedServerToken,
} from "@worldspring/shared/directory";
