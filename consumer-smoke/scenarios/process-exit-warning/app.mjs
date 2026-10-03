// O CLI que chama process.exit() sem shutdown(): beforeExit não existe; a fila se perde — com um aviso.
import { StackTrace } from 'cc-stacktracer';

const [endpoint] = process.argv.slice(2);
StackTrace.init({ apiKey: 'k', serviceId: '11111111-1111-4111-8111-111111111111', endpoint });
StackTrace.log('perdido');
process.exit(0);
