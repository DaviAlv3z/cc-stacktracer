import express from 'express';
import { StackTrace } from 'cc-stacktracer';
import { stacktraceExpressMiddleware } from 'cc-stacktracer/express';
import { startHttpRequest } from 'cc-stacktracer/generic-http';

StackTrace.init({ apiKey: 'k', serviceId: '11111111-1111-4111-8111-111111111111', endpoint: 'http://127.0.0.1:9' });
const app = express();
app.use(stacktraceExpressMiddleware());
const kinds = [typeof StackTrace.log, typeof startHttpRequest].join(',');
if (kinds !== 'function,function') {
  console.error(`FAIL ts-cjs-nodenext: ${kinds}`);
  process.exit(1);
}
void StackTrace.shutdown().then(() => console.log('PASS ts-cjs-nodenext'));
