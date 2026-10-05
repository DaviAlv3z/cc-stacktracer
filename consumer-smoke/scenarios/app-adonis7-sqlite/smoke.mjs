// App Adonis 7 de verdade — o kit API do create-adonisjs 3.4.0, com Lucid 22 e SQLite (o padrão do kit) —, com o SDK
// plugado como o guia ensina. Build de produção, SIGTERM no fim.
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync } from 'node:fs';
import { runAppSmoke } from '../lib/app-smoke.mjs';

const env = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  APP_KEY: 'smoke-app-key-0123456789abcdefgh',
  APP_URL: 'http://127.0.0.1:3333',
  SESSION_DRIVER: 'cookie',
  LOG_LEVEL: 'warn',
  TZ: 'UTC',
  STACKTRACE_API_KEY: 'k',
  STACKTRACE_SERVICE_ID: '11111111-1111-4111-8111-111111111111',
};
execFileSync(process.execPath, ['ace', 'build'], { stdio: 'inherit', env: { ...process.env, ...env, PORT: '3333' } });
symlinkSync('../node_modules', 'build/node_modules', 'junction');
mkdirSync('build/tmp', { recursive: true }); // o SQLite do kit mora em app.tmpPath()
await runAppSmoke({ name: 'app-adonis7-sqlite', cwd: 'build', command: [process.execPath, 'bin/server.js'], env, expectDbSpans: 30, dbSystem: 'sqlite', identityOnSpans: true, dbStatement: true });
