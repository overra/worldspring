// D1 access shared by the /api/v1 routes and the SSR pages. The pure logic
// (token format, URL rules, probe client, ranking) lives in
// @worldspring/shared/directory where vitest covers it; this module is only
// the web-specific SQL and request plumbing.

import { env } from "cloudflare:workers";
import { sha256Hex } from "@worldspring/shared/directory";

/** wrangler-generated Env plus the optional secrets doc 02 §Deployment lists
 * (REPORT_SALT salts ip hashes; unset in local dev → hashes are unsalted but
 * still never store raw IPs). */
export interface DirectoryEnv {
  DB: D1Database;
  REPORT_SALT?: string;
}

export function directoryEnv(): DirectoryEnv {
  return env as unknown as DirectoryEnv;
}

/** The `servers` columns the API routes read (migration 0002). */
export interface ServerAuthRow {
  id: string;
  url: string;
  token_hash: string;
  challenge_hash: string;
  token_hash_next: string | null;
  challenge_hash_next: string | null;
  status: "pending" | "live" | "unreachable" | "hidden" | "banned";
  last_heartbeat_sent_at: number | null;
  hb_bucket_tokens: number;
  hb_bucket_at: number;
}

export function getServerAuthRow(db: D1Database, id: string): Promise<ServerAuthRow | null> {
  return db
    .prepare(
      `SELECT id, url, token_hash, challenge_hash, token_hash_next, challenge_hash_next,
              status, last_heartbeat_sent_at, hb_bucket_tokens, hb_bucket_at
       FROM servers WHERE id = ?`,
    )
    .bind(id)
    .first<ServerAuthRow>();
}

/** sha256(ip + daily-rotating salt) — the doc 02 §7 recipe: no raw IPs at
 * rest, and yesterday's hashes are useless for correlation today. */
export function hashIp(request: Request, salt: string | undefined): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const day = new Date().toISOString().slice(0, 10);
  return sha256Hex(`${salt ?? ""}:${day}:${ip}`);
}

/**
 * The doc 02 §3 `attempts` ledger: EVERY attempt (accepted or rejected)
 * inserts a row; the handler counts the 1 h window FIRST. Returns true when
 * the caller is over `limit` and must 429.
 */
export async function attemptAndCheckLimit(
  db: D1Database,
  ipHash: string,
  route: "register" | "verify",
  limit: number,
  now: number,
): Promise<boolean> {
  const windowStart = now - 3_600_000;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM attempts WHERE ip_hash = ? AND route = ? AND at > ?")
    .bind(ipHash, route, windowStart)
    .first<{ n: number }>();
  await db
    .prepare("INSERT INTO attempts (ip_hash, route, at) VALUES (?, ?, ?)")
    .bind(ipHash, route, now)
    .run();
  return Number(row?.n ?? 0) >= limit;
}

const JSON_HEADERS = {
  "content-type": "application/json",
  // All /api/v1/* responses are CORS-open (doc 02 §4) — latency is
  // client-measured by design.
  "access-control-allow-origin": "*",
};

export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

export function emptyResponse(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, {
    status,
    headers: { "access-control-allow-origin": "*", ...extra },
  });
}

/** Read a JSON body under a byte cap (doc 02 §4: 4 KB default; doc 03 §9:
 * 8 KB for heartbeats specifically). Returns undefined on oversize/bad JSON. */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return undefined;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return undefined;
  }
  if (text.length > maxBytes) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
