#!/usr/bin/env node
/**
 * O smoke de consumidor dentro de containers: uma imagem por versão do Node (`docker/Dockerfile`), com Postgres,
 * MySQL e SQL Server reais numa rede própria. É o mesmo caminho na máquina do dev e no CI, e não depende do
 * Node instalado no host — no Windows, o `npx -p node@X` nem roda com o npm 11.
 *
 * Uso:   npm run build:client && node consumer-smoke/docker.mjs [--node 20,22,24,26] [--only a,b] [--keep-services]
 *        node consumer-smoke/docker.mjs --tarball cc-stacktracer-3.2.0.tgz   # uma versão já publicada (`npm pack cc-stacktracer@3.2.0`)
 *        node consumer-smoke/docker.mjs --node 24 --only nest12-express --script smoke:painel-3.2   # outro script do cenário
 * Saída: 0 se nenhum cenário falhou em nenhuma versão.
 *
 * Containers, rede e volume levam o prefixo `cc-smoke-`: nada aqui toca em container que este script não criou.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = resolve(here, '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const nodes = option('--node', '20,22,24,26').split(',');
const only = option('--only', null);
const givenTarball = option('--tarball', null);
const script = option('--script', null);
const keepServices = argv.includes('--keep-services');
const isWindows = process.platform === 'win32';

const NET = 'cc-smoke-net';
const MSSQL_PASSWORD = 'Smoke_Pass_123';
const SERVICES = [
  {
    name: 'cc-smoke-pg',
    image: 'postgres:16-alpine',
    env: ['POSTGRES_USER=smoke', 'POSTGRES_PASSWORD=smoke', 'POSTGRES_DB=smoke'],
    ready: ['pg_isready', '-U', 'smoke'],
  },
  {
    name: 'cc-smoke-mysql',
    image: 'mysql:8.4',
    env: ['MYSQL_ROOT_PASSWORD=smoke', 'MYSQL_DATABASE=smoke'],
    ready: ['mysqladmin', 'ping', '-h', '127.0.0.1', '-psmoke', '--silent'],
  },
  {
    name: 'cc-smoke-mssql',
    image: 'mcr.microsoft.com/mssql/server:2022-latest',
    env: ['ACCEPT_EULA=Y', `MSSQL_SA_PASSWORD=${MSSQL_PASSWORD}`, 'MSSQL_PID=Developer'],
    // Pronto = aceita login E o banco `smoke` existe (o comando o cria; é idempotente).
    ready: ['/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-P', MSSQL_PASSWORD, '-C', '-Q', "IF DB_ID('smoke') IS NULL CREATE DATABASE smoke"],
  },
];
const SCENARIO_ENV = [
  'CC_SMOKE_PG_URL=postgres://smoke:smoke@cc-smoke-pg:5432/smoke',
  'CC_SMOKE_MYSQL_URL=mysql://root:smoke@cc-smoke-mysql:3306/smoke',
  `CC_SMOKE_MSSQL_URL=sqlserver://cc-smoke-mssql:1433;database=smoke;user=sa;password=${MSSQL_PASSWORD};trustServerCertificate=true`,
];

// No Windows o Git Bash converteria `/opt/...` em caminho do Windows; chamando o docker direto, sem shell, não há conversão.
const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', ...opts });
function must(result, what) {
  if (result.status !== 0) {
    console.error(`${what} falhou:\n${result.stderr ?? ''}${result.stdout ?? ''}`);
    process.exit(2);
  }
  return result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function npmPack(dest) {
  const args = ['pack', '--pack-destination', dest, '--silent'];
  // `.cmd` no Windows: sem shell o Node 20.12+ recusa (EINVAL); com `shell` + args o Node 24 avisa DEP0190.
  const r = isWindows
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { cwd: sdkRoot, encoding: 'utf8' })
    : spawnSync('npm', args, { cwd: sdkRoot, encoding: 'utf8' });
  must(r, 'npm pack');
  return r.stdout.trim().split(/\r?\n/).pop();
}

async function startServices() {
  if (docker(['network', 'inspect', NET]).status !== 0) must(docker(['network', 'create', NET]), `docker network create ${NET}`);
  for (const s of SERVICES) {
    if (docker(['inspect', s.name]).status === 0) continue;
    must(docker(['run', '-d', '--rm', '--name', s.name, '--network', NET, ...s.env.flatMap((e) => ['-e', e]), s.image]), `subir ${s.name}`);
  }
  for (const s of SERVICES) {
    const deadline = performance.now() + 240_000;
    while (docker(['exec', s.name, ...s.ready]).status !== 0) {
      if (performance.now() > deadline) {
        console.error(`${s.name} não ficou pronto em 4 min`);
        process.exit(2);
      }
      await sleep(2_000);
    }
    console.log(`${s.name} pronto`);
  }
}

function stopServices() {
  for (const s of SERVICES) docker(['rm', '-f', s.name]);
  docker(['network', 'rm', NET]);
}

if (givenTarball === null && !existsSync(join(sdkRoot, 'dist', 'index.js'))) {
  console.error('dist/ ausente: rode `npm run build:client` (no repo público, `npm run build`) antes do smoke.');
  process.exit(2);
}
must(docker(['version', '--format', '{{.Server.Version}}']), 'docker (o Docker está no ar?)');
const packDir = mkdtempSync(join(tmpdir(), 'cc-smoke-pack-'));
let tarball;
if (givenTarball !== null) {
  tarball = basename(givenTarball);
  copyFileSync(resolve(givenTarball), join(packDir, tarball));
} else {
  tarball = npmPack(packDir);
}
console.log(`pacote: ${tarball}`);
await startServices();

const summary = [];
try {
  for (const v of nodes) {
    must(docker(['build', '-q', '--build-arg', `NODE_VERSION=${v}`, '-t', `cc-smoke-node:${v}`, join(here, 'docker')]), `imagem cc-smoke-node:${v}`);
    console.log(`\n=== Node ${v} ===`);
    const run = docker(
      [
        'run', '--rm', '--network', NET,
        '-v', `${here}:/smoke:ro`,
        '-v', `${packDir}:/pkg:ro`,
        '-v', 'cc-smoke-npm-cache:/root/.npm',
        ...SCENARIO_ENV.flatMap((e) => ['-e', e]),
        `cc-smoke-node:${v}`,
        'node', '/smoke/run.mjs', '--tarball', `/pkg/${tarball}`, '--require-services',
        ...(only !== null ? ['--only', only] : []),
        ...(script !== null ? ['--script', script] : []),
      ],
      { stdio: 'inherit' },
    );
    summary.push({ node: v, ok: run.status === 0 });
  }
} finally {
  rmSync(packDir, { recursive: true, force: true });
  if (!keepServices) stopServices();
}
console.log(`\n${summary.map((s) => `${s.ok ? 'PASS' : 'FAIL'} Node ${s.node}`).join('\n')}`);
process.exit(summary.every((s) => s.ok) ? 0 : 1);
