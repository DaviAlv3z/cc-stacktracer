// App Fastify 5 em TypeScript CommonJS (module NodeNext, sem "type": "module"), com @fastify/cors, helmet e
// rate-limit, Prisma 6 em SQL Server (dbSystem: 'sqlserver') e mssql cru dentro de runQuery. Encerramento como
// em produção: SIGTERM -> app.close() (onClose chama StackTrace.shutdown()) -> process.exit(0).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mssqlConnectionFromEnv } from '../lib/db.mjs';
import { runAppSmoke } from '../lib/app-smoke.mjs';

const bin = (rel) => fileURLToPath(new URL(`./node_modules/${rel}`, import.meta.url));
const run = (args, env = {}) => execFileSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...env } });
const DATABASE_URL = process.env.CC_SMOKE_MSSQL_URL;
run([bin('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--accept-data-loss'], { DATABASE_URL });
run([bin('prisma/build/index.js'), 'generate'], { DATABASE_URL });
run([bin('typescript/bin/tsc'), '-p', '.']);
const sql = mssqlConnectionFromEnv();
await runAppSmoke({
  name: 'app-fastify-prisma-mssql',
  cwd: '.',
  command: [process.execPath, 'dist/server.js'],
  env: {
    NODE_ENV: 'production',
    DATABASE_URL,
    MSSQL_HOST: sql.server,
    MSSQL_PORT: String(sql.port),
    MSSQL_USER: sql.user,
    MSSQL_PASSWORD: sql.password,
    MSSQL_DATABASE: sql.database,
    STACKTRACE_API_KEY: 'k',
    STACKTRACE_SERVICE_ID: '11111111-1111-4111-8111-111111111111',
  },
  expectDbSpans: 60,
  dbSystem: 'sqlserver',
});
