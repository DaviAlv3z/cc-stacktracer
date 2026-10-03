/**
 * App real como o cliente roda em produção: o build pronto, num processo próprio, recebe o roteiro HTTP comum e
 * é encerrado por SIGTERM — o que o orquestrador (Docker, Kubernetes, PM2) faz em todo deploy. Confere o
 * contrato HTTP, os spans de banco e que o encerramento entregou tudo.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { createCheck } from './check.mjs';
import { checkHttpTelemetry, runHttpScript } from './http-script.mjs';
import { startReceiver } from './receiver.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Prontidão por TCP, e não por HTTP: uma requisição de sonda viraria span raiz e mudaria as contagens. */
function tcpOpen(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.end();
      resolve();
    });
    socket.once('error', reject);
  });
}

/**
 * @param {{ name: string, cwd: string, command: string[], env?: Record<string, string>, port?: number,
 *           expectDbSpans?: number, dbSystem?: string }} options
 * `env` vai para a app (o endpoint do SDK é o receptor, sempre). A app escuta em `port` (PORT no env).
 */
export async function runAppSmoke({ name, cwd, command, env = {}, port = 3333, expectDbSpans = 0, dbSystem }) {
  const check = createCheck(name);
  const receiver = await startReceiver();
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, ...env, PORT: String(port), STACKTRACE_ENDPOINT: receiver.url },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? signal)));

  // Relógio monotônico: o de parede da VM do Docker Desktop salta e vencia este prazo com a app no ar.
  const deadline = performance.now() + 90_000;
  for (;;) {
    try {
      await tcpOpen(port);
      break;
    } catch {
      if (performance.now() > deadline || child.exitCode !== null) {
        console.error(`FAIL ${name}: a app não subiu (exit ${child.exitCode})\n${out.slice(-3000)}`);
        child.kill('SIGKILL');
        process.exit(1);
      }
      await sleep(250);
    }
  }

  let statuses;
  try {
    statuses = await runHttpScript(`http://127.0.0.1:${port}`);
  } catch (err) {
    // Requisição que nem teve resposta (conexão recusada/derrubada): diz a causa e o que a app imprimiu.
    const cause = err?.cause?.code ?? err?.cause?.message ?? '';
    console.error(`FAIL ${name}: o roteiro HTTP não completou: ${err?.message} ${cause}\nexit da app: ${child.exitCode} ${child.signalCode}\n${out.slice(-3000)}`);
    child.kill('SIGKILL');
    process.exit(1);
  }
  child.kill('SIGTERM');
  const how = await Promise.race([exited, sleep(20_000).then(() => 'TIMEOUT')]);
  check.ok(how === 0 || how === 'SIGTERM', `app encerrou no SIGTERM (${how}); saída: ${out.trim().slice(-600)}`);
  checkHttpTelemetry(check, receiver, statuses);
  if (expectDbSpans > 0) {
    const spans = receiver.spans();
    const roots = new Set(spans.filter((s) => s.parent_span_id === null).map((s) => s.span_id));
    const dbSpans = spans.filter((s) => s.span_type === 'db');
    check.equal(dbSpans.length, expectDbSpans, 'spans de banco');
    check.ok(dbSpans.length > 0 && dbSpans.every((s) => s.db_system === dbSystem), `db_system ${dbSystem} (veio ${[...new Set(dbSpans.map((s) => s.db_system))]})`);
    check.ok(dbSpans.length > 0 && dbSpans.every((s) => roots.has(s.parent_span_id)), 'spans de banco filhos do span raiz da requisição');
  }
  await receiver.close();
  check.done();
}
