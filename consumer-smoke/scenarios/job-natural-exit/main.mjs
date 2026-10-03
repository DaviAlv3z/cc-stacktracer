import { fileURLToPath } from 'node:url';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck } from '../lib/check.mjs';
import { runChild } from '../lib/run-child.mjs';

const check = createCheck('job-natural-exit');
const job = fileURLToPath(new URL('./job.mjs', import.meta.url));

// 1) Ingestão saudável: tudo chega sem shutdown(), e o processo sai sozinho.
const ok = await startReceiver();
const first = await runChild(job, [ok.url]);
check.equal(first.code, 0, `job saiu com 0 (saída: ${first.output.trim()})`);
check.ok(first.ms < 5_000, `job saiu em ${first.ms}ms (< 5000)`);
check.equal(ok.events().length, 3, 'eventos entregues sem shutdown() (2 logs + 1 erro)');
check.equal(ok.spans().length, 2, 'spans entregues sem shutdown()');
await ok.close();

// 2) Ingestão que aceita e não responde: o flush de saída tem prazo (2 s); o processo não fica preso.
const hang = await startReceiver({ hang: true });
const second = await runChild(job, [hang.url]);
check.equal(second.code, 0, 'job com ingestão pendurada saiu com 0');
check.ok(second.ms < 5_000, `job com ingestão pendurada saiu em ${second.ms}ms (< 5000)`);
await hang.close();

check.done();
