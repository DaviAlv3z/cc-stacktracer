/**
 * Detecta a stack pelo `package.json` do projeto do cliente.
 *
 * Quando não reconhece, devolve `null` e o CLI cai no caminho genérico — **nunca adivinha em
 * silêncio**, porque snippet errado custa mais caro que snippet ausente: o dev cola, não funciona, e
 * agora ele não confia nem no CLI nem no SDK.
 *
 * Função pura de propósito: quem lê o disco é o entrypoint. Assim isto é testável sem fixture de
 * sistema de arquivos, e o mesmo mapa serve ao `doctor` e a qualquer outra superfície que precise
 * reconhecer a stack.
 */

export type HttpStack = 'nestjs' | 'fastify' | 'express' | 'adonis';
export type DbStack = 'prisma' | 'lucid';

/**
 * Pacote que identifica cada stack. A ordem importa: é a precedência quando mais de um casa, e a
 * ambiguidade é reportada em `ambiguous` em vez de resolvida por chute.
 */
const HTTP_MARKERS: ReadonlyArray<readonly [HttpStack, string]> = [
  // Primeiro: um app NestJS traz express ou fastify junto, e o snippet certo é o do Nest.
  ['nestjs', '@nestjs/core'],
  ['fastify', 'fastify'],
  ['adonis', '@adonisjs/core'],
  ['express', 'express'],
];

const DB_MARKERS: ReadonlyArray<readonly [DbStack, string]> = [
  ['prisma', '@prisma/client'],
  ['lucid', '@adonisjs/lucid'],
];

export type PackageJsonLike = {
  dependencies?: Record<string, string> | undefined;
  devDependencies?: Record<string, string> | undefined;
  /** `"module"` para projeto ESM; ausente (ou `"commonjs"`) para CommonJS. */
  type?: string | undefined;
};

export type DetectedStack = {
  http: HttpStack | null;
  db: DbStack | null;
  /**
   * `true` quando o `package.json` não declara dependência nenhuma.
   *
   * Distingue **"não reconheci nada"** de **"não havia nada para reconhecer"** — e a diferença é
   * inteira num monorepo: rodar na raiz de um repo com workspaces encontra zero dependências, e sem
   * este sinal o CLI sugeriria o snippet genérico em vez de dizer "rode dentro do pacote da
   * aplicação".
   */
  empty: boolean;
  /** Stacks HTTP que casaram além da escolhida. Vazio no caso normal. */
  ambiguous: HttpStack[];
};

function allDeps(pkg: PackageJsonLike): Record<string, string> {
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

export function detectStack(pkg: PackageJsonLike): DetectedStack {
  const deps = allDeps(pkg);
  const present = (name: string): boolean => Object.prototype.hasOwnProperty.call(deps, name);

  const httpMatches = HTTP_MARKERS.filter(([, marker]) => present(marker)).map(([stack]) => stack);
  const db = DB_MARKERS.find(([, marker]) => present(marker))?.[0] ?? null;

  return {
    http: httpMatches[0] ?? null,
    db,
    empty: Object.keys(deps).length === 0,
    ambiguous: httpMatches.slice(1),
  };
}
