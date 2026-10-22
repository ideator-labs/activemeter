# AGENTS.md

Handoff for a coding agent with no prior context.

## What this is

`activemeter` is a CLI that measures the active CPU share of each route of a Node HTTP server, then prices each route under AWS Lambda Event Functions and Lambda Web Functions.

The claim: CPU time per request can be measured locally from process accounting, it differs from wall-clock time by about 10x (/mixed) to nearly 500x (/db) on the bundled example, and that difference flips which Lambda form factor is cheaper. A tool that reads wall-clock duration as cost gets the I/O-bound answer wrong.

Who it is for: teams with an Express, Hono or Fastify server deciding whether to move from Event Functions (or a container) to Web Functions, which bill active CPU. The same measurement applies to Vercel Fluid compute and Cloudflare Workers, which also bill CPU time, but only AWS rates are wired in.

## Status

Real:
- Server process CPU from `/proc/<pid>/stat` (utime + stime, 10 ms ticks), minus an idle baseline measured for 1 s before each route.
- Peak RSS from `/proc/<pid>/status` (`VmHWM`), used as Web Functions "consumed memory".
- Per-request in-flight time measured by the client (`fetch`, Node 20 built-in).
- Rates in `prices.json`, copied from https://aws.amazon.com/lambda/pricing/ on 2026-10-22 (us-east-1). Check 1 proves the formula reproduces three worked examples on that page to the cent.

Stubbed or assumed:
- The example server's DB is a timer (`fakeDb` in `examples/app.mjs`, labelled STUB). Its CPU routes call `burnCpu(ms)`, which spins until `process.cpuUsage()` advances by `ms`, so the expected CPU per request is known.
- Environment count for Web Functions is a model (see Design decisions). It is not observed from Lambda.
- Local in-flight time stands in for Lambda duration. Real Event Functions get CPU proportional to configured memory, so a CPU-bound route runs slower there than on this box.
- Free tier, data transfer, CloudFront and provisioned settings are ignored.

Measured on this box (Node 20.19.2, 8 vCPU Xeon), `bash demo.sh`, 3 s per route:

| route | conc | in-flight ms | CPU ms/req | active share | Event $/mo | Web $/mo |
| --- | --- | --- | --- | --- | --- | --- |
| /db | 16 | 122.0 | 0.25 | 0.2% | 22.33 | 3.67 |
| /render | 1 | 21.0 | 20.42 | 97.3% | 5.50 | 9.26 |
| /mixed | 8 | 145.9 | 15.05 | 10.3% | 26.32 | 7.77 |

`bash demo.sh --break` bills in-flight time as CPU. /mixed then bills 137 ms, /db shows 100% active share, and /db flips to "event" ($22.34 vs $37.40). Checks 3, 4 and 6 fail and the script exits 1.

## Data shape

Input mix file (`examples/mix.json`):

```json
{ "requestsPerMonth": 10000000, "eventMemoryMb": 1024,
  "routes": [ { "path": "/db", "concurrency": 16 } ] }
```

Output report (`--out report.json`), one object per route:

```json
{ "path": "/db", "concurrency": 16, "requests": 400, "wallMs": 3050.1,
  "inFlightMs": 122.0, "cpuMsPerRequest": 0.25, "cpuMsForBilling": 0.25,
  "activeShare": 0.002, "environments": 1,
  "event": { "compute": 20.33, "requests": 2, "total": 22.33 },
  "web": { "cpu": 0.07, "memory": 0.6, "requests": 3, "total": 3.67 },
  "cheaper": "web" }
```

Top level also has `method` (`proc-cpu` or `wall-as-cpu`), `node`, `peakRssMb`, `requestsPerMonth`, `eventMemoryMb`, and the full `prices` object with its source URL and check date.

## Repo map

- `activemeter.mjs` owns the CLI: spawn server, drive routes, read `/proc`, build and print the report.
- `price.mjs` holds the three pure pricing functions (`eventCost`, `webCost`, `webEnvironments`).
- `prices.json` holds the rates, their source URL and the date they were checked.
- `examples/app.mjs` is the example server with an I/O route, a CPU route and a mixed route.
- `examples/mix.json` is the route mix the demo uses.
- `demo.sh` runs the tool on the example and asserts 8 checks. `--break` switches to wall-clock billing.

## Setup, run, verify (fresh clone)

Needs Linux (for `/proc`), Node 20 or newer, bash. No `npm install`.

```bash
git clone https://github.com/ideator-labs/activemeter && cd activemeter
node --version                 # v20 or newer
bash demo.sh                   # expect "RESULT: PASS (8/8)", exit 0, about 20 s
bash demo.sh --break; echo $?  # expect "RESULT: FAIL (5 passed, 3 failed)" and 1
bash demo.sh                   # passes again
```

Use it on your own server: write a mix file with your routes, then run
`node activemeter.mjs --mix my-mix.json --out report.json -- node server.js`.
The server must listen on `AWS_LAMBDA_HTTP_ENDPOINT` (host:port), as Web Functions require.

## Design decisions

- Measure the server process from outside via `/proc`, not by injecting code. No preload, no framework hook, and the load generator's CPU is never counted. Cost: Linux only, 10 ms tick resolution, so each route runs for 3 s.
- Routes run one at a time. CPU is a process-wide counter, so per-route attribution needs isolation. Mixed-traffic attribution is a next step.
- The idle baseline is subtracted so GC and timer noise between requests is not charged to the route.
- Web Functions memory follows the AWS pricing examples: consumed memory times environment lifetime, one month per environment. Environments = max(1, in-flight load / 64, CPU load / 0.7). 64 is the default `maxConcurrencyPerEnvironment` per https://creuto.com/aws-lambda-web-functions-billing-concurrency . 0.7 is a guessed target event loop utilization for one Node thread.
- Line items round up to the cent before summing. That is the only rounding that reproduces all three AWS page examples.
- Plain ESM JavaScript, zero dependencies. Node 20 cannot run TypeScript without a build step, and the tool should run with nothing but `node`.

## Known limits

- Linux only. macOS needs `ps -o cputime` or `proc_pidinfo`, which is coarser.
- Child processes of the server are not counted (only the server pid).
- Concurrency queueing on this box is not Lambda's. On a 2-vCPU Web Functions environment, a CPU-bound route at high concurrency will queue differently.
- Event Functions CPU scales with memory. A 1024 MB function gets less than one vCPU, so CPU-bound routes take longer there than measured here. The model uses local in-flight time.
- Environment count is a steady-traffic model. Bursty traffic with long idle gaps makes Web Functions memory cheaper (scale to zero) or dearer (more warm envs) than modelled.
- Rates are a snapshot for us-east-1. Arm vs x86 Event rates differ; `prices.json` uses the x86 first-tier rate from the page's Event Functions example.

## Next steps (in priority order)

1. Replay a real access log instead of a synthetic mix. Done when `--replay access.log` drives requests at their recorded paths and inter-arrival times and the report lists each path seen.
2. Model bursty traffic. Done when the report takes an hourly request histogram and the Web Functions memory line drops to zero for hours with no traffic, covered by a unit check in `demo.sh`.
3. Add Vercel Fluid compute and Cloudflare Workers price tables with source URLs. Done when `--platform vercel|cloudflare|lambda` selects a table and a demo check reproduces one worked example from each vendor's pricing page.
4. Event Functions CPU scaling. Done when `--event-memory-mb 512` raises the modelled in-flight time of a CPU-bound route (vCPU share = memory / 1769 MB, per AWS docs; verify the constant before using it).
5. GitHub Action that comments the cost table on a PR. Done when a workflow in `.github/workflows` runs `demo.sh` and posts the table as a job summary.
6. macOS support. Done when `bash demo.sh` passes on macOS.

## Working rules

- `bash demo.sh` is the source of truth. Every change keeps it at 8/8 and keeps `--break` failing.
- Every rate in `prices.json` carries a source URL and a check date. Never type in a price you did not read on a vendor page.
- Keep zero runtime dependencies.
- Short sentences in docs, no em-dashes, honest limits.
- Commit as `danielgerlag <daniel@gerlag.ca>`.

## Context and sources

- Lambda Web Functions launch, Oct 12, 2026: https://aws.amazon.com/blogs/aws/announcing-aws-lambda-web-functions-for-fast-consistent-web-app-performance-anywhere/
- Lambda pricing, Web Functions worked examples: https://aws.amazon.com/lambda/pricing/
- Billing analysis that names the missing measurement ("measure the ratio of active CPU time to total request duration"), Oct 14, 2026: https://creuto.com/aws-lambda-web-functions-billing-concurrency
- Vercel WebSockets GA on Active CPU pricing, Oct 20, 2026: https://vercel.com/changelog/websocket-support-is-now-generally-available
- Vercel guide to Active CPU usage: https://vercel.com/kb/guide/optimize-active-cpu-on-fluid-compute
- Sibling tool for the same migration (cross-request leaks): https://github.com/ideator-labs/crosstalk
