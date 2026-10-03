import { checkHttpTelemetry, runHttpScript, userWork } from './http-script.mjs';
import { startReceiver } from './receiver.mjs';
import { createCheck, SERVICE_ID } from './check.mjs';

export async function runFastifyScenario({ name, Fastify, sdk, plugin, pluginAbsent }) {
  const check = createCheck(name);
  const deprecations = [];
  process.on('warning', (warning) => {
    // Só os códigos do Fastify: avisos de outros pacotes do Node não são assunto deste cenário.
    if (String(warning.code ?? '').startsWith('FSTDEP')) deprecations.push(`${warning.code} ${warning.message}`);
  });
  check.ok(pluginAbsent, 'fastify-plugin ausente do projeto (o cliente sem @fastify/*)');
  const receiver = await startReceiver();
  sdk.StackTrace.init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint: receiver.url });
  const app = Fastify();
  await app.register(plugin);
  app.get('/users/:id', async (req) => {
    await userWork(sdk.StackTrace, req.params.id);
    return { ok: true };
  });
  app.get('/boom', async () => {
    throw new Error('boom');
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const statuses = await runHttpScript(`http://127.0.0.1:${app.server.address().port}`);
  await app.close();
  await sdk.StackTrace.shutdown();
  checkHttpTelemetry(check, receiver, statuses);
  check.equal(deprecations, [], 'nenhum DeprecationWarning do Fastify provocado pelo SDK');
  await receiver.close();
  check.done();
}
