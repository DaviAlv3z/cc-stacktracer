import { afterEach, describe, expect, it } from 'vitest';
import {
  captureException,
  endHttpRequest,
  flush,
  init,
  recordRequestError,
  runWithHttpContext,
  shutdown,
  startHttpRequest,
  StackTrace,
} from '../index.js';
import type { BatchTransportPayload, StackTraceEvent } from '../index.js';
import type { SdkSpanRow } from './span-payload.types.js';
import { normalizeEventV4 } from '../shared/schema/index.js';
import { toWirePayloadForIngest } from './wire-event.js';

const SERVICE_ID = '00000000-0000-4000-8000-000000000001';

function setup(opts: { errorTracking?: boolean } = {}): { events: StackTraceEvent[]; spans: SdkSpanRow[] } {
  const events: StackTraceEvent[] = [];
  const spans: SdkSpanRow[] = [];
  init({
    apiKey: 'k',
    endpoint: 'http://localhost:1',
    service: 's',
    environment: 'test',
    serviceId: SERVICE_ID,
    ...(opts.errorTracking !== undefined ? { errorTracking: opts.errorTracking } : {}),
    transport: async (p: BatchTransportPayload) => {
      if (p.kind === 'batch') events.push(...p.events);
      if (p.kind === 'spans') spans.push(...p.spans);
    },
  });
  return { events, spans };
}

const wire = (e: StackTraceEvent) => normalizeEventV4(toWirePayloadForIngest(e), { serviceId: SERVICE_ID });

/**
 * O Adonis trata a excecao DENTRO do `next()`: o `report()` do exception handler roda no contexto da
 * requisicao, e o `next()` resolve normalmente. Aqui, o `catch` faz o papel do exception handler.
 */
async function requestHandledByFramework(status: number, error: Error, onReport = recordRequestError) {
  const req = startHttpRequest({ method: 'GET', url: '/users/42', route: '/users/:id', headers: {} });
  await runWithHttpContext(req, async () => {
    try {
      throw error;
    } catch (err) {
      onReport(err);
    }
  });
  endHttpRequest(req, { statusCode: status });
  await flush();
}

afterEach(async () => {
  await shutdown();
});

describe('recordRequestError', () => {
  it('um 5xx vira UM evento, com o status final, e o span raiz leva a excecao', async () => {
    const { events, spans } = setup();
    await requestHandledByFramework(500, new TypeError('boom'));

    expect(events).toHaveLength(1);
    const event = wire(events[0]!);
    expect(event.error?.type).toBe('TypeError');
    expect(event.metadata.http!.status_code).toBe(500);
    expect(event.metadata.http!.route).toBe('/users/:id');
    const root = spans.find((s) => s.span_type === 'http')!;
    expect(root.status).toBe('error');
    expect(root.error_type).toBe('TypeError');
    expect(root.error_message).toBe('boom');
    expect(event.trace.span_id).toBe(root.span_id);
  });

  it('um 4xx nao vira evento nem marca o span raiz', async () => {
    const { events, spans } = setup();
    await requestHandledByFramework(404, new Error('not found'));

    expect(events).toHaveLength(0);
    const root = spans.find((s) => s.span_type === 'http')!;
    expect(root.status).toBe('ok');
    expect(root.error_type).toBeNull();
  });

  it('com captureException no mesmo erro continua sendo um evento so', async () => {
    const { events, spans } = setup();
    await requestHandledByFramework(500, new Error('boom'), (err) => {
      captureException(err as Error, { orderId: '7' });
      recordRequestError(err);
    });

    expect(events).toHaveLength(1);
    expect(spans.find((s) => s.span_type === 'http')!.error_type).toBe('Error');
  });

  it('com o Error Tracking desligado nao envia evento, mas o span raiz ainda leva a excecao', async () => {
    const { events, spans } = setup({ errorTracking: false });
    await requestHandledByFramework(503, new Error('down'));

    expect(events).toHaveLength(0);
    expect(spans.find((s) => s.span_type === 'http')!.error_message).toBe('down');
  });

  it('fora de requisicao o erro sai na hora, como captureException', async () => {
    const { events } = setup();
    StackTrace.recordRequestError(new Error('cli'));
    await flush();

    expect(events).toHaveLength(1);
    expect(wire(events[0]!).error?.message).toBe('cli');
  });

  it('depois de a resposta fechar o erro sai na hora, em vez de ficar preso numa raiz fechada', async () => {
    const { events } = setup();
    const req = startHttpRequest({ method: 'GET', url: '/late', headers: {} });
    let late: (() => void) | undefined;
    await runWithHttpContext(req, async () => {
      late = () => recordRequestError(new Error('late'));
    });
    endHttpRequest(req, { statusCode: 200 });
    await runWithHttpContext(req, async () => late!());
    await flush();

    expect(events.map((e) => wire(e).error?.message)).toEqual(['late']);
  });

  it('ignora o que nao e Error e nunca lanca', async () => {
    const { events } = setup();
    expect(() => recordRequestError('texto')).not.toThrow();
    expect(() => recordRequestError(undefined)).not.toThrow();
    await flush();
    expect(events).toHaveLength(0);
  });
});
