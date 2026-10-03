import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as sdk from 'cc-stacktracer';
import { createStackTracePrismaQueryExtension } from 'cc-stacktracer/db-prisma';
import { runPrismaScenario } from '../lib/prisma-scenario.mjs';

const schemaName = 'cc_smoke_prisma5_pg';
const url = new URL(process.env.CC_SMOKE_PG_URL);
url.searchParams.set('schema', schemaName);
const require = createRequire(import.meta.url);

await runPrismaScenario({
  name: 'prisma5-pg',
  cliPath: fileURLToPath(new URL('./node_modules/prisma/build/index.js', import.meta.url)),
  env: { DATABASE_URL: url.toString() },
  pushArgs: ['--skip-generate', '--accept-data-loss'],
  dbSystem: 'postgres',
  makeClient: async () => {
    process.env.DATABASE_URL = url.toString();
    const { PrismaClient } = require('@prisma/client');
    return new PrismaClient();
  },
  sdk,
  createStackTracePrismaQueryExtension,
});
