// Job que termina sozinho com a ingestão fora do ar: o que ficou na fila é perdido — com um aviso.
import { StackTrace, withTrace } from 'cc-stacktracer';

const [endpoint] = process.argv.slice(2);
StackTrace.init({ apiKey: 'k', serviceId: '11111111-1111-4111-8111-111111111111', endpoint });
await withTrace('job.offline', async () => {
  StackTrace.log('um');
  StackTrace.log('dois');
});
