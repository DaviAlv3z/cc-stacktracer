import { fileURLToPath } from 'node:url';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck } from '../lib/check.mjs';
import { runChild } from '../lib/run-child.mjs';

const check = createCheck('crash-after-503');
const receiver = await startReceiver({ statusSequence: [503] });
const result = await runChild(fileURLToPath(new URL('./job.mjs', import.meta.url)), [receiver.url]);
check.equal(result.code, 1, 'o crash continua sendo crash (exit 1)');
check.ok(result.ms < 6_000, `saiu em ${result.ms}ms (< 6000)`);
const errors = receiver.events().filter((e) => e.type === 'error');
check.equal(errors.length, 1, 'o evento do crash chegou, mesmo depois do 503');
check.ok(receiver.events().some((e) => e.message === 'antes do crash'), 'o log anterior ao crash também chegou');
await receiver.close();
check.done();
