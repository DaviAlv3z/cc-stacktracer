import { performance } from 'node:perf_hooks';
import express from 'express';
import { StackTrace } from 'cc-stacktracer';
import { stacktraceExpressMiddleware } from 'cc-stacktracer/express';
import { startReceiver } from '../lib/receiver.mjs';
import { closedPortUrl, createCheck, SERVICE_ID } from '../lib/check.mjs';

const check = createCheck('app-safety');
const problems = [];
process.on('uncaughtException', (e) => problems.push(`uncaught: ${e.message}`));
process.on('unhandledRejection', (e) => problems.push(`unhandled: ${String(e)}`));
console.warn = () => {}; // os avisos de perda são esperados aqui; o cenário mede o app, não o log
const hang = await startReceiver({ hang: true });
const failing = await startReceiver({ status: 500 });
const targets = { recusado: await closedPortUrl(), pendurado: hang.url, erro500: failing.url };

for (const [label, endpoint] of Object.entries(targets)) {
  StackTrace.init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint, maxBatchSize: 10, flushIntervalMs: 100 });
  const app = express();
  app.use(stacktraceExpressMiddleware());
  app.get('/work/:id', (req, res) => {
    StackTrace.setUser({ id: req.params.id });
    StackTrace.log(`work ${req.params.id}`);
    res.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const statuses = await Promise.all(
    Array.from({ length: 300 }, (_, i) =>
      fetch(`${base}/work/${i}`).then(async (r) => {
        await r.text();
        return r.status;
      }),
    ),
  );
  check.equal(statuses.filter((s) => s !== 200).length, 0, `${label}: toda requisição respondeu 200`);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  const started = performance.now();
  await StackTrace.shutdown();
  const took = Math.round(performance.now() - started);
  check.ok(took <= 5_500, `${label}: shutdown em ${took}ms (<= 5500)`);
}
check.equal(problems, [], 'nenhuma exceção escapou para o processo');
await hang.close();
await failing.close();
check.done();
