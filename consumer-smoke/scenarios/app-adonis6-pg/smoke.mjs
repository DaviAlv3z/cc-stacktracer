// App Adonis 6 de verdade — o kit API do create-adonisjs 2.4.1, com Lucid e Postgres —, com o SDK plugado como o
// guia ensina (start/stacktrace.ts, start/kernel.ts, app/exceptions/handler.ts). Build de produção, SIGTERM no fim.
import { execFileSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { pgConnectionFromEnv } from '../lib/db.mjs';
import { runAppSmoke } from '../lib/app-smoke.mjs';

const pg = pgConnectionFromEnv();
const env = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  APP_KEY: 'smoke-app-key-0123456789abcdefgh',
  LOG_LEVEL: 'warn',
  TZ: 'UTC',
  DB_HOST: pg.host,
  DB_PORT: String(pg.port),
  DB_USER: pg.user,
  DB_PASSWORD: pg.password,
  DB_DATABASE: pg.database,
  STACKTRACE_API_KEY: 'k',
  STACKTRACE_SERVICE_ID: '11111111-1111-4111-8111-111111111111',
};
execFileSync(process.execPath, ['ace', 'build'], { stdio: 'inherit', env: { ...process.env, ...env, PORT: '3333' } });
// O build leva só o código; as dependências são as do projeto (em produção seria um `npm ci --omit=dev` em build/).
symlinkSync('../node_modules', 'build/node_modules', 'junction');
await runAppSmoke({ name: 'app-adonis6-pg', cwd: 'build', command: [process.execPath, 'bin/server.js'], env, expectDbSpans: 30, dbSystem: 'postgres', identityOnSpans: true, dbStatement: true });
