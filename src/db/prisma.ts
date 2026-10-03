import { runQuery } from '../performance/measure.js';
import type { StackTracePlugin } from '../core/plugins/types.js';

type PrismaMiddlewareParams = {
  model?: string;
  action: string;
};

type PrismaMiddlewareClient = {
  $use?: (
    middleware: (
      params: PrismaMiddlewareParams,
      next: (params: PrismaMiddlewareParams) => Promise<unknown>,
    ) => Promise<unknown>,
  ) => void;
};

type PrismaExtensionOperation = {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
};

export type StackTracePrismaExtensionOptions = {
  /**
   * Engine real do banco (`postgres`, `mysql`, `sqlserver`, `sqlite`) — o `db_system` do span. Sem a
   * opção o span sai com `prisma`, como até a 3.2, para não quebrar o histórico de quem já usa.
   */
  dbSystem?: string;
};

/**
 * Prisma Client extension for DB spans (Prisma 4.16+ client extensions).
 *
 * The extension is returned as a plain Prisma extension object on purpose:
 * importing `cc-stacktracer/db-prisma` must not require `@prisma/client` unless
 * the application itself already uses Prisma and passes this object to `$extends`.
 */
export function createStackTracePrismaQueryExtension(options: StackTracePrismaExtensionOptions = {}) {
  const system = options.dbSystem ?? 'prisma';
  return {
    name: 'cc-stacktracer-query',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: PrismaExtensionOperation) {
          const table = model !== undefined && model !== '' ? model : 'raw';
          return runQuery(system, `${table}.${operation}`, () => query(args), {
            table,
            sqlVerb: operation,
            leaf: true,
          });
        },
      },
      $executeRaw: async ({ args, query }: PrismaExtensionOperation) =>
        runQuery(system, '$executeRaw', () => query(args), { table: 'raw', sqlVerb: 'EXECUTE', leaf: true }),
      $executeRawUnsafe: async ({ args, query }: PrismaExtensionOperation) =>
        runQuery(system, '$executeRawUnsafe', () => query(args), { table: 'raw', sqlVerb: 'EXECUTE', leaf: true }),
      $queryRaw: async ({ args, query }: PrismaExtensionOperation) =>
        runQuery(system, '$queryRaw', () => query(args), { table: 'raw', sqlVerb: 'SELECT', leaf: true }),
      $queryRawUnsafe: async ({ args, query }: PrismaExtensionOperation) =>
        runQuery(system, '$queryRawUnsafe', () => query(args), { table: 'raw', sqlVerb: 'SELECT', leaf: true }),
    },
  };
}

/**
 * Registers legacy Prisma middleware (`prisma.$use`) when available.
 * On Prisma 6+, `$use` does not exist; use {@link createStackTracePrismaQueryExtension}.
 */
export function createPrismaStackTracePlugin(prisma: PrismaMiddlewareClient): StackTracePlugin {
  return {
    name: 'db-prisma',
    type: 'db',
    init() {
      if (typeof prisma.$use === 'function') {
        prisma.$use(async (params: PrismaMiddlewareParams, next: (p: PrismaMiddlewareParams) => Promise<unknown>) => {
          const model = params.model ?? 'raw';
          const action = String(params.action);
          return runQuery('prisma', `${model}.${action}`, () => next(params), {
            table: model,
            sqlVerb: action,
            leaf: true,
          });
        });
        return;
      }

      // Em qualquer ambiente: em produção o silêncio escondia que nenhuma query virava span.
      console.warn(
        "[cc-stacktracer] Prisma 6.14+ removed prisma.$use(). Instrument DB queries with Client Extensions: `new PrismaClient().$extends(createStackTracePrismaQueryExtension({ dbSystem: 'postgres' }))`. See `cc-stacktracer/db-prisma`.",
      );
    },
  };
}
