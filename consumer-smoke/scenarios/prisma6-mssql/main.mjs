import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as sdk from 'cc-stacktracer';
import { createStackTracePrismaQueryExtension } from 'cc-stacktracer/db-prisma';
import { mssqlConnectionFromEnv } from '../lib/db.mjs';
import { runPrismaScenario } from '../lib/prisma-scenario.mjs';

const require = createRequire(import.meta.url);

await runPrismaScenario({
  name: 'prisma6-mssql',
  cliPath: fileURLToPath(new URL('./node_modules/prisma/build/index.js', import.meta.url)),
  env: { DATABASE_URL: process.env.CC_SMOKE_MSSQL_URL },
  pushArgs: ['--skip-generate', '--accept-data-loss'],
  dbSystem: 'sqlserver',
  makeClient: async () => {
    process.env.DATABASE_URL = process.env.CC_SMOKE_MSSQL_URL;
    const { PrismaClient } = require('@prisma/client');
    return new PrismaClient();
  },
  sdk,
  createStackTracePrismaQueryExtension,
});
