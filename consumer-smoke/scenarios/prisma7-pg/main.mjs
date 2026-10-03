import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as sdk from 'cc-stacktracer';
import { createStackTracePrismaQueryExtension } from 'cc-stacktracer/db-prisma';
import { runPrismaScenario } from '../lib/prisma-scenario.mjs';

const schemaName = 'cc_smoke_prisma7_pg';
const url = new URL(process.env.CC_SMOKE_PG_URL);
url.searchParams.set('schema', schemaName);
const require = createRequire(import.meta.url);

await runPrismaScenario({
  name: 'prisma7-pg',
  cliPath: fileURLToPath(new URL('./node_modules/prisma/build/index.js', import.meta.url)),
  env: { DATABASE_URL: url.toString() },
  pushArgs: ['--accept-data-loss'],
  dbSystem: 'postgres',
  makeClient: async () => {
    // O adapter do pg não lê o ?schema= da URL: vai como opção, e o search_path cobre o SQL cru.
    const { PrismaClient } = await import('@prisma/client');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const conn = new URL(process.env.CC_SMOKE_PG_URL);
    conn.searchParams.set('options', `-c search_path=${schemaName}`);
    return new PrismaClient({ adapter: new PrismaPg({ connectionString: conn.toString() }, { schema: schemaName }) });
  },
  sdk,
  createStackTracePrismaQueryExtension,
});
