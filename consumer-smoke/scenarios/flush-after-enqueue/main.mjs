// Até a 3.3.0: `flush()` e `shutdown()` chamados poucos microtasks depois de dois enfileiramentos voltavam sem
// enviar — esperavam um flush de fundo que já tinha terminado. O `shutdown()` do SIGTERM e o flush do crash
// descartavam os eventos (e só sobrava o aviso de perda). Reproduzido com o 3.3.0 publicado: intervalos 1,0 e 2,0.
import { StackTrace } from 'cc-stacktracer';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck, SERVICE_ID } from '../lib/check.mjs';

const check = createCheck('flush-after-enqueue');
const receiver = await startReceiver();
const microtasks = async (n) => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

for (const how of ['flush', 'shutdown']) {
  for (const [gapA, gapB] of [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [0, 1],
    [3, 1],
  ]) {
    const tag = `${how}-${gapA}-${gapB}`;
    StackTrace.init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint: receiver.url });
    StackTrace.captureException(new Error(`${tag}-a`));
    await microtasks(gapA);
    StackTrace.captureException(new Error(`${tag}-b`));
    await microtasks(gapB);
    if (how === 'flush') await StackTrace.flush();
    else await StackTrace.shutdown();
    const delivered = receiver.events().filter((e) => String(e.message).startsWith(`${tag}-`)).length;
    check.equal(delivered, 2, `${how}() logo depois de dois enqueues (intervalos de ${gapA} e ${gapB} microtasks) entrega os dois`);
  }
}

await StackTrace.shutdown();
await receiver.close();
check.done();
