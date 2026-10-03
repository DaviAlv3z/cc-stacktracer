import { spawn } from 'node:child_process';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck } from '../lib/check.mjs';
import { checkHttpTelemetry, runHttpScript } from '../lib/http-script.mjs';

// variant: 'record' (o filtro da 3.3) ou 'capture' (o filtro que o painel ensinava até a 3.2).
const [main, variant = 'record'] = process.argv.slice(2);
const check = createCheck(`${process.env.npm_package_name}:${variant}`);
const receiver = await startReceiver();
const child = spawn(process.execPath, [main], {
  env: { ...process.env, STACKTRACE_ENDPOINT: receiver.url, FILTER: variant },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const port = await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => {
    out += d;
    const m = /LISTENING (\d+)/.exec(out);
    if (m) resolve(Number(m[1]));
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  child.on('exit', (c) => reject(new Error(`app saiu antes de ouvir (${c}): ${out}`)));
});
const statuses = await runHttpScript(`http://127.0.0.1:${port}`);
// Fim como o orquestrador faz: SIGTERM. Os shutdown hooks do Nest chamam StackTrace.shutdown().
const ended = new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? signal)));
child.kill('SIGTERM');
const how = await ended;
check.ok(how === 0 || how === 'SIGTERM', `app encerrou pelo SIGTERM (${how}); saída: ${out.trim().slice(-400)}`);
checkHttpTelemetry(check, receiver, statuses);
await receiver.close();
check.done();
