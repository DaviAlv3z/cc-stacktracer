import { afterEach, describe, expect, it } from 'vitest';
import {
  StackTrace,
  beginOutboundSpan,
  endOutboundSpan,
  flush,
  init,
  setRootSpanAttributes,
  setTags,
  setUser,
  shutdown,
  withSpan,
  withTrace,
} from '../index.js';
import { endHttpRequest, runWithHttpContext, startHttpRequest } from '../generic-http/index.js';
import type { BatchTransportPayload, StackTraceInitOptions } from '../index.js';
import type { SdkSpanRow } from './span-payload.types.js';
import { resetScopeMetadata } from './scope-metadata.js';
import { resetRootSpanAttributes } from './root-span-attributes.js';

const SERVICE_ID = '00000000-0000-4000-8000-000000000001';

function setup(extra: Partial<StackTraceInitOptions> = {}): SdkSpanRow[] {
  const spans: SdkSpanRow[] = [];
  init({
    apiKey: 'k',
    endpoint: 'http://localhost:1',
    service: 'svc',
    environment: 'test',
    serviceId: SERVICE_ID,
    transport: async (p: BatchTransportPayload) => {
      if (p.kind === 'spans') spans.push(...p.spans);
    },
    ...extra,
  });
  return spans;
}

async function request(fn: () => Promise<void>, status = 200): Promise<void> {
  const trace = startHttpRequest({ method: 'GET', url: '/perfil', route: '/perfil' });
  await runWithHttpContext(trace, fn);
  endHttpRequest(trace, { statusCode: status });
  await flush();
}

afterEach(async () => {
  await shutdown();
  resetScopeMetadata();
  resetRootSpanAttributes();
});

describe('identityOnSpans', () => {
  it('desligado (padrão): nenhum span leva user.id nem subtenant', async () => {
    const spans = setup();
    await request(async () => {
      setUser({ id: 'u-1' });
      setTags({ subtenant: 'pm-peruibe' });
      await withSpan('negocio', async () => undefined);
    });
    expect(spans).toHaveLength(2);
    expect(JSON.stringify(spans)).not.toMatch(/u-1|pm-peruibe/);
  });

  it('ligado: o raiz (lido no fim) e os filhos criados depois do auth levam user.id e subtenant', async () => {
    const spans = setup({ identityOnSpans: true });
    await request(async () => {
      // A query do auth roda ANTES de a identidade existir.
      await withSpan('auth.query', async () => undefined, { type: 'db' });
      setUser({ id: 'u-1' });
      setTags({ subtenant: 'pm-peruibe' });
      await withSpan('negocio', async () => undefined);
      const out = beginOutboundSpan();
      if (out !== null) endOutboundSpan(out, { name: 'http.client GET api', type: 'external' });
    });
    const byName = Object.fromEntries(spans.map((s) => [s.span_name, s.attributes]));
    expect(byName['GET /perfil']).toMatchObject({ 'user.id': 'u-1', subtenant: 'pm-peruibe' });
    expect(byName['negocio']).toMatchObject({ 'user.id': 'u-1', subtenant: 'pm-peruibe' });
    expect(byName['http.client GET api']).toMatchObject({ 'user.id': 'u-1', subtenant: 'pm-peruibe' });
    expect(byName['auth.query']?.['user.id']).toBeUndefined();
  });

  it('atributo explícito vence a identidade do escopo', async () => {
    const spans = setup({ identityOnSpans: true });
    await request(async () => {
      setTags({ subtenant: 'pm-peruibe' });
      await withSpan('outro-cliente', async () => undefined, { attributes: { subtenant: 'pm-itanhaem' } });
    });
    expect(spans.find((s) => s.span_name === 'outro-cliente')?.attributes).toMatchObject({ subtenant: 'pm-itanhaem' });
  });

  it('withTrace: o raiz e os filhos do job levam a identidade do job, e ela não vaza depois', async () => {
    const spans = setup({ identityOnSpans: true });
    await withTrace('job.lote', async () => {
      setTags({ subtenant: 'pm-peruibe' });
      await withSpan('passo', async () => undefined);
    });
    await request(async () => {
      await withSpan('requisicao-seguinte', async () => undefined);
    });
    const byName = Object.fromEntries(spans.map((s) => [s.span_name, s.attributes]));
    expect(byName['job.lote']).toMatchObject({ subtenant: 'pm-peruibe' });
    expect(byName['passo']).toMatchObject({ subtenant: 'pm-peruibe' });
    expect(byName['requisicao-seguinte']?.subtenant).toBeUndefined();
    expect(byName['GET /perfil']?.subtenant).toBeUndefined();
  });
});

describe('setRootSpanAttributes', () => {
  it('no raiz HTTP: mescla, remove com undefined, não troca coluna nem a identidade do SDK', async () => {
    const spans = setup();
    let dentro: boolean | undefined;
    await request(async () => {
      dentro = setRootSpanAttributes({ plano: 'premium', descartar: 'x', http_route: '/invasor', 'process.pid': 1 });
      await withSpan('filho', async () => {
        // De um span filho, ainda é o raiz.
        StackTrace.setRootSpanAttributes({ descartar: undefined, 'feature.nova_tela': true });
      });
    });
    expect(dentro).toBe(true);
    const root = spans.find((s) => s.span_type === 'http')!;
    expect(root.http_route).toBe('/perfil');
    expect(root.attributes).toMatchObject({ plano: 'premium', 'feature.nova_tela': true, 'process.pid': process.pid });
    expect(root.attributes).not.toHaveProperty('descartar');
    expect(root.attributes).not.toHaveProperty('http_route');
    expect(spans.find((s) => s.span_name === 'filho')?.attributes ?? {}).not.toHaveProperty('plano');
  });

  it('identityOnSpans + setRootSpanAttributes: o explícito vence', async () => {
    const spans = setup({ identityOnSpans: true });
    await request(async () => {
      setTags({ subtenant: 'pm-peruibe' });
      setRootSpanAttributes({ subtenant: 'pm-sede' });
    });
    expect(spans.find((s) => s.span_type === 'http')?.attributes).toMatchObject({ subtenant: 'pm-sede' });
  });

  it('fora de requisição/job, ou depois de o raiz sair: false, e nada quebra', async () => {
    setup();
    expect(setRootSpanAttributes({ a: 1 })).toBe(false);
    const trace = startHttpRequest({ method: 'GET', url: '/x', route: '/x' });
    let depois: (() => boolean) | undefined;
    await runWithHttpContext(trace, async () => {
      depois = () => setRootSpanAttributes({ tarde: true });
    });
    endHttpRequest(trace, { statusCode: 200 });
    expect(depois?.()).toBe(false);
  });

  it('no raiz do withTrace', async () => {
    const spans = setup();
    await withTrace(
      'job.importacao',
      async () => {
        setRootSpanAttributes({ 'job.lote': 17 });
      },
      { attributes: { 'job.origem': 'cron' } },
    );
    await flush();
    expect(spans.find((s) => s.span_name === 'job.importacao')?.attributes).toMatchObject({
      'job.lote': 17,
      'job.origem': 'cron',
    });
  });
});

describe('StackTrace: withTrace, beginOutboundSpan e endOutboundSpan no objeto (3.4)', () => {
  it('existem e são as mesmas funções dos exports nomeados', () => {
    expect(StackTrace.withTrace).toBe(withTrace);
    expect(StackTrace.beginOutboundSpan).toBe(beginOutboundSpan);
    expect(StackTrace.endOutboundSpan).toBe(endOutboundSpan);
    expect(StackTrace.setRootSpanAttributes).toBe(setRootSpanAttributes);
  });
});
