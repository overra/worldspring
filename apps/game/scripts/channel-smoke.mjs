#!/usr/bin/env node
// Channeled-action smoke probe (doc 11 M1) — drives a real GameRoom over WS and
// proves {t:"use"} is now an interruptible cast, not an instant apply. M1 has no
// wire field for cast progress (that's M2), so we observe the *completion* (the
// bandage leaving the inventory) and its timing/absence.
//
//   node --experimental-strip-types apps/game/scripts/channel-smoke.mjs [ws-url]
//   default url: ws://localhost:5173/ws
//
// New players spawn with a flashlight (slot 0, equipped) + a bandage (slot 1).
// Test A: use the bandage from slot 1 WITHOUT equipping it (the inventory-panel
//   path msg.slot != selectedSlot) — it must COMPLETE after ~USE_CHANNEL_S, which
//   proves (1) use is a cast not instant, and (2) the slot-swap rule no longer
//   self-cancels a non-equipped-slot use.
// Test B: use the bandage, then send a movement input — the cast must CANCEL
//   (bandage never consumed).
import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "@worldspring/shared/protocol";
import { USE_CHANNEL_S } from "@worldspring/shared/constants";

const WS_URL = process.argv[2] ?? "ws://localhost:5173/ws";
if (typeof WebSocket === "undefined") {
  console.error("channel-smoke: global WebSocket missing — Node 22+ required");
  process.exit(2);
}

const bandageSlotOf = (slots) => slots.findIndex((s) => s && s.type === "bandage");
const join = (name) => ({ t: "join", name, token: randomBytes(16).toString("hex"), proto: PROTOCOL_VERSION });

// The spawn inventory rides in welcome.inv (+ welcome.selected); the standalone
// {t:"inv"} message is sent only when the inventory CHANGES — i.e. on completion.

/** Test A: a non-equipped-slot use must complete after ~USE_CHANNEL_S. */
function testCompletes() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let usedAt = 0, srcSlot = -1, selected = 0, used = false;
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ outcome: "timeout-no-consume" }); }, 6000);
    ws.addEventListener("open", () => ws.send(JSON.stringify(join("smokeA"))));
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === "welcome" && !used) {
        used = true; srcSlot = bandageSlotOf(m.inv); selected = m.selected; usedAt = Date.now();
        ws.send(JSON.stringify({ t: "use", slot: srcSlot })); // use the bandage slot; equipped stays welcome.selected
      } else if (m.t === "inv" && bandageSlotOf(m.slots) === -1) {
        clearTimeout(timer); try { ws.close(); } catch {}
        resolve({ outcome: "consumed", afterS: (Date.now() - usedAt) / 1000, srcSlot, selected });
      }
    });
  });
}

/** Test B: a movement input mid-cast cancels it (bandage never consumed). */
function testCancelsOnMove() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    let used = false;
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ outcome: "not-consumed" }); }, 3000);
    ws.addEventListener("open", () => ws.send(JSON.stringify(join("smokeB"))));
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === "welcome" && !used) {
        used = true;
        ws.send(JSON.stringify({ t: "use", slot: bandageSlotOf(m.inv) }));
        setTimeout(() => {
          const cmds = [0, 1, 2].map((i) => ({ seq: i + 1, dt: 0.05, mx: 0, mz: -1, yaw: 0, pitch: 0, sprint: false, jump: false }));
          ws.send(JSON.stringify({ t: "input", cmds }));
        }, 200);
      } else if (m.t === "inv" && bandageSlotOf(m.slots) === -1) {
        clearTimeout(timer); try { ws.close(); } catch {}
        resolve({ outcome: "consumed-cancel-FAILED" });
      }
    });
  });
}

async function main() {
  console.log(`channel-smoke: ${WS_URL} | proto ${PROTOCOL_VERSION} | USE_CHANNEL_S=${USE_CHANNEL_S}\n`);
  let failed = false;

  const a = await testCompletes();
  const aOk =
    a.outcome === "consumed" && a.srcSlot !== a.selected && a.afterS > 0.8 && a.afterS < 2.0;
  if (!aOk) failed = true;
  console.log(
    `  ${aOk ? "PASS" : "FAIL"}  use-is-a-cast + non-equipped-slot completes  ->  ` +
      (a.outcome === "consumed"
        ? `consumed ${a.afterS.toFixed(2)}s after use (src slot ${a.srcSlot}, equipped ${a.selected})`
        : a.outcome),
  );

  const b = await testCancelsOnMove();
  const bOk = b.outcome === "not-consumed";
  if (!bOk) failed = true;
  console.log(`  ${bOk ? "PASS" : "FAIL"}  cancel-on-move (bandage NOT consumed)        ->  ${b.outcome}`);

  console.log(`\nCHANNEL-SMOKE: ${failed ? "FAIL" : "PASS"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("channel-smoke: fatal", e); process.exit(1); });
