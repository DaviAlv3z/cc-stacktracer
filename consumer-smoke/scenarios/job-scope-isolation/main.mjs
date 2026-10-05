// Até a 3.3.0: `withTrace` não tinha escopo. O `setUser`/`setTags` de um job ia para o escopo do processo inteiro:
// dois jobs concorrentes trocavam de usuário entre si, e a requisição anônima seguinte saía com o usuário e o
// subtenant do último job. Reproduzido com o 3.3.0 publicado.
import { StackTrace, withTrace } from 'cc-stacktracer';
import { endHttpRequest, runWithHttpContext, startHttpRequest } from 'cc-stacktracer/generic-http';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck, SERVICE_ID, sleep } from '../lib/check.mjs';

const check = createCheck('job-scope-isolation');
const receiver = await startReceiver();
StackTrace.init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint: receiver.url });

// Dois jobs ao mesmo tempo, cada um com o seu usuário e o seu cliente. O "a" loga DEPOIS de o "b" marcar.
await Promise.all(
  ['a', 'b'].map((id) =>
    withTrace(`job.${id}`, async () => {
      StackTrace.setUser({ id: `usuario-${id}` });
      StackTrace.setTags({ subtenant: `cliente-${id}` });
      await sleep(id === 'a' ? 30 : 5);
      StackTrace.log(`job ${id}`);
    }),
  ),
);

// Depois dos jobs, uma requisição anônima: não marca nada.
const trace = startHttpRequest({ method: 'GET', url: '/publica', route: '/publica' });
await runWithHttpContext(trace, async () => {
  StackTrace.log('requisicao anonima');
});
endHttpRequest(trace, { statusCode: 200 });
await StackTrace.shutdown();

const logs = receiver.events().filter((e) => e.type === 'log');
for (const id of ['a', 'b']) {
  const log = logs.find((e) => e.message === `job ${id}`);
  check.equal(log?.metadata?.user?.id, `usuario-${id}`, `o log do job ${id} leva o usuário DELE`);
  check.equal(log?.metadata?.tags?.subtenant, `cliente-${id}`, `o log do job ${id} leva o cliente DELE`);
}
const anonymous = logs.find((e) => e.message === 'requisicao anonima');
check.ok(anonymous !== undefined, 'o log da requisição anônima chegou');
check.equal(anonymous?.metadata?.user, undefined, 'a requisição anônima não herda o usuário de um job');
check.equal(anonymous?.metadata?.tags?.subtenant, undefined, 'a requisição anônima não herda o subtenant de um job');

await receiver.close();
check.done();
