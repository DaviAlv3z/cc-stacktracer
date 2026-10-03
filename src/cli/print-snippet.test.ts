import { describe, expect, it } from 'vitest';
import { ambiguousStackHint, buildInitSnippet, emptyPackageJsonHint } from './print-snippet.js';

describe('buildInitSnippet', () => {
  it('gera snippet de fastify + prisma com a extensão, e não o plugin $use', () => {
    const out = buildInitSnippet({ http: 'fastify', db: 'prisma' });
    expect(out).toContain("import { StackTrace } from 'cc-stacktracer'");
    expect(out).toContain('fastify: app');
    expect(out).toContain('$extends(createStackTracePrismaQueryExtension(');
    expect(out).not.toContain('createPrismaStackTracePlugin');
  });

  it('gera snippet de adonis + lucid que funciona: middleware de servidor, recordRequestError e lucid: db', () => {
    const out = buildInitSnippet({ http: 'adonis', db: 'lucid' });
    expect(out).toContain('cc-stacktracer/adonis/middleware');
    expect(out).toContain('recordRequestError');
    expect(out).toContain('lucid: db');
    expect(out).not.toContain('register(createLucidStackTracePlugin');
  });

  it('express traz o import e o error middleware, o único jeito de ver a exceção', () => {
    const out = buildInitSnippet({ http: 'express', db: null });
    expect(out).toContain('cc-stacktracer/express');
    expect(out).toContain('stacktraceErrorMiddleware');
  });

  it('nestjs ensina o middleware do Express e o filtro com recordRequestError', () => {
    const out = buildInitSnippet({ http: 'nestjs', db: null });
    expect(out).toContain('stacktraceExpressMiddleware');
    expect(out).toContain('recordRequestError');
    expect(out).not.toContain('captureException');
  });

  it('express aponta o middleware, e nao o campo fastify', () => {
    const out = buildInitSnippet({ http: 'express', db: null });
    expect(out).toContain('stacktraceExpressMiddleware');
    expect(out).not.toContain('fastify: app');
  });

  it('cai no generico quando nao detectou', () => {
    const out = buildInitSnippet({ http: null, db: null });
    expect(out).toContain('StackTrace.auto');
    expect(out).not.toContain('fastify:');
  });

  // Divergir da tela de integracoes e pior que nao ter snippet: o dev compara os dois, ve
  // diferenca, e para de confiar em ambos. A forma canonica e `StackTrace.auto` com as tres envs.
  it('usa a mesma forma canonica da tela: auto + as tres variaveis', () => {
    for (const stack of [
      { http: 'fastify' as const, db: 'prisma' as const },
      { http: null, db: null },
    ]) {
      const out = buildInitSnippet(stack);
      expect(out).toContain('await StackTrace.auto({');
      expect(out).toContain('process.env.STACKTRACE_API_KEY!');
      expect(out).toContain('process.env.STACKTRACE_SERVICE_ID!');
      expect(out).toContain('process.env.STACKTRACE_ENDPOINT!');
    }
  });

  it('sem ORM reconhecido, ensina runQuery em vez de omitir o banco', () => {
    expect(buildInitSnippet({ http: 'fastify', db: null })).toContain('StackTrace.runQuery');
  });
});

describe('mensagens de contexto', () => {
  it('package.json vazio explica o caso do monorepo, com o diretorio', () => {
    const hint = emptyPackageJsonHint('/repo');
    expect(hint).toContain('/repo/package.json');
    expect(hint).toMatch(/monorepo/i);
  });

  it('empate de stack diz quais e assume uma explicitamente', () => {
    const hint = ambiguousStackHint('fastify', ['express']);
    expect(hint).toContain('fastify, express');
    expect(hint).toMatch(/assumes fastify/i);
  });
});
