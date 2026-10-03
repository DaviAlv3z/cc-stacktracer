import { describe, expect, it } from 'vitest';
import { detectStack } from './detect-stack.js';

describe('detectStack', () => {
  it('detecta fastify e prisma', () => {
    expect(detectStack({ dependencies: { fastify: '^5.0.0', '@prisma/client': '^6.0.0' } })).toMatchObject({
      http: 'fastify',
      db: 'prisma',
    });
  });

  it('detecta adonis e lucid', () => {
    expect(detectStack({ dependencies: { '@adonisjs/core': '^6.0.0', '@adonisjs/lucid': '^21.0.0' } })).toMatchObject({
      http: 'adonis',
      db: 'lucid',
    });
  });

  it('detecta express sem orm', () => {
    expect(detectStack({ dependencies: { express: '^4.0.0' } })).toMatchObject({ http: 'express', db: null });
  });

  it('olha devDependencies tambem', () => {
    expect(detectStack({ devDependencies: { fastify: '^5.0.0' } }).http).toBe('fastify');
  });

  it('devolve null quando nao reconhece — nunca adivinha', () => {
    expect(detectStack({ dependencies: { koa: '^2.0.0' } })).toMatchObject({ http: null, db: null });
  });

  it('nao quebra com package.json vazio', () => {
    expect(detectStack({})).toMatchObject({ http: null, db: null });
  });

  // Num repo com workspaces o package.json da raiz nao tem as dependencias da aplicacao. Sem
  // distinguir "nao reconheci" de "nao havia o que reconhecer", o CLI cairia no caminho generico
  // sem dizer por que — e o dev leria "stack nao reconhecida" num projeto Fastify.
  it('sinaliza package.json sem dependencia nenhuma', () => {
    expect(detectStack({}).empty).toBe(true);
    expect(detectStack({ dependencies: { koa: '^2.0.0' } }).empty).toBe(false);
  });

  // A precedencia e um palpite: um projeto com fastify E express nao tem resposta certa. Reportar
  // o empate deixa o CLI perguntar, em vez de escolher em silencio.
  it('reporta empate de stack HTTP em vez de escolher calado', () => {
    const out = detectStack({ dependencies: { fastify: '^5.0.0', express: '^4.0.0' } });
    expect(out.http).toBe('fastify');
    expect(out.ambiguous).toEqual(['express']);
  });

  it('sem empate, ambiguous vem vazio', () => {
    expect(detectStack({ dependencies: { fastify: '^5.0.0' } }).ambiguous).toEqual([]);
  });

  it('NestJS: @nestjs/core vence o express/fastify que vêm com ele', () => {
    const s = detectStack({
      dependencies: { '@nestjs/core': '^12.1.2', '@nestjs/platform-express': '^12.1.2', express: '^5.2.1' },
    });
    expect(s.http).toBe('nestjs');
  });
});
