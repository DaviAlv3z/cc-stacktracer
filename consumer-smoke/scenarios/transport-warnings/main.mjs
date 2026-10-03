import { StackTrace } from 'cc-stacktracer';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck, SERVICE_ID } from '../lib/check.mjs';

const check = createCheck('transport-warnings');
const lines = [];
const originalWarn = console.warn;
console.warn = (...args) => {
  lines.push(args.map(String).join(' '));
};

async function sendThrough(status) {
  const receiver = await startReceiver({ status });
  StackTrace.init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint: receiver.url });
  for (let i = 0; i < 3; i += 1) StackTrace.log(`evento ${i}`);
  await StackTrace.flush();
  StackTrace.log('mais um');
  await StackTrace.flush();
  await StackTrace.shutdown();
  await receiver.close();
}

await sendThrough(401);
const auth = lines.filter((l) => l.includes('[cc-stacktracer]') && l.includes('401'));
check.equal(auth.length, 1, 'um único aviso para a chave recusada (401)');
check.ok(auth[0]?.includes('doctor') === true, 'o aviso aponta o doctor');
lines.length = 0;
await sendThrough(404);
check.equal(lines.filter((l) => l.includes('[cc-stacktracer]') && l.includes('404')).length, 1, 'um único aviso para 404');
lines.length = 0;
await sendThrough(202);
check.equal(lines.filter((l) => l.includes('[cc-stacktracer]')).length, 0, 'ingestão saudável: nenhum aviso');
console.warn = originalWarn;
check.done();
