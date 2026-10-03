import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush, init, log, shutdown } from '../../index.js';
import { createDeliveryWarnings } from './delivery-warnings.js';
import { DeliveryCancelled } from './delivery-cancelled.js';
import { IngestTransportError } from './ingest-transport-error.js';

const SERVICE_ID = '00000000-0000-4000-8000-000000000001';

describe('createDeliveryWarnings', () => {
  const setup = () => {
    const lines: string[] = [];
    const report = createDeliveryWarnings({ endpoint: 'https://ingest.example.com', warn: (m) => lines.push(m) });
    return { lines, report };
  };

  it('um aviso por tipo, com o host e o caminho do doctor', () => {
    const { lines, report } = setup();
    report({ count: 3, reason: 'rejected', error: new IngestTransportError({ status: 401 }) });
    report({ count: 1, reason: 'rejected', error: new IngestTransportError({ status: 401 }) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ingest.example.com');
    expect(lines[0]).toContain('HTTP 401');
    expect(lines[0]).toContain('npx cc-stacktracer doctor');
  });

  it('separa os tipos: auth, 404, lote rejeitado, inacessível e fila cheia', () => {
    const { lines, report } = setup();
    report({ count: 1, reason: 'rejected', error: new IngestTransportError({ status: 403 }) });
    report({ count: 1, reason: 'rejected', error: new IngestTransportError({ status: 404 }) });
    report({ count: 1, reason: 'rejected', error: new IngestTransportError({ status: 400 }) });
    report({ count: 1, reason: 'exhausted', error: new TypeError('fetch failed') });
    report({ count: 1, reason: 'overflow' });
    expect(lines).toHaveLength(5);
  });

  it('cancelamento pelo prazo do shutdown não é perda a avisar', () => {
    const { lines, report } = setup();
    report({ count: 1, reason: 'exhausted', error: new DeliveryCancelled() });
    expect(lines).toEqual([]);
  });
});

describe('cliente: aviso de perda', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await shutdown();
  });

  it('chave recusada (401) avisa uma vez, pelo console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    init({
      apiKey: 'k',
      endpoint: 'http://ingest.test',
      service: 's',
      environment: 'test',
      serviceId: SERVICE_ID,
      transport: async () => {
        throw new IngestTransportError({ status: 401 });
      },
    });
    log('a');
    log('b');
    await flush();
    log('c');
    await flush();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[cc-stacktracer]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('HTTP 401');
  });

  it('com logger configurado, o aviso vai para o logger', async () => {
    const loggerWarn = vi.fn();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    init({
      apiKey: 'k',
      endpoint: 'http://ingest.test',
      service: 's',
      environment: 'test',
      serviceId: SERVICE_ID,
      logger: { warn: loggerWarn },
      transport: async () => {
        throw new IngestTransportError({ status: 404 });
      },
    });
    log('a');
    await flush();
    expect(loggerWarn.mock.calls.filter((c) => String(c[1]).includes('404'))).toHaveLength(1);
    expect(consoleWarn.mock.calls.filter((c) => String(c[0]).includes('[cc-stacktracer]'))).toHaveLength(0);
  });

  it('falha que ainda vai ser retentada não avisa', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    init({
      apiKey: 'k',
      endpoint: 'http://ingest.test',
      service: 's',
      environment: 'test',
      serviceId: SERVICE_ID,
      transport: async () => {
        throw new IngestTransportError({ status: 503 });
      },
    });
    log('a');
    await flush();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[cc-stacktracer]'))).toHaveLength(0);
  });
});

describe('perda na saída e rejeição parcial (B)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(async () => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    await shutdown();
  });

  it('shutdown() com itens que não saíram avisa uma vez, com o último erro', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    init({
      apiKey: 'k',
      endpoint: 'http://ingest.test',
      service: 's',
      environment: 'test',
      serviceId: SERVICE_ID,
      transport: async () => {
        throw new IngestTransportError({ status: 503 });
      },
    });
    log('a');
    log('b');
    await shutdown();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[cc-stacktracer]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2 telemetry item(s) were still queued');
    expect(lines[0]).toContain('HTTP 503');
  });

  it('202 com rejectedIndexes avisa uma vez, com o motivo do servidor', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            accepted: 0,
            ids: [''],
            rejectedIndexes: [{ index: 0, message: 'service_id must belong to the API key project' }],
          },
        }),
        { status: 202 },
      )) as unknown as typeof fetch;
    init({ apiKey: 'k', endpoint: 'http://ingest.test', service: 's', environment: 'test', serviceId: SERVICE_ID });
    log('a');
    await flush();
    log('b');
    await flush();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('[cc-stacktracer]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('rejected 1 item(s)');
    expect(lines[0]).toContain('service_id must belong');
  });

  it('202 sem rejectedIndexes não avisa', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: true, data: { accepted: 1, ids: ['1-0'] } }), {
        status: 202,
      })) as unknown as typeof fetch;
    init({ apiKey: 'k', endpoint: 'http://ingest.test', service: 's', environment: 'test', serviceId: SERVICE_ID });
    log('a');
    await flush();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[cc-stacktracer]'))).toHaveLength(0);
  });

  it('separa unsent, partial e invalid dos demais tipos; contagem zero não avisa', () => {
    const lines: string[] = [];
    const report = createDeliveryWarnings({ endpoint: 'https://ingest.example.com', warn: (m) => lines.push(m) });
    report({ count: 2, reason: 'unsent' });
    report({ count: 1, reason: 'partial', detail: 'x' });
    report({ count: 1, reason: 'invalid', error: new Error('bad') });
    report({ count: 0, reason: 'unsent' });
    expect(lines).toHaveLength(3);
  });

  it('erro de fetch sem código diz a causa (ex.: bad port), e não só "fetch failed"', () => {
    const lines: string[] = [];
    const report = createDeliveryWarnings({ endpoint: 'https://ingest.example.com', warn: (m) => lines.push(m) });
    report({ count: 1, reason: 'exhausted', error: new TypeError('fetch failed', { cause: new Error('bad port') }) });
    expect(lines[0]).toContain('fetch failed (bad port)');
  });
});
