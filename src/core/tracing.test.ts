import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSdkRuntime } from './client-ref.js';
import { parseStackTraceInit } from './config.schema.js';
import { StackTraceClient } from './stacktrace-client.js';
import { getTraceIdFromContext, runWithTraceContext } from './trace-span-context.js';
import { withBusinessContext, withBusinessContextAsync } from './business-context.js';
import { beginOutboundSpan, endOutboundSpan, endSpan, startSpan, withSpan, withTrace } from './tracing.js';
import { resetErrorTrackingState } from './error-tracking.js';
import type { SdkSpanRow } from './span-payload.types.js';
import { resetFailOpenState } from './safe-run.js';
import { getScopeContextForMerge, resetScopeMetadata, setTags, setUser } from './scope-metadata.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

function setupClient(): StackTraceClient {
  const config = parseStackTraceInit({
    apiKey: 'k',
    serviceId,
    service: 'svc',
    environment: 'prod',
    endpoint: 'https://ingest.example.com',
    sendMode: 'immediate',
    transport: vi.fn().mockResolvedValue(undefined),
  });
  const client = new StackTraceClient(config);
  setSdkRuntime(client, { service: { name: 'svc', version: '1', environment: 'prod' }, environment: 'prod' });
  return client;
}

describe('span business-context attribute merge', () => {
  afterEach(() => {
    setSdkRuntime(null, null);
  });

  it('merges active business context (entity/operation) into withSpan attributes, alongside promoted db_* columns', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    const root = randomUUID();

    await runWithTraceContext('trace-biz-1', root, async () => {
      await withBusinessContextAsync({ entity: 'invoice', operation: 'invoices.approve' }, async () => {
        await withSpan('invoices.update', async () => undefined, {
          type: 'db',
          attributes: { db_table: 'invoices' },
        });
      });
    });

    expect(enqueueSpan).toHaveBeenCalledTimes(1);
    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.db_table).toBe('invoices');
    expect(row.attributes).toEqual({ entity: 'invoice', operation: 'invoices.approve' });
  });

  it('does not add business attributes when no business context is active', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    const root = randomUUID();

    await runWithTraceContext('trace-biz-2', root, async () => {
      await withSpan('plain.query', async () => undefined, { type: 'db', attributes: { db_table: 'invoices' } });
    });

    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.db_table).toBe('invoices');
    expect(row.attributes).toBeNull();
  });

  it('lets explicit span attributes win over business context on key collision', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    const root = randomUUID();

    await runWithTraceContext('trace-biz-3', root, async () => {
      await withBusinessContextAsync({ entity: 'invoice', operation: 'invoices.approve' }, async () => {
        await withSpan('invoices.custom', async () => undefined, {
          type: 'business',
          attributes: { operation: 'invoices.custom-override' },
        });
      });
    });

    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.attributes).toEqual({ entity: 'invoice', operation: 'invoices.custom-override' });
  });

  it('also merges business context into startSpan/endSpan (handle-based) spans', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    const root = randomUUID();

    await runWithTraceContext('trace-biz-4', root, () => {
      withBusinessContext({ entity: 'order', operation: 'orders.ship' }, () => {
        const handle = startSpan('orders.ship.step', { type: 'business' });
        endSpan(handle);
      });
    });

    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.attributes).toEqual({ entity: 'order', operation: 'orders.ship' });
  });
});

describe('withTrace', () => {
  it('abre um trace novo fora de qualquer requisição e emite o span raiz', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    await withTrace('job.reprocessa-holerites', () => {
      expect(getTraceIdFromContext()).toMatch(/^[0-9a-f]{32}$/);
    });
    expect(enqueueSpan).toHaveBeenCalledTimes(1);
    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.span_name).toBe('job.reprocessa-holerites');
    expect(row.span_type).toBe('service');
    expect(row.parent_span_id).toBeNull();
    expect(row.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('dentro de um trace ativo vira um span filho — não abre um segundo trace', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    await runWithTraceContext('0af7651916cd43dd8448eb211c80319c', 'aaaaaaaaaaaaaaaa', async () => {
      await withTrace('job.interno', () => {});
    });
    expect(enqueueSpan).toHaveBeenCalledTimes(1);
    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(row.parent_span_id).toBe('aaaaaaaaaaaaaaaa');
  });

  it('propaga a exceção e marca o span como erro', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    await expect(
      withTrace('job.quebra', () => {
        throw new Error('falhou');
      }),
    ).rejects.toThrow('falhou');
    const row = enqueueSpan.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.status).toBe('error');
  });

  it('withSpan dentro de withTrace vira filho do span raiz, no mesmo trace', async () => {
    const client = setupClient();
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    await withTrace('job.importa-folha', async () => {
      await withSpan('folha.valida-matriculas', () => {}, { type: 'business' });
    });

    expect(enqueueSpan).toHaveBeenCalledTimes(2);
    const rows = enqueueSpan.mock.calls.map((c) => c[0] as SdkSpanRow);
    const child = rows.find((r) => r.span_name === 'folha.valida-matriculas');
    const root = rows.find((r) => r.span_name === 'job.importa-folha');

    expect(root?.parent_span_id).toBeNull();
    expect(child?.parent_span_id).toBe(root?.span_id);
    expect(child?.trace_id).toBe(root?.trace_id);
    expect(child?.span_type).toBe('business');
  });
});

describe('fail-open: a telemetria nunca muda o que a app vê', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setSdkRuntime(null, null);
    resetFailOpenState();
  });

  function throwingClient(): StackTraceClient {
    const client = setupClient();
    vi.spyOn(client, 'enqueueSpan').mockImplementation(() => {
      throw new Error('telemetry boom');
    });
    return client;
  }

  it('withSpan devolve o resultado de um fn bem-sucedido mesmo se emitir o span lançar', async () => {
    throwingClient();
    const fn = vi.fn(async () => 'charged');
    await runWithTraceContext('trace-fo-1', 'aaaaaaaaaaaaaaaa', async () => {
      await expect(withSpan('billing.charge', fn)).resolves.toBe('charged');
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withSpan relança o MESMO objeto de erro mesmo se emitir o span também lançar', async () => {
    throwingClient();
    const appError = new Error('card declined');
    await runWithTraceContext('trace-fo-2', 'aaaaaaaaaaaaaaaa', async () => {
      await expect(
        withSpan('billing.charge', () => {
          throw appError;
        }),
      ).rejects.toBe(appError);
    });
  });

  it('withSpan mantém a cadeia de pais depois de uma emissão que falhou', async () => {
    const client = setupClient();
    const enqueue = vi.spyOn(client, 'enqueueSpan').mockImplementationOnce(() => {
      throw new Error('telemetry boom');
    });
    await runWithTraceContext('trace-fo-3', 'aaaaaaaaaaaaaaaa', async () => {
      await withSpan('first', async () => undefined);
      await withSpan('second', async () => undefined);
    });
    const second = enqueue.mock.calls[1]?.[0] as SdkSpanRow;
    expect(second.span_name).toBe('second');
    expect(second.parent_span_id).toBe('aaaaaaaaaaaaaaaa');
  });

  it('withTrace devolve o resultado do job mesmo se emitir o span lançar', async () => {
    throwingClient();
    await expect(withTrace('job.sync', async () => 7)).resolves.toBe(7);
  });

  it('withTrace relança o erro do job pela identidade', async () => {
    throwingClient();
    const jobError = new Error('job failed');
    await expect(
      withTrace('job.sync', () => {
        throw jobError;
      }),
    ).rejects.toBe(jobError);
  });

  it('startSpan().end nunca lança e é idempotente', async () => {
    const client = throwingClient();
    await runWithTraceContext('trace-fo-4', 'aaaaaaaaaaaaaaaa', () => {
      const handle = startSpan('step');
      expect(() => {
        handle.end();
        handle.end();
      }).not.toThrow();
    });
    expect(client.enqueueSpan).toHaveBeenCalledTimes(1);
  });

  it('error.message que não é string não derruba o span nem troca o erro', async () => {
    const client = setupClient();
    const enqueue = vi.spyOn(client, 'enqueueSpan');
    const weird = Object.assign(new Error(), { message: { code: 42 } as unknown as string });
    await runWithTraceContext('trace-fo-5', 'aaaaaaaaaaaaaaaa', async () => {
      await expect(
        withSpan('x', () => {
          throw weird;
        }),
      ).rejects.toBe(weird);
    });
    const row = enqueue.mock.calls[0]?.[0] as SdkSpanRow;
    expect(row.status).toBe('error');
    expect(row.error_message).toBeNull();
  });

  it('com STACKTRACE_DISABLED, withSpan só executa fn', async () => {
    const client = setupClient();
    const enqueue = vi.spyOn(client, 'enqueueSpan');
    vi.stubEnv('STACKTRACE_DISABLED', '1');
    resetFailOpenState();
    await runWithTraceContext('trace-fo-6', 'aaaaaaaaaaaaaaaa', async () => {
      await expect(withSpan('x', async () => 1)).resolves.toBe(1);
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('error tracking nos spans (3.0)', () => {
  beforeEach(() => resetErrorTrackingState());
  afterEach(() => {
    setSdkRuntime(null, null);
  });

  type EventWithTrace = { message: string; context?: { trace?: { span_id?: string } } };
  const eventsOf = (enqueue: { mock: { calls: unknown[][] } }): EventWithTrace[] =>
    enqueue.mock.calls.map(([e]) => e as EventWithTrace);

  it('job do signa-pro: o erro sobe SELECT -> getMany -> job e vira UM evento, no span do job', async () => {
    const client = setupClient();
    const enqueue = vi.spyOn(client, 'enqueue');
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');
    const err = new Error('S3 nao configurado');

    await expect(
      withTrace('job.expire-a3-signing-sessions', () =>
        withSpan(
          'globalSetting.getMany',
          () =>
            withSpan(
              'Lucid.global_settings.select',
              () => {
                throw err;
              },
              { type: 'db' },
            ),
          { type: 'db' },
        ),
      ),
    ).rejects.toBe(err);

    const root = enqueueSpan.mock.calls.map(([r]) => r as SdkSpanRow).find((r) => r.parent_span_id === null);
    expect(eventsOf(enqueue)).toHaveLength(1);
    expect(eventsOf(enqueue)[0]).toMatchObject({
      message: 'S3 nao configurado',
      context: { trace: { span_id: root?.span_id } },
    });
  });

  it('erro tratado dentro de um withSpan: o job termina bem e o erro sai no span que falhou', async () => {
    const client = setupClient();
    const enqueue = vi.spyOn(client, 'enqueue');
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');

    await withTrace('job.fallback', async () => {
      try {
        await withSpan('db.query', () => {
          throw new Error('tabela faltando');
        });
      } catch {
        // fallback do app
      }
    });

    const failed = enqueueSpan.mock.calls.map(([r]) => r as SdkSpanRow).find((r) => r.span_name === 'db.query');
    expect(eventsOf(enqueue)).toHaveLength(1);
    expect(eventsOf(enqueue)[0]).toMatchObject({
      message: 'tabela faltando',
      context: { trace: { span_id: failed?.span_id } },
    });
  });

  it('sucesso: nenhum evento', async () => {
    const client = setupClient();
    const enqueue = vi.spyOn(client, 'enqueue');
    await withTrace('job.ok', () => withSpan('q', async () => 1));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('erro por status numa chamada de saida marca o span, mas nao vira evento', async () => {
    const client = setupClient();
    const enqueue = vi.spyOn(client, 'enqueue');
    const enqueueSpan = vi.spyOn(client, 'enqueueSpan');

    await withTrace('job.calls-api', async () => {
      const begin = beginOutboundSpan();
      if (begin === null) throw new Error('sem trace');
      endOutboundSpan(begin, {
        name: 'GET api.example.com',
        err: Object.assign(new Error('HTTP 503'), { name: 'HttpError' }),
        errorFromStatus: true,
      });
    });

    const outbound = enqueueSpan.mock.calls
      .map(([r]) => r as SdkSpanRow)
      .find((r) => r.span_name === 'GET api.example.com');
    expect(outbound?.status).toBe('error');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('withTrace — escopo proprio', () => {
  // Até a 3.3.0 o job rodava sem escopo: setUser/setTags dentro dele gravavam no escopo GLOBAL do processo, e
  // as requisições seguintes saíam com o usuário e o subtenant do job.
  it('setUser e setTags dentro do job nao vazam para fora dele', async () => {
    resetScopeMetadata();
    let dentro: Record<string, unknown> | undefined;
    await withTrace('job.lote', () => {
      setUser({ id: 'usuario-do-job' });
      setTags({ subtenant: 'cliente-do-job' });
      dentro = getScopeContextForMerge();
    });
    expect(dentro).toMatchObject({ user: { id: 'usuario-do-job' }, tags: { subtenant: 'cliente-do-job' } });
    expect(getScopeContextForMerge()).toBeUndefined();
  });
});
