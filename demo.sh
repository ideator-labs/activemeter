#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"

mode_flag=""
if [[ "${1:-}" == "--break" ]]; then
  mode_flag="--wall-as-cpu"
  echo "BREAK MODE: bill wall-clock in-flight time as if it were CPU time (the naive reading of Duration)."
fi

report="$(mktemp -t activemeter.XXXXXX.json)"
node activemeter.mjs --mix examples/mix.json --seconds 3 --out "$report" $mode_flag -- node examples/app.mjs || { echo "RESULT: FAIL (activemeter exited nonzero)"; exit 1; }
echo "report: $report"
echo

REPORT="$report" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { eventCost, webCost } from "./price.mjs";
const r = JSON.parse(readFileSync(process.env.REPORT, "utf8"));
const p = r.prices;
const route = (path) => r.routes.find((x) => x.path === path);
const near = (got, want, tol) => Math.abs(got - want) <= want * tol;
let failed = 0, n = 0;
function check(ok, label, detail) {
  n++;
  console.log(`${ok ? "PASS" : "FAIL"} ${n}. ${label} (${detail})`);
  if (!ok) failed++;
}

const ex1 = webCost(p, { requestsPerMonth: 15e6, cpuMs: 40, consumedGb: 0.49, environments: 1 });
const ex2 = webCost(p, { requestsPerMonth: 10e6, cpuMs: 50, consumedGb: 0.29, environments: 1 });
const ex3 = eventCost(p, { requestsPerMonth: 10e6, inFlightMs: 2000, memoryGb: 1 });
check(ex1.total === 25.78 && ex2.total === 19.61 && ex3.compute === 333.34,
  "price model reproduces the AWS pricing page examples",
  `web SSR $${ex1.total.toFixed(2)} want $25.78, web API $${ex2.total.toFixed(2)} want $19.61, event compute $${ex3.compute.toFixed(2)} want $333.34`);

const render = route("/render"), mixed = route("/mixed"), db = route("/db");
check(near(render.cpuMsForBilling, 20, 0.15), "/render bills ~20 ms CPU per request (handler burns exactly 20 ms CPU)", `${render.cpuMsForBilling.toFixed(2)} ms`);
check(near(mixed.cpuMsForBilling, 15, 0.2), "/mixed bills ~15 ms CPU, not its 60 ms DB wait", `${mixed.cpuMsForBilling.toFixed(2)} ms of ${mixed.inFlightMs.toFixed(1)} ms in flight`);
check(db.activeShare < 0.05, "/db active CPU share is under 5% of in-flight time", `${(db.activeShare * 100).toFixed(1)}%`);
check(render.activeShare > 0.8, "/render active CPU share is over 80%", `${(render.activeShare * 100).toFixed(1)}%`);
check(db.cheaper === "web", "I/O-bound /db is cheaper on Web Functions", `event $${db.event.total.toFixed(2)} vs web $${db.web.total.toFixed(2)} per month`);
check(render.cheaper === "event", "CPU-bound /render is cheaper on Event Functions", `event $${render.event.total.toFixed(2)} vs web $${render.web.total.toFixed(2)} per month`);
check(r.routes.length === 3 && r.routes.every((x) => x.requests >= 50),
  "report measured 3 routes with >= 50 requests each",
  `method=${r.method}, requests=${r.routes.map((x) => x.requests).join("/")}`);

console.log();
console.log(failed ? `RESULT: FAIL (${n - failed} passed, ${failed} failed)` : `RESULT: PASS (${n}/${n})`);
process.exit(failed ? 1 : 0);
'
