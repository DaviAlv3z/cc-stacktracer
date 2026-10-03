import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/**
 * Roda `node <script> ...args` e mede quanto o processo leva para sair SOZINHO. Relógio monotônico
 * (`performance.now()`): o relógio de parede da VM do Docker Desktop salta dezenas de segundos durante a
 * execução, e com `Date.now()` as medidas saíam até negativas.
 */
export function runChild(script, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ms: Math.round(performance.now() - started), output });
    });
  });
}
