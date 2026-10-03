#!/usr/bin/env node
/**
 * Smoke de consumidor do cc-stacktracer.
 *
 * Empacota o SDK (`npm pack`), instala o tarball em projetos limpos — um por cenário, com os frameworks
 * e bancos reais nas versões que o `peerDependencies` promete — e roda o que o cliente roda. Nada aqui
 * importa de `src/`: o que é testado é o pacote que vai para o npm.
 *
 * Existe porque as falhas graves de 2026-09 passaram pelos testes do repo, que rodam onde tudo já está
 * instalado e contra mocks nossos: o middleware Adonis que não emitia nada, o Lucid que nunca gerou span,
 * o `fastify-plugin` que o cliente não tinha, o job que perdia a telemetria na saída.
 *
 * Uso:   npm run build:client && node consumer-smoke/run.mjs [--only a,b] [--require-services] [--keep] [--tarball x.tgz] [--script nome]
 *        (o caminho normal é o `docker.mjs`, que roda isto dentro de um container por versão do Node)
 * Env:   CC_SMOKE_PG_URL     postgres://user:senha@host:porta/banco         (cenários com "services": ["postgres"])
 *        CC_SMOKE_MYSQL_URL  mysql://user:senha@host:porta/banco            (["mysql"])
 *        CC_SMOKE_MSSQL_URL  sqlserver://host:porta;database=x;user=y;password=z;trustServerCertificate=true (["mssql"])
 *        CC_SMOKE_WORKDIR    pasta dos projetos temporários (padrão: tmpdir do sistema)
 * Saída: 0 se nenhum cenário falhou. Com --require-services, serviço ausente é FALHA, não SKIP.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(here, '..');
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const only = option('--only') !== undefined ? new Set(option('--only').split(',')) : null;
const givenTarball = option('--tarball');
// Outro script do cenário no lugar do `smoke` (ex.: `smoke:painel-3.2`, a prova do snippet antigo do NestJS).
const script = option('--script') ?? 'smoke';
const requireServices = argv.includes('--require-services');
const keep = argv.includes('--keep');
const isWindows = process.platform === 'win32';
const SERVICE_ENV = { postgres: 'CC_SMOKE_PG_URL', mysql: 'CC_SMOKE_MYSQL_URL', mssql: 'CC_SMOKE_MSSQL_URL' };

// Os cenários rodam no MESMO Node deste processo: o dele vai à frente do PATH dos filhos. No Windows a chave é
// `Path`, não `PATH` — duplicar a chave deixaria o filho com duas.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
const childEnv = { ...process.env, [pathKey]: `${dirname(process.execPath)}${delimiter}${process.env[pathKey] ?? ''}` };

function npm(args, options) {
  // `.cmd` no Windows: sem shell o Node 20.12+ recusa (EINVAL); com `shell` + args o Node 24 avisa DEP0190.
  return isWindows
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { encoding: 'utf8', env: childEnv, ...options })
    : spawnSync('npm', args, { encoding: 'utf8', env: childEnv, ...options });
}

function versionAtLeast(min) {
  const have = process.versions.node.split('.').map(Number);
  const want = min.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  }
  return true;
}

/** `require()` de ESM sem flag: 20.19+, 22.12+ e toda versão a partir da 23 (a 21 nunca recebeu). */
function nodeRequiresEsm() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major >= 23) return true;
  if (major === 22) return minor >= 12;
  if (major === 20) return minor >= 19;
  return false;
}

function skipReason(meta) {
  if (meta.minNode !== undefined && !versionAtLeast(meta.minNode)) {
    return `Node ${process.versions.node} < ${meta.minNode}`;
  }
  // Cenário que não depende do Node (ex.: matriz de tipos) roda numa versão só.
  if (meta.nodeMajors !== undefined && !meta.nodeMajors.includes(Number(process.versions.node.split('.')[0]))) {
    return `só no Node ${meta.nodeMajors.join('/')}`;
  }
  if (meta.requireEsm === true && !nodeRequiresEsm()) {
    return `Node ${process.versions.node} sem require() de ESM`;
  }
  return null;
}

const work = mkdtempSync(join(process.env.CC_SMOKE_WORKDIR ?? tmpdir(), 'cc-smoke-'));
let tarball;
if (givenTarball !== undefined) {
  tarball = resolve(givenTarball);
} else {
  if (!existsSync(join(sdkRoot, 'dist', 'index.js'))) {
    console.error('dist/ ausente: rode `npm run build` (ou `npm run build:client`) antes do smoke.');
    process.exit(2);
  }
  const packed = npm(['pack', '--pack-destination', work, '--silent'], { cwd: sdkRoot });
  if (packed.status !== 0) {
    console.error(`npm pack falhou:\n${packed.stderr}`);
    process.exit(2);
  }
  tarball = join(work, packed.stdout.trim().split(/\r?\n/).pop());
}
cpSync(join(here, 'lib'), join(work, 'lib'), { recursive: true });
console.log(`pacote: ${tarball}\nNode ${process.versions.node}\n`);

const results = [];
for (const name of readdirSync(join(here, 'scenarios')).sort()) {
  if (only !== null && !only.has(name)) continue;
  const source = join(here, 'scenarios', name);
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  const meta = pkg.smoke ?? {};
  const skip = skipReason(meta);
  if (skip !== null) {
    results.push({ name, status: 'SKIP', detail: skip });
    continue;
  }
  const missing = (meta.services ?? []).filter((s) => !process.env[SERVICE_ENV[s] ?? '']);
  if (missing.length > 0) {
    results.push({ name, status: requireServices ? 'FAIL' : 'SKIP', detail: `serviço ausente: ${missing.join(', ')}` });
    continue;
  }
  const dir = join(work, name);
  cpSync(source, dir, { recursive: true });
  pkg.dependencies = { ...pkg.dependencies, 'cc-stacktracer': `file:${tarball}` };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  const started = performance.now();
  const install = npm(['install', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'], {
    cwd: dir,
    timeout: 900_000,
  });
  if (install.status !== 0) {
    results.push({ name, status: 'FAIL', detail: 'npm install falhou', output: `${install.stdout}${install.stderr}` });
    continue;
  }
  const run = npm(['run', script, '--silent'], { cwd: dir, timeout: meta.timeoutMs ?? 180_000 });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
  const seconds = Math.round((performance.now() - started) / 1000);
  results.push({ name, status: run.status === 0 ? 'PASS' : 'FAIL', detail: `${seconds}s`, output });
}

for (const r of results) {
  console.log(`${r.status.padEnd(5)} ${r.name.padEnd(26)} ${r.detail ?? ''}`);
}
for (const r of results.filter((x) => x.status === 'FAIL' && x.output)) {
  console.log(`\n--- ${r.name} ---\n${r.output.slice(-4000)}`);
}
if (keep) console.log(`\nprojetos mantidos em ${work}`);
else rmSync(work, { recursive: true, force: true });
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
