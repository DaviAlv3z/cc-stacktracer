// Como um app NestJS/TS compilado para CommonJS carrega o SDK: require() de ESM (Node 20.19+/22.12+).
const failures = [];
function load(id, check) {
  try {
    if (!check(require(id))) failures.push(`${id}: export esperado ausente`);
  } catch (err) {
    failures.push(`${id}: ${err.code ?? ''} ${String(err.message).split('\n')[0]}`);
  }
}
load('cc-stacktracer', (m) => typeof m.StackTrace?.init === 'function');
load('cc-stacktracer/express', (m) => typeof m.stacktraceExpressMiddleware === 'function');
load('cc-stacktracer/fastify', (m) => typeof m.default === 'function');
load('cc-stacktracer/generic-http', (m) => typeof m.startHttpRequest === 'function');
load('cc-stacktracer/adonis/middleware', (m) => typeof m.default === 'function');
load('cc-stacktracer/db-lucid', (m) => typeof m.createLucidStackTracePlugin === 'function');
load('cc-stacktracer/db-prisma', (m) => typeof m.createStackTracePrismaQueryExtension === 'function');
if (failures.length > 0) {
  console.error(`FAIL cjs-require\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('PASS cjs-require');
