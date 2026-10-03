import { StackTrace, withSpan, withTrace } from 'cc-stacktracer';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck, SERVICE_ID } from '../lib/check.mjs';

const check = createCheck('esm-core');
const receiver = await startReceiver();
StackTrace.init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint: receiver.url });
await withTrace('job.smoke', async () => {
  StackTrace.log('comecou');
  try {
    await withSpan('etapa', async () => {
      throw new Error('falhou no job');
    });
  } catch {
    /* o job trata e segue */
  }
  StackTrace.log('terminou');
});
await StackTrace.shutdown();
const events = receiver.events();
const spans = receiver.spans();
check.equal(events.filter((e) => e.type === 'log').length, 2, 'logs');
check.equal(events.filter((e) => e.type === 'error').length, 1, 'erro do withSpan');
check.equal(spans.length, 2, 'spans (job + etapa)');
check.equal(new Set([...events.map((e) => e.trace?.trace_id), ...spans.map((s) => s.trace_id)]).size, 1, 'tudo no mesmo trace');
check.ok(receiver.posts.every((p) => p.path === '/v1/events' || p.path === '/v1/spans'), 'só /v1/events e /v1/spans');
await receiver.close();
check.done();
