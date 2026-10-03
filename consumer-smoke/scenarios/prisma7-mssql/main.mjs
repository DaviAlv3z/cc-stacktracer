import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as sdk from 'cc-stacktracer';
import { createStackTracePrismaQueryExtension } from 'cc-stacktracer/db-prisma';
import { mssqlConnectionFromEnv } from '../lib/db.mjs';
import { runPrismaScenario } from '../lib/prisma-scenario.mjs';

const require = createRequire(import.meta.url);

await runPrismaScenario({
  name: 'prisma7-mssql',
  cliPath: fileURLToPath(new URL('./node_modules/prisma/build/index.js', import.meta.url)),
  env: { DATABASE_URL: process.env.CC_SMOKE_MSSQL_URL },
  pushArgs: ['--accept-data-loss'],
  dbSystem: 'sqlserver',
  makeClient: async () => {
    const { PrismaClient } = await import('@prisma/client');
    const { PrismaMssql } = await import('@prisma/adapter-mssql');
    return new PrismaClient({ adapter: new PrismaMssql(mssqlConnectionFromEnv()) });
  },
  sdk,
  createStackTracePrismaQueryExtension,
});
