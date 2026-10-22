import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

function burnCpu(ms) {
  const start = process.cpuUsage();
  let x = 0;
  while (true) {
    for (let i = 0; i < 1000; i++) x += Math.sqrt(i);
    const d = process.cpuUsage(start);
    if ((d.user + d.system) / 1000 >= ms) return x;
  }
}

// STUB: the DB is a timer. It stands in for any I/O wait (Postgres, an HTTP API, a model call).
const fakeDb = (ms) => sleep(ms).then(() => ({ id: 42, rows: [1, 2, 3] }));

const routes = {
  '/db': async () => JSON.stringify(await fakeDb(120)),
  '/render': async () => String(burnCpu(20)),
  '/mixed': async () => { await fakeDb(60); return String(burnCpu(15)); },
};

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:3000').split(':');
http.createServer(async (req, res) => {
  const handler = routes[new URL(req.url, 'http://x').pathname];
  if (!handler) { res.writeHead(404).end(); return; }
  res.end(await handler());
}).listen(Number(port), host, () => console.log(`listening ${host}:${port}`));
