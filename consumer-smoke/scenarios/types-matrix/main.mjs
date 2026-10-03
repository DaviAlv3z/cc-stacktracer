// O pacote compila no TypeScript de cada cliente: versões x modos de resolução, sempre com skipLibCheck: false.
// Até a 3.2: nenhuma combinação compilava — o .d.ts raiz importava `fastify` (T1), e o node10 do NestJS 10/11
// não achava os subpaths (T2). Fica de fora só o que o próprio TypeScript não suporta (ver SUPPORT).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCheck } from '../lib/check.mjs';

const check = createCheck('types-matrix');
const here = import.meta.dirname;
const tarball = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).dependencies['cc-stacktracer'];
const TS = { ts55: '5.5.4', ts58: '5.8.3', ts59: '5.9.3', ts60: '6.0.3', ts70: '7.0.2' };

/**
 * O que o TypeScript suporta — e, portanto, o que a documentação promete:
 * - CommonJS com nodenext só carrega ESM a partir do 5.8; `module: node20` nasceu no 5.9;
 * - a resolução node10 (NestJS 10/11) foi removida no 7.0; `module: node16` em CommonJS nunca carrega ESM.
 */
const CONFIGS = {
  'esm-nodenext': { type: 'module', co: { module: 'nodenext', moduleResolution: 'nodenext' }, from: '5.5' },
  bundler: { type: 'module', co: { module: 'esnext', moduleResolution: 'bundler' }, from: '5.5' },
  'cjs-nodenext': { type: 'commonjs', co: { module: 'nodenext', moduleResolution: 'nodenext' }, from: '5.8' },
  'cjs-node20': { type: 'commonjs', co: { module: 'node20', moduleResolution: 'node16' }, from: '5.9' },
  'cjs-node10': { type: 'commonjs', co: { module: 'commonjs', moduleResolution: 'node' }, from: '5.5', until: '6.0' },
};
const atLeast = (v, min) => Number(v.split('.')[0]) * 100 + Number(v.split('.')[1]) >= Number(min.split('.')[0]) * 100 + Number(min.split('.')[1]);

const CONSUMERS = {
  // App Express/Nest/Adonis: SEM fastify instalado.
  express: {
    deps: { express: '^5.2.1', '@types/express': '^5.0.6', '@types/node': '^22.10.0' },
    src: `import { StackTrace, withTrace } from 'cc-stacktracer';
import { stacktraceExpressMiddleware, stacktraceErrorMiddleware } from 'cc-stacktracer/express';
import { startHttpRequest } from 'cc-stacktracer/generic-http';
import { createStackTracePrismaQueryExtension } from 'cc-stacktracer/db-prisma';
import { createLucidStackTracePlugin } from 'cc-stacktracer/db-lucid';
export const used = [StackTrace.init, withTrace, stacktraceExpressMiddleware, stacktraceErrorMiddleware, startHttpRequest, createStackTracePrismaQueryExtension, createLucidStackTracePlugin];
`,
  },
  // App Fastify passando a instância ao auto() e registrando o plugin direto.
  fastify: {
    deps: { fastify: '^5.8.5', '@types/node': '^22.10.0' },
    src: `import Fastify from 'fastify';
import { StackTrace } from 'cc-stacktracer';
import stacktracePlugin from 'cc-stacktracer/fastify';
export async function boot(): Promise<void> {
  const app = Fastify();
  await StackTrace.auto({ apiKey: 'k', serviceId: '11111111-1111-4111-8111-111111111111', endpoint: 'https://x.test', fastify: app });
  const other = Fastify();
  await other.register(stacktracePlugin);
}
`,
  },
};

for (const [consumer, { deps, src }] of Object.entries(CONSUMERS)) {
  const dir = join(here, 'consumers', consumer);
  mkdirSync(dir, { recursive: true });
  const allDeps = { 'cc-stacktracer': tarball, ...deps };
  for (const [alias, v] of Object.entries(TS)) allDeps[alias] = `npm:typescript@${v}`;
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `types-${consumer}`, private: true, dependencies: allDeps }));
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'], { cwd: dir, encoding: 'utf8' });
  if (install.status !== 0) {
    check.ok(false, `npm install (${consumer}): ${install.stderr.slice(-500)}`);
    continue;
  }
  for (const [cfgName, cfg] of Object.entries(CONFIGS)) {
    const cdir = join(dir, cfgName);
    mkdirSync(cdir, { recursive: true });
    writeFileSync(join(cdir, 'package.json'), JSON.stringify({ type: cfg.type }));
    writeFileSync(join(cdir, 'main.ts'), src);
    for (const [alias, v] of Object.entries(TS)) {
      if (!atLeast(v, cfg.from) || (cfg.until !== undefined && atLeast(v, `${Number(cfg.until.split('.')[0])}.${Number(cfg.until.split('.')[1]) + 1}`))) continue;
      const co = { target: 'ES2022', strict: true, skipLibCheck: false, noEmit: true, types: ['node'], esModuleInterop: true, ...cfg.co };
      if (v.startsWith('6.')) co.ignoreDeprecations = '6.0'; // o 6.0 depreca node10 sem remover
      writeFileSync(join(cdir, 'tsconfig.json'), JSON.stringify({ compilerOptions: co, files: ['main.ts'] }));
      const r = spawnSync(process.execPath, [join(dir, 'node_modules', alias, 'bin', 'tsc'), '-p', 'tsconfig.json'], { cwd: cdir, encoding: 'utf8' });
      const first = `${r.stdout}${r.stderr}`.trim().split('\n')[0] ?? '';
      check.ok(r.status === 0, `${consumer} / ${cfgName} / TS ${v}: ${first.slice(0, 200)}`);
    }
  }
}
check.done();
