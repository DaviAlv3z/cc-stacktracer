// Gera os cenários NestJS do consumer-smoke: um app Nest real (compilado com tsc), que sobe, recebe o roteiro HTTP
// e é encerrado por SIGTERM pelos shutdown hooks do Nest. As quatro pastas compartilham o app; muda o adaptador,
// o TypeScript e o tsconfig. Uso: node consumer-smoke/tools/make-nest-scenarios.mjs (recria as pastas nest*).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = join(import.meta.dirname, '..', 'scenarios');

const SMOKE = `import { spawn } from 'node:child_process';
import { startReceiver } from '../lib/receiver.mjs';
import { createCheck } from '../lib/check.mjs';
import { checkHttpTelemetry, runHttpScript } from '../lib/http-script.mjs';

// variant: 'record' (o filtro da 3.3) ou 'capture' (o filtro que o painel ensinava até a 3.2).
const [main, variant = 'record'] = process.argv.slice(2);
const check = createCheck(\`\${process.env.npm_package_name}:\${variant}\`);
const receiver = await startReceiver();
const child = spawn(process.execPath, [main], {
  env: { ...process.env, STACKTRACE_ENDPOINT: receiver.url, FILTER: variant },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const port = await new Promise((resolve, reject) => {
  child.stdout.on('data', (d) => {
    out += d;
    const m = /LISTENING (\\d+)/.exec(out);
    if (m) resolve(Number(m[1]));
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  child.on('exit', (c) => reject(new Error(\`app saiu antes de ouvir (\${c}): \${out}\`)));
});
const statuses = await runHttpScript(\`http://127.0.0.1:\${port}\`);
// Fim como o orquestrador faz: SIGTERM. Os shutdown hooks do Nest chamam StackTrace.shutdown().
const ended = new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? signal)));
child.kill('SIGTERM');
const how = await ended;
check.ok(how === 0 || how === 'SIGTERM', \`app encerrou pelo SIGTERM (\${how}); saída: \${out.trim().slice(-400)}\`);
checkHttpTelemetry(check, receiver, statuses);
await receiver.close();
check.done();
`;

const CONTROLLER = `import { Controller, Get, Param } from '@nestjs/common';
import { StackTrace } from 'cc-stacktracer';

@Controller()
export class AppController {
  @Get('users/:id')
  async user(@Param('id') id: string): Promise<{ ok: boolean }> {
    StackTrace.setUser({ id: \`u-\${id}\` });
    await new Promise((resolve) => setTimeout(resolve, 5 + (Number(id) % 7) * 3));
    StackTrace.log(\`user \${id}\`);
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('boom');
  }
}
`;

const FILTER = `import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { StackTrace } from 'cc-stacktracer';

/** O Nest trata a exceção nos filtros, antes do Express/Fastify: a borda HTTP do SDK não a vê. */
@Catch()
export class StackTraceExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (process.env.FILTER === 'capture') {
      // O que o painel ensinava até a 3.2: o span raiz do 500 saía sem error_type, e o evento com status 0.
      const status = exception instanceof HttpException ? exception.getStatus() : 500;
      if (status >= 500 && exception instanceof Error) StackTrace.captureException(exception);
    } else {
      // A resposta decide: 5xx vira evento e vai para o span raiz; 4xx, não.
      StackTrace.recordRequestError(exception);
    }
    super.catch(exception, host);
  }
}
`;

const SHUTDOWN = `import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { StackTrace } from 'cc-stacktracer';

/** Com app.enableShutdownHooks(): no SIGTERM o Nest fecha a app e chama isto antes de sair. */
@Injectable()
export class StackTraceShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await StackTrace.shutdown();
  }
}
`;

const MODULE = `import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { StackTraceShutdown } from './stacktrace.shutdown';

@Module({ controllers: [AppController], providers: [StackTraceShutdown] })
export class AppModule {}
`;

const MAIN_EXPRESS = `import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { StackTrace } from 'cc-stacktracer';
import { stacktraceExpressMiddleware } from 'cc-stacktracer/express';
import { AppModule } from './app.module';
import { StackTraceExceptionFilter } from './stacktrace.filter';

async function bootstrap(): Promise<void> {
  // Antes do NestFactory.create.
  await StackTrace.auto({
    apiKey: 'k',
    serviceId: '11111111-1111-4111-8111-111111111111',
    endpoint: process.env.STACKTRACE_ENDPOINT ?? '',
    enableGlobalHandlers: true,
  });
  const app = await NestFactory.create(AppModule, { logger: false });
  app.use(stacktraceExpressMiddleware());
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new StackTraceExceptionFilter(httpAdapter));
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  console.log(\`LISTENING \${(app.getHttpServer().address() as { port: number }).port}\`);
}
void bootstrap();
`;

const MAIN_FASTIFY = `import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { StackTrace } from 'cc-stacktracer';
import stacktracePlugin from 'cc-stacktracer/fastify';
import { AppModule } from './app.module';
import { StackTraceExceptionFilter } from './stacktrace.filter';

async function bootstrap(): Promise<void> {
  await StackTrace.auto({
    apiKey: 'k',
    serviceId: '11111111-1111-4111-8111-111111111111',
    endpoint: process.env.STACKTRACE_ENDPOINT ?? '',
    enableGlobalHandlers: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
  await app.register(stacktracePlugin);
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new StackTraceExceptionFilter(httpAdapter));
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  console.log(\`LISTENING \${(app.getHttpServer().address() as { port: number }).port}\`);
}
void bootstrap();
`;

// O tsconfig que o Nest CLI 12 gera (@nestjs/schematics 12): nodenext, projeto CommonJS.
const TSCONFIG_NEST12 = {
  compilerOptions: {
    module: 'nodenext',
    moduleResolution: 'nodenext',
    resolvePackageJsonExports: true,
    esModuleInterop: true,
    isolatedModules: true,
    declaration: true,
    removeComments: true,
    emitDecoratorMetadata: true,
    experimentalDecorators: true,
    allowSyntheticDefaultImports: true,
    target: 'ES2023',
    types: ['node'],
    sourceMap: true,
    outDir: './dist',
    rootDir: '.',
    skipLibCheck: true,
    strict: true,
    strictPropertyInitialization: false,
  },
  include: ['src'],
};
// O tsconfig que o Nest CLI 11 gera (@nestjs/schematics 11.1): nodenext, CommonJS. rootDir/include só para o
// build sair em dist/src, como nos outros cenários.
const TSCONFIG_NEST11 = {
  compilerOptions: {
    module: 'nodenext',
    moduleResolution: 'nodenext',
    resolvePackageJsonExports: true,
    esModuleInterop: true,
    isolatedModules: true,
    declaration: true,
    removeComments: true,
    emitDecoratorMetadata: true,
    experimentalDecorators: true,
    allowSyntheticDefaultImports: true,
    target: 'ES2023',
    sourceMap: true,
    outDir: './dist',
    rootDir: '.',
    baseUrl: './',
    skipLibCheck: true,
    strictNullChecks: true,
    forceConsistentCasingInFileNames: true,
    noImplicitAny: false,
    strictBindCallApply: false,
    noFallthroughCasesInSwitch: false,
  },
  include: ['src'],
};
// NestJS 10/11 antigos: commonjs sem moduleResolution (= node10 no TS 5.x). Só resolve os subpaths com typesVersions.
const TSCONFIG_LEGACY = {
  compilerOptions: {
    module: 'commonjs',
    declaration: true,
    removeComments: true,
    emitDecoratorMetadata: true,
    experimentalDecorators: true,
    allowSyntheticDefaultImports: true,
    target: 'ES2021',
    sourceMap: true,
    outDir: './dist',
    rootDir: '.',
    baseUrl: './',
    skipLibCheck: true,
    strictNullChecks: false,
    noImplicitAny: false,
    types: ['node'],
  },
  include: ['src'],
};

function nest(name, { deps, tsconfig, main }) {
  const dir = join(base, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  const pkg = {
    name: `smoke-${name}`,
    private: true,
    // Sem "type": projeto CommonJS, como o que o Nest CLI gera. O SDK chega por require() de ESM.
    scripts: {
      smoke: 'tsc -p . && node smoke.mjs dist/src/main.js record',
      'smoke:painel-3.2': 'tsc -p . && node smoke.mjs dist/src/main.js capture',
    },
    dependencies: deps,
    smoke: { minNode: '20.19.0', requireEsm: true, timeoutMs: 240000 },
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`);
  writeFileSync(join(dir, 'smoke.mjs'), SMOKE);
  writeFileSync(join(dir, 'src', 'main.ts'), main);
  writeFileSync(join(dir, 'src', 'app.controller.ts'), CONTROLLER);
  writeFileSync(join(dir, 'src', 'stacktrace.filter.ts'), FILTER);
  writeFileSync(join(dir, 'src', 'stacktrace.shutdown.ts'), SHUTDOWN);
  writeFileSync(join(dir, 'src', 'app.module.ts'), MODULE);
}

const common12 = { '@nestjs/common': '^12.1.2', '@nestjs/core': '^12.1.2', 'reflect-metadata': '^0.2.2', rxjs: '^7.8.1', '@types/node': '^22.10.0' };
nest('nest12-express', {
  deps: { ...common12, '@nestjs/platform-express': '^12.1.2', '@types/express': '^5.0.0', typescript: '^6.0.2' },
  tsconfig: TSCONFIG_NEST12,
  main: MAIN_EXPRESS,
});
nest('nest12-express-ts7', {
  deps: { ...common12, '@nestjs/platform-express': '^12.1.2', '@types/express': '^5.0.0', typescript: '7.0.2' },
  tsconfig: TSCONFIG_NEST12,
  main: MAIN_EXPRESS,
});
// NestJS 11 com o template do CLI 11 e o TypeScript mínimo que compila CommonJS + ESM (5.8; o template pede
// ^5.7.3, e o 5.7 dá TS1479 — a doc da 3.3 diz "TypeScript 5.8+").
nest('nest11-express', {
  deps: {
    '@nestjs/common': '^11.1.6',
    '@nestjs/core': '^11.1.6',
    '@nestjs/platform-express': '^11.1.6',
    'reflect-metadata': '^0.2.2',
    rxjs: '^7.8.1',
    '@types/node': '^22.10.0',
    '@types/express': '^5.0.0',
    typescript: '~5.8.3',
  },
  tsconfig: TSCONFIG_NEST11,
  main: MAIN_EXPRESS,
});
nest('nest12-fastify', {
  deps: { ...common12, '@nestjs/platform-fastify': '^12.1.2', typescript: '^6.0.2' },
  tsconfig: TSCONFIG_NEST12,
  main: MAIN_FASTIFY,
});
nest('nest10-legacy', {
  deps: {
    '@nestjs/common': '^10.4.19',
    '@nestjs/core': '^10.4.19',
    '@nestjs/platform-express': '^10.4.19',
    'reflect-metadata': '^0.2.2',
    rxjs: '^7.8.1',
    '@types/node': '^20.14.0',
    '@types/express': '^4.17.21',
    typescript: '~5.4.5',
  },
  tsconfig: TSCONFIG_LEGACY,
  main: MAIN_EXPRESS,
});
console.log('cenários NestJS gerados em', base);
