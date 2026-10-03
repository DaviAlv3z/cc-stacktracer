/** Utilitários dos cenários. Um cenário é um processo: `done()` encerra com 0 (PASS) ou 1 (FAIL). */
export const SERVICE_ID = '11111111-1111-4111-8111-111111111111';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Prazos com relógio monotônico: o de parede da VM do Docker Desktop salta (Regra 10 do plano da 3.3). */
export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (performance.now() > deadline) return false;
    await sleep(intervalMs);
  }
}

export function createCheck(name) {
  const failures = [];
  return {
    equal(actual, expected, label) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        failures.push(`${label}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
      }
    },
    ok(condition, label) {
      if (!condition) failures.push(label);
    },
    done() {
      if (failures.length > 0) {
        console.error(`FAIL ${name}\n  - ${[...new Set(failures)].slice(0, 25).join('\n  - ')}`);
        process.exit(1);
      }
      console.log(`PASS ${name}`);
      process.exit(0);
    },
  };
}

/**
 * URL de uma porta que recusa conexão (ECONNREFUSED): abre uma porta livre e a fecha. Não use portas fixas
 * baixas como a 9: o fetch as bloqueia antes de conectar (`bad port`), e o teste deixaria de medir a recusa.
 */
export async function closedPortUrl() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}
