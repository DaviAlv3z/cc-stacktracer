import http from 'node:http';
import { checkHttpTelemetry, runHttpScript, userWork } from './http-script.mjs';
import { startReceiver } from './receiver.mjs';
import { createCheck, SERVICE_ID } from './check.mjs';

export async function runAdonisScenario({ name, appRoot, importer, middlewareImport, AppFactory, ServerFactory, ExceptionHandler, sdk }) {
  const check = createCheck(name);
  const receiver = await startReceiver();
  sdk.StackTrace.init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint: receiver.url });
  const app = new AppFactory().create(appRoot, importer);
  await app.init();
  const server = new ServerFactory().merge({ app }).create();
  // Exatamente como o guia manda: primeiro middleware de servidor.
  server.use([middlewareImport]);
  server.errorHandler(async () => ({
    default: class AppExceptionHandler extends ExceptionHandler {
      debug = false;
      async report(error, ctx) {
        sdk.StackTrace.recordRequestError(error);
        return super.report(error, ctx);
      }
    },
  }));
  const router = server.getRouter();
  router.get('/users/:id', async ({ params }) => {
    await userWork(sdk.StackTrace, params.id);
    return { ok: true };
  });
  router.get('/boom', async () => {
    throw new Error('boom');
  });
  await server.boot();
  const node = http.createServer((req, res) => server.handle(req, res));
  await new Promise((resolve) => node.listen(0, '127.0.0.1', resolve));
  const statuses = await runHttpScript(`http://127.0.0.1:${node.address().port}`);
  node.closeAllConnections?.();
  await new Promise((resolve) => node.close(resolve));
  await sdk.StackTrace.shutdown();
  checkHttpTelemetry(check, receiver, statuses);
  await receiver.close();
  check.done();
}
