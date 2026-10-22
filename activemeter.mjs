#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { eventCost, webCost, webEnvironments } from './price.mjs';

const TICKS_PER_SECOND = 100;
const here = new URL('.', import.meta.url);

function parseArgs(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0) throw new Error('usage: activemeter --mix mix.json [--seconds 3] [--out report.json] [--wall-as-cpu] -- <server command>');
  const opts = { seconds: 3, out: null, wallAsCpu: false, mix: null, cmd: argv.slice(sep + 1) };
  const flags = argv.slice(0, sep);
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--mix') opts.mix = flags[++i];
    else if (flags[i] === '--seconds') opts.seconds = Number(flags[++i]);
    else if (flags[i] === '--out') opts.out = flags[++i];
    else if (flags[i] === '--wall-as-cpu') opts.wallAsCpu = true;
    else throw new Error(`unknown flag ${flags[i]}`);
  }
  if (!opts.mix) throw new Error('--mix is required');
  return opts;
}

function cpuMs(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return ((Number(fields[11]) + Number(fields[12])) * 1000) / TICKS_PER_SECOND;
}

function peakRssMb(pid) {
  const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((l) => l.startsWith('VmHWM:'));
  return Number(line.split(/\s+/)[1]) / 1024;
}

function freePort() {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitUp(base, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try { await fetch(base + '/'); return; } catch { await sleep(50); }
  }
  throw new Error('server did not listen within 5 s');
}

async function drive(url, concurrency, seconds) {
  const latencies = [];
  const deadline = performance.now() + seconds * 1000;
  async function worker() {
    while (performance.now() < deadline) {
      const t0 = performance.now();
      const res = await fetch(url);
      await res.arrayBuffer();
      if (!res.ok) throw new Error(`${url} returned ${res.status}`);
      latencies.push(performance.now() - t0);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return latencies;
}

async function measureRoute(base, pid, route, seconds) {
  await drive(base + route.path, route.concurrency, 0.3);
  const idle0 = cpuMs(pid);
  await sleep(1000);
  const idlePerSecond = cpuMs(pid) - idle0;
  const cpu0 = cpuMs(pid);
  const t0 = performance.now();
  const latencies = await drive(base + route.path, route.concurrency, seconds);
  const wallMs = performance.now() - t0;
  const busyCpuMs = Math.max(0, cpuMs(pid) - cpu0 - idlePerSecond * (wallMs / 1000));
  const requests = latencies.length;
  const inFlightMs = latencies.reduce((a, b) => a + b, 0) / requests;
  return { path: route.path, concurrency: route.concurrency, requests, wallMs, inFlightMs, cpuMsPerRequest: busyCpuMs / requests };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mix = JSON.parse(readFileSync(opts.mix, 'utf8'));
  const prices = JSON.parse(readFileSync(new URL('prices.json', here), 'utf8'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(opts.cmd[0], opts.cmd.slice(1), {
    env: { ...process.env, AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${port}` },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitUp(base, child);
    const samples = [];
    for (const route of mix.routes) samples.push(await measureRoute(base, child.pid, route, opts.seconds));
    const consumedGb = peakRssMb(child.pid) / 1024;
    const eventMemoryGb = mix.eventMemoryMb / 1024;
    const routes = samples.map((s) => {
      const cpuMsForBilling = opts.wallAsCpu ? s.inFlightMs : s.cpuMsPerRequest;
      const activeShare = cpuMsForBilling / s.inFlightMs;
      const traffic = { requestsPerMonth: mix.requestsPerMonth, inFlightMs: s.inFlightMs, cpuMs: cpuMsForBilling };
      const environments = webEnvironments(traffic);
      const event = eventCost(prices, { ...traffic, memoryGb: eventMemoryGb });
      const web = webCost(prices, { ...traffic, consumedGb, environments });
      return { ...s, cpuMsForBilling, activeShare, environments, event, web, cheaper: web.total < event.total ? 'web' : 'event' };
    });
    const report = {
      method: opts.wallAsCpu ? 'wall-as-cpu' : 'proc-cpu',
      node: process.version,
      peakRssMb: consumedGb * 1024,
      requestsPerMonth: mix.requestsPerMonth,
      eventMemoryMb: mix.eventMemoryMb,
      prices,
      routes,
    };
    printTable(report);
    if (opts.out) writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n');
  } finally {
    child.kill();
  }
}

function printTable(r) {
  const $ = (n) => `$${n.toFixed(2)}`;
  console.log(`method=${r.method} node=${r.node} peakRss=${r.peakRssMb.toFixed(1)}MB traffic=${r.requestsPerMonth} req/month event memory=${r.eventMemoryMb}MB`);
  console.log('route       conc   reqs   in-flight ms   cpu ms/req   active   envs   event/mo   web/mo   cheaper');
  for (const x of r.routes) {
    console.log([
      x.path.padEnd(10), String(x.concurrency).padStart(5), String(x.requests).padStart(6),
      x.inFlightMs.toFixed(1).padStart(14), x.cpuMsForBilling.toFixed(2).padStart(12),
      `${(x.activeShare * 100).toFixed(1)}%`.padStart(8), String(x.environments).padStart(6),
      $(x.event.total).padStart(10), $(x.web.total).padStart(8), x.cheaper.padStart(9),
    ].join(' '));
  }
}

main().catch((e) => { console.error(`activemeter: ${e.message}`); process.exit(2); });
