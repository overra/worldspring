// POST /api/v1/servers/:id/report — file a report (doc 02 §4/§7, M7). No
// auth, CORS-open JSON like all /api/v1/*, body cap 4 KB. Rate-limited
// 5/day/ip_hash; duplicates per (ip_hash, server) collapse to the SAME
// success response — never reveal deduped-vs-stored. Reports never auto-hide;
// ≥3 unique reporters just sets flagged=1 for human review (lib/reports.ts).
import type { APIRoute } from "astro";
import { parseReportBody } from "@worldspring/shared/directory";
import { directoryEnv, emptyResponse, hashIp, jsonResponse, readJsonBody } from "../../../../../lib/db";
import { fileReport } from "../../../../../lib/reports";

export const prerender = false;

const BODY_MAX_BYTES = 4 * 1024; // doc 02 §4 general cap

export const POST: APIRoute = async ({ request, params }) => {
  const { DB, REPORT_SALT } = directoryEnv();
  const now = Date.now();

  const raw = await readJsonBody(request, BODY_MAX_BYTES);
  const body = parseReportBody(raw);
  if (!body) return jsonResponse({ error: "bad-body" }, 400);

  const ipHash = await hashIp(request, REPORT_SALT);
  const outcome = await fileReport(DB, params.id ?? "", body, ipHash, now);

  if (outcome === "not-found") return jsonResponse({ error: "not-found" }, 404);
  if (outcome === "rate-limited") return emptyResponse(429, { "retry-after": "86400" });
  return jsonResponse({ ok: true }, 200);
};
