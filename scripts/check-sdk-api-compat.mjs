#!/usr/bin/env node
/**
 * Gate de compatibilidade da API pública: nada que a versão publicada exporta pode sumir numa minor.
 *
 * Compara, subpath a subpath, os nomes que o pacote novo (tarball) exporta em runtime com os da versão de
 * referência no npm (padrão: `latest`), mais as chaves do objeto `StackTrace` e do mapa `exports`. Nome novo
 * é permitido; nome que some é FALHA. Tipos (.d.ts) são cobertos pelo smoke de tipos do consumer-smoke.
 *
 *   node scripts/check-sdk-api-compat.mjs <pacote.tgz> [--against cc-stacktracer@latest]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const tarball = argv[0] && !argv[0].startsWith('--') ? resolve(argv[0]) : null;
const againstIndex = argv.indexOf('--against');
const against = againstIndex >= 0 ? argv[againstIndex + 1] : 'cc-stacktracer@latest';
if (tarball === null) {
  console.error('uso: node scripts/check-sdk-api-compat.mjs <pacote.tgz> [--against cc-stacktracer@latest]');
  process.exit(2);
}
const isWindows = process.platform === 'win32';
// `.cmd` no Windows: sem shell o Node 20.12+ recusa (EINVAL); com `shell` + args o Node 24 avisa DEP0190.
const npm = (args, cwd) =>
  isWindows
    ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Instala `spec` num projeto vazio e devolve { exports: {subpath: [nomes]}, stackTrace: [chaves], map: [subpaths] }. */
function surface(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-api-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'api-probe', private: true, type: 'module' }));
    npm(['install', spec, '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts'], dir);
    const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', 'cc-stacktracer', 'package.json'), 'utf8'));
    const subpaths = Object.keys(pkg.exports ?? { '.': {} });
    const probe = `
      const subpaths = ${JSON.stringify(subpaths)};
      const out = { version: ${JSON.stringify(pkg.version)}, map: subpaths, exports: {}, stackTrace: [] };
      for (const s of subpaths) {
        const id = s === '.' ? 'cc-stacktracer' : 'cc-stacktracer/' + s.slice(2);
        try {
          const m = await import(id);
          out.exports[s] = Object.keys(m).sort();
          if (s === '.') out.stackTrace = Object.keys(m.StackTrace ?? {}).sort();
        } catch (err) {
          out.exports[s] = ['<import falhou: ' + (err.code ?? err.message) + '>'];
        }
      }
      console.log(JSON.stringify(out));`;
    writeFileSync(join(dir, 'probe.mjs'), probe);
    return JSON.parse(execFileSync(process.execPath, [join(dir, 'probe.mjs')], { cwd: dir, encoding: 'utf8' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const before = surface(against);
const after = surface(tarball);
const missing = [];
for (const s of before.map) {
  if (!after.map.includes(s)) missing.push(`subpath ${s} sumiu do exports`);
}
for (const [s, names] of Object.entries(before.exports)) {
  const now = new Set(after.exports[s] ?? []);
  for (const n of names) if (!n.startsWith('<') && !now.has(n)) missing.push(`${s}: export "${n}" sumiu`);
}
for (const k of before.stackTrace) {
  if (!after.stackTrace.includes(k)) missing.push(`StackTrace.${k} sumiu`);
}
const added = Object.entries(after.exports).flatMap(([s, names]) => names.filter((n) => !(before.exports[s] ?? []).includes(n)).map((n) => `${s}: ${n}`));
console.log(`API ${after.version} contra ${before.version}: ${added.length} nome(s) novo(s)${added.length > 0 ? ` (${added.join(', ')})` : ''}.`);
if (missing.length > 0) {
  console.error(`QUEBRA DE COMPATIBILIDADE (${missing.length}):\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log('Nenhum nome público removido.');
