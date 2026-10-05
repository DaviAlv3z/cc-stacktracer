import { checkHttpTelemetry, runHttpScript, userWork } from './http-script.mjs';
import { startReceiver } from './receiver.mjs';
import { createCheck, SERVICE_ID } from './check.mjs';

export async function runExpressScenario({ name, express, sdk, integration }) {
  const check = createCheck(name);
  const receiver = await startReceiver();
  sdk.StackTrace.init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint: receiver.url, identityOnSpans: true });
  const app = express();
  app.use(integration.stacktraceExpressMiddleware());
  app.get('/users/:id', async (req, res, next) => {
    try {
      await userWork(sdk.StackTrace, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });
  app.get('/boom', (_req, _res, next) => next(new Error('boom')));
  app.use(integration.stacktraceErrorMiddleware());
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const statuses = await runHttpScript(`http://127.0.0.1:${server.address().port}`);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await sdk.StackTrace.shutdown();
  checkHttpTelemetry(check, receiver, statuses, { identityOnSpans: true });
  await receiver.close();
  check.done();
}
