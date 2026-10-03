// A: depois de UMA falha passageira (503), shutdown() e flush() ainda entregam. Até a 3.2 voltavam sem tentar.
import { StackTrace } from 'cc-stacktracer';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck, SERVICE_ID } from '../lib/check.mjs';

const check = createCheck('backoff-recovery');
for (const finish of ['shutdown', 'flush']) {
  const receiver = await startReceiver({ statusSequence: [503] });
  StackTrace.init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint: receiver.url });
  StackTrace.log('evento 1');
  await StackTrace.flush(); // 503: a fila entra no backoff
  StackTrace.log('evento 2');
  await StackTrace[finish]();
  check.equal(receiver.events().map((e) => e.message), ['evento 1', 'evento 2'], `${finish}() entregou os dois eventos depois do 503`);
  await StackTrace.shutdown();
  await receiver.close();
}
check.done();
