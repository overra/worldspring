// The SSRF-guarded verification/liveness probe (doc 02 §7). Shared with
// apps/prober, so the implementation lives in @worldspring/shared/directory;
// this module is the doc-02-named seam for the web routes.
export {
  probeServerInfo,
  PROBE_MAX_BYTES,
  PROBE_TIMEOUT_MS,
  type ProbeError,
  type ProbeResult,
} from "@worldspring/shared/directory";
