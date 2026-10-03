// Graceful shutdown de um serviço cuja ingestão travou: o processo tem de sair logo após o prazo.
import { StackTrace } from 'cc-stacktracer';

const [endpoint] = process.argv.slice(2);
StackTrace.init({ apiKey: 'k', serviceId: '11111111-1111-4111-8111-111111111111', endpoint });
StackTrace.log('antes do shutdown');
await StackTrace.shutdown();
