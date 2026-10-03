// Job que leva um 503 e depois quebra com exceção não tratada: o evento do crash é o que mais importa.
import { StackTrace } from 'cc-stacktracer';

const [endpoint] = process.argv.slice(2);
StackTrace.init({ apiKey: 'k', serviceId: '11111111-1111-4111-8111-111111111111', endpoint, enableGlobalHandlers: true });
StackTrace.log('antes do crash');
await StackTrace.flush(); // 503: a fila entra no backoff
setTimeout(() => {
  throw new Error('crash do job');
}, 0);
