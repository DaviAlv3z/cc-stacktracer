import { fileURLToPath } from 'node:url';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck } from '../lib/check.mjs';
import { runChild } from '../lib/run-child.mjs';

const check = createCheck('shutdown-hang');
const app = fileURLToPath(new URL('./app.mjs', import.meta.url));
const hang = await startReceiver({ hang: true });
const result = await runChild(app, [hang.url], { timeoutMs: 180_000 });
check.equal(result.code, 0, `processo saiu com 0 (saída: ${result.output.trim()})`);
// Prazo do shutdown (5 s) + partida do Node. Até a 3.2 ia a ~10 s (timeout do transporte).
check.ok(result.ms < 7_500, `processo saiu em ${result.ms}ms (< 7500)`);
await hang.close();
check.done();
