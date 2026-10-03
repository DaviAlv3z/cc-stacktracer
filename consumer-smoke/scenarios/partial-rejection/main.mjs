// B: a ingestão aceita o lote (202) e recusa itens — o caso real é TODO span de um serviceId de outro projeto.
import { StackTrace, withTrace } from 'cc-stacktracer';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck, SERVICE_ID } from '../lib/check.mjs';

const check = createCheck('partial-rejection');
const lines = [];
console.warn = (...args) => lines.push(args.map(String).join(' '));
const receiver = await startReceiver({
  body: { success: true, data: { id: '', rejectedIndexes: [{ index: 0, message: 'service_id must belong to the API key project' }] } },
});
StackTrace.init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint: receiver.url });
await withTrace('job.partial', async () => {
  StackTrace.log('a');
});
await StackTrace.shutdown();
const warnings = lines.filter((l) => l.includes('[cc-stacktracer]'));
check.equal(warnings.length, 1, `um único aviso (${JSON.stringify(warnings)})`);
check.ok(warnings[0]?.includes('service_id must belong') === true, 'o aviso traz o motivo do servidor');
await receiver.close();
check.done();
