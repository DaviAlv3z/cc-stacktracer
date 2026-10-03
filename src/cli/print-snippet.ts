/**
 * Snippet de inicialização por stack detectada.
 *
 * **Divergir da tela de integrações é pior que não ter snippet:** o dev compara os dois, vê
 * diferença, e para de confiar em ambos. A forma canônica é a de `integrations.snippets.init` nos
 * locales — `StackTrace.auto` com as três variáveis de ambiente —, e é dela que estes derivam.
 *
 * Quando não há stack detectada o snippet cai no genérico, que funciona em qualquer runtime Node.
 * Nunca inventa um campo de framework por palpite.
 */
import type { DbStack, DetectedStack, HttpStack } from './detect-stack.js';

const IMPORT_LINE = "import { StackTrace } from 'cc-stacktracer';";

const ENV_LINES = [
  '  apiKey: process.env.STACKTRACE_API_KEY!,',
  '  serviceId: process.env.STACKTRACE_SERVICE_ID!,',
  '  endpoint: process.env.STACKTRACE_ENDPOINT!,',
];

/** `auto` conecta Fastify, Prisma e Lucid e roda os hooks na ordem certa — é o caminho recomendado. */
function autoBlock(extra: string[]): string {
  return ['await StackTrace.auto({', ...ENV_LINES, ...extra, '});'].join('\n');
}

function httpExtra(http: HttpStack | null): string[] {
  switch (http) {
    case 'fastify':
      return ['', '  fastify: app, // registra o plugin HTTP e instrumenta toda requisicao'];
    case 'adonis':
      // O Adonis não entrega a app no boot: o middleware vai em start/kernel.ts, e o erro no handler.
      return [
        '',
        "  // Adonis: em start/kernel.ts, server.use([() => import('cc-stacktracer/adonis/middleware'), ...])",
        '  // e, no report() do exception handler, StackTrace.recordRequestError(error)',
      ];
    case 'express':
      return [
        '',
        "  // Express: import { stacktraceExpressMiddleware, stacktraceErrorMiddleware } from 'cc-stacktracer/express'",
        '  // app.use(stacktraceExpressMiddleware()) ANTES das rotas e app.use(stacktraceErrorMiddleware()) DEPOIS delas',
      ];
    case 'nestjs':
      // O Nest trata a exceção nos próprios filtros, antes do Express: sem o filtro, o 5xx não vira evento.
      return [
        '',
        '  // NestJS: em main.ts, antes do NestFactory.create; depois nestApp.use(stacktraceExpressMiddleware()) (cc-stacktracer/express)',
        '  // e um filtro global @Catch() que chama StackTrace.recordRequestError(exception) antes do super.catch()',
      ];
    default:
      return [];
  }
}

/** Campos de banco que entram no próprio `auto`. */
function dbAutoExtra(db: DbStack | null): string[] {
  return db === 'lucid' ? ["  lucid: db, // import db from '@adonisjs/lucid/services/db' — span de toda query"] : [];
}

function dbHint(db: DbStack | null): string[] {
  switch (db) {
    case 'prisma':
      return [
        '',
        '// Prisma: a extensão oficial instrumenta toda operação como span `db`.',
        "import { createStackTracePrismaQueryExtension } from 'cc-stacktracer/db-prisma';",
        "const prisma = new PrismaClient().$extends(createStackTracePrismaQueryExtension({ dbSystem: 'postgres' }));",
      ];
    case 'lucid':
      return [];
    default:
      return [
        '',
        '// Sem ORM reconhecido: envolva as queries importantes para gerar spans `db`.',
        "await StackTrace.runQuery('postgres', 'users.findByEmail', () => findByEmail(email), { table: 'users' });",
      ];
  }
}

export function buildInitSnippet(stack: Pick<DetectedStack, 'http' | 'db'>): string {
  return [IMPORT_LINE, '', autoBlock([...httpExtra(stack.http), ...dbAutoExtra(stack.db)]), ...dbHint(stack.db)].join(
    '\n',
  );
}

/**
 * Mensagem quando o `package.json` do diretório atual não declara dependência nenhuma.
 *
 * É o caso do monorepo: rodar na raiz de um repo com workspaces encontra zero dependências, e sem
 * esta frase o dev leria "stack não reconhecida" num projeto Fastify e concluiria que o CLI não
 * funciona. A promessa de "nunca adivinha em silêncio" cobre o palpite errado E a omissão.
 */
export function emptyPackageJsonHint(cwd: string): string {
  return [
    `No dependencies found in ${cwd}/package.json.`,
    'If this is a monorepo, run the doctor inside the application package — the root manifest',
    'does not declare the framework and ORM this check looks for.',
  ].join('\n');
}

/** Mais de uma stack HTTP presente: diz quais e deixa o dev escolher, em vez de decidir por ele. */
export function ambiguousStackHint(chosen: HttpStack, others: HttpStack[]): string {
  return [
    `More than one HTTP stack found: ${[chosen, ...others].join(', ')}.`,
    `The snippet below assumes ${chosen}. If that is not the one serving traffic, instrument the other instead.`,
  ].join('\n');
}
