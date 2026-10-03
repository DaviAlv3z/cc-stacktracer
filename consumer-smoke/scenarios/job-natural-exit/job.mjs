// O cron/CLI típico: init, trabalho dentro de withTrace e fim natural — SEM shutdown().
import { StackTrace, withSpan, withTrace } from 'cc-stacktracer';

const [endpoint] = process.argv.slice(2);
StackTrace.init({ apiKey: 'k', serviceId: '11111111-1111-4111-8111-111111111111', endpoint });
await withTrace('job.reprocess', async () => {
  StackTrace.log('comecou');
  try {
    await withSpan('etapa', async () => {
      throw new Error('falhou no job');
    });
  } catch {
    /* tratado */
  }
  StackTrace.log('terminou');
});
