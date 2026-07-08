// Client-measured ping + join-skip rewrite for the browse table (doc 02 §1/§9).
// Plain static JS (served from /public, no bundler) — PROGRESSIVE ENHANCEMENT:
// the SSR table is complete without it, this only fills the Ping column and
// rewrites opted-out Join links. Nothing here blocks render.
//
// Ping fan-out is STRICTLY BOUNDED because every measurement is a billed
// Worker + billed DO request on the TARGET server's Cloudflare account
// (doc 02 §1/§2b/§11): only rows scrolled into view are pinged
// (IntersectionObserver), at most PING_CONCURRENCY in flight, and each server
// is measured at most once per browser session (memoized in sessionStorage).
// Never ping every listed server on load.
(() => {
  "use strict";

  const PING_CONCURRENCY = 6; // ≤6 outbound connections/invocation (doc 02 §6)
  const PING_TIMEOUT_MS = 5000; // matches the server-side probe timeout
  const MEMO_PREFIX = "ws_ping:"; // sessionStorage: one measurement per session
  const SKIP_PREFIX = "ws_join_skip:"; // localStorage: "don't warn me again" (doc 02 §9)

  // --- "Don't warn me again" rewrite (doc 02 §9, folded in from M6) ----------
  // A visitor who checked the box on /join/:id gets that server's Join link
  // rewritten to go straight out. Only ?ref crosses; the opt-in ?name is an
  // interstitial-only choice, never applied here.
  for (const a of document.querySelectorAll("a[data-join-url]")) {
    const serverId = a.getAttribute("data-server-id");
    const joinUrl = a.getAttribute("data-join-url");
    if (!serverId || !joinUrl) continue;
    let skip = null;
    try {
      skip = localStorage.getItem(SKIP_PREFIX + serverId);
    } catch {
      continue; // blocked storage — keep the interstitial route
    }
    if (skip === null) continue;
    a.href = joinUrl + "/?ref=worldspring-directory";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }

  // --- Ping column -----------------------------------------------------------
  const cells = Array.from(document.querySelectorAll("[data-ping-url]"));
  if (cells.length === 0) return;

  const sessionGet = (key) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const sessionSet = (key, value) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // blocked storage — we simply re-measure next session
    }
  };

  const render = (cell, memo) => {
    // memo is "<ms>" on success or "x" on failure ("—", CORS-safe degrade).
    cell.textContent = memo === "x" ? "—" : memo + " ms";
    cell.removeAttribute("data-pending");
  };

  // Fill anything already measured this session immediately (re-navigation).
  const queue = [];
  for (const cell of cells) {
    const id = cell.getAttribute("data-server-id") || cell.getAttribute("data-ping-url");
    const memo = sessionGet(MEMO_PREFIX + id);
    if (memo !== null) {
      render(cell, memo);
    } else {
      queue.push(cell);
    }
  }

  let inFlight = 0;
  const pending = [];

  const measure = async (cell) => {
    const id = cell.getAttribute("data-server-id") || cell.getAttribute("data-ping-url");
    const origin = cell.getAttribute("data-ping-url");
    cell.textContent = "…";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    const start = performance.now();
    let memo = "x";
    try {
      // The game's /api/server-info answers CORS `*` (doc 03 §3), so a simple
      // GET is cross-origin readable — no preflight, no proxy needed. We only
      // need the round-trip time; the body is ignored.
      await fetch(origin + "/api/server-info", {
        method: "GET",
        mode: "cors",
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
      });
      memo = String(Math.round(performance.now() - start));
    } catch {
      // down / DNS / TLS / CORS / timeout — all render "—". The browser ALSO logs
      // its own network/CORS error per failed cross-origin GET; try/catch cannot
      // suppress that (inherent to client-measured ping). It stays bounded: viewport-
      // only, ≤PING_CONCURRENCY in flight, once per server per session.
      memo = "x";
    } finally {
      clearTimeout(timer);
    }
    sessionSet(MEMO_PREFIX + id, memo);
    render(cell, memo);
  };

  const pump = () => {
    while (inFlight < PING_CONCURRENCY && pending.length > 0) {
      const cell = pending.shift();
      inFlight++;
      measure(cell).finally(() => {
        inFlight--;
        pump();
      });
    }
  };

  const enqueue = (cell) => {
    if (cell.getAttribute("data-pending") === "1") return;
    cell.setAttribute("data-pending", "1");
    pending.push(cell);
    pump();
  };

  // Only measure rows actually scrolled into view (doc 02 §1). Fallback: no
  // IntersectionObserver → measure the initial set once (still pool-bounded).
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries, obs) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            obs.unobserve(entry.target);
            enqueue(entry.target);
          }
        }
      },
      { rootMargin: "100px" },
    );
    for (const cell of queue) io.observe(cell);
  } else {
    for (const cell of queue) enqueue(cell);
  }
})();
