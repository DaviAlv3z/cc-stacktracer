import http from 'node:http';
import axios from 'axios';
import express from 'express';
import { StackTrace } from 'cc-stacktracer';
import { stacktraceExpressMiddleware } from 'cc-stacktracer/express';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck, SERVICE_ID } from '../lib/check.mjs';

const check = createCheck('outbound');
const receiver = await startReceiver();
const seen = [];
const downstream = http.createServer((req, res) => {
  seen.push({ path: req.url, traceparent: req.headers.traceparent ?? null });
  res.end('ok');
});
await new Promise((resolve) => downstream.listen(0, '127.0.0.1', resolve));
const B = `http://127.0.0.1:${downstream.address().port}`;
await StackTrace.auto({
  apiKey: 'k',
  serviceId: SERVICE_ID,
  endpoint: receiver.url,
  outboundHttp: { instrumentNodeHttp: true, instrumentFetch: true },
});
const app = express();
app.use(stacktraceExpressMiddleware());
app.get('/call', async (_req, res) => {
  await axios.get(`${B}/via-axios`);
  await (await fetch(`${B}/via-fetch`)).text();
  await new Promise((resolve) =>
    http.get(`${B}/via-http-get`, (r) => {
      r.resume();
      r.on('end', resolve);
    }),
  );
  res.json({ ok: true });
});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
await (await fetch(`http://127.0.0.1:${server.address().port}/call`)).text();
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
downstream.closeAllConnections?.();
await new Promise((resolve) => downstream.close(resolve));
await StackTrace.shutdown();
const spans = receiver.spans();
const root = spans.find((s) => s.span_type === 'http' && s.http_route === '/call');
check.ok(root !== undefined, 'span raiz do /call');
check.equal(seen.map((s) => s.path), ['/via-axios', '/via-fetch', '/via-http-get'], 'chamadas recebidas');
for (const s of seen) {
  const [, traceId, parentId] = (s.traceparent ?? '').split('-');
  check.equal(traceId, root?.trace_id, `${s.path}: traceparent com o trace da raiz`);
  const child = spans.find((x) => x.span_id === parentId);
  check.equal(child?.span_type, 'external', `${s.path}: span de saída enviado`);
  check.equal(child?.parent_span_id, root?.span_id, `${s.path}: span de saída filho da raiz`);
}
await receiver.close();
check.done();
