export const SECONDS_PER_MONTH = 2_592_000;

// The AWS pricing page examples round each line item up to the cent before summing.
const cents = (x) => Math.ceil(Math.round(x * 1e6) / 1e4) / 100;

export function webEnvironments({ requestsPerMonth, inFlightMs, cpuMs, maxConcurrency = 64, targetLoopUtilization = 0.7 }) {
  const rps = requestsPerMonth / SECONDS_PER_MONTH;
  const byConcurrency = Math.ceil((rps * inFlightMs) / 1000 / maxConcurrency);
  const byCpu = Math.ceil((rps * cpuMs) / 1000 / targetLoopUtilization);
  return Math.max(1, byConcurrency, byCpu);
}

export function eventCost(p, { requestsPerMonth, inFlightMs, memoryGb }) {
  const compute = cents(requestsPerMonth * (inFlightMs / 1000) * memoryGb * p.event.perGbSecond);
  const requests = cents((requestsPerMonth / 1e6) * p.event.perMillionRequests);
  return { compute, requests, total: cents(compute + requests) };
}

export function webCost(p, { requestsPerMonth, cpuMs, consumedGb, environments }) {
  const cpu = cents(requestsPerMonth * (cpuMs / 1000) * p.web.perActiveVcpuSecond);
  const memory = cents(consumedGb * environments * SECONDS_PER_MONTH * p.web.perGbSecond);
  const requests = cents((requestsPerMonth / 1e6) * p.web.perMillionRequests);
  return { cpu, memory, requests, total: cents(cpu + memory + requests) };
}
