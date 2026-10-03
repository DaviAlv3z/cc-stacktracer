import { fileURLToPath } from 'node:url';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck } from '../lib/check.mjs';
import { runChild } from '../lib/run-child.mjs';

const check = createCheck('process-exit-warning');
const receiver = await startReceiver();
const result = await runChild(fileURLToPath(new URL('./app.mjs', import.meta.url)), [receiver.url]);
const lines = result.output.split('\n').filter((l) => l.includes('[cc-stacktracer]'));
check.equal(result.code, 0, 'process.exit(0) continua saindo com 0');
check.equal(lines.length, 1, `um único aviso (${JSON.stringify(lines)})`);
check.ok(lines[0]?.includes('process.exit()') === true, 'o aviso ensina o shutdown() antes do process.exit()');
await receiver.close();
check.done();
