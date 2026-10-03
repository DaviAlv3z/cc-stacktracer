import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush, init, log, shutdown } from '../index.js';
import type { BatchTransportPayload } from '../index.js';
import { IngestTransportError } from './transport/ingest-transport-error.js';

const SERVICE_ID = '00000000-0000-4000-8000-000000000001';
const base = { apiKey: 'k', endpoint: 'http://ingest.test', service: 's', environment: 'test', serviceId: SERVICE_ID };

function messages(sent: BatchTransportPayload[]): string[] {
  return sent.flatMap((p) =>
    p.kind === 'batch' ? p.events.map((e) => String((e as { message?: unknown }).message)) : [],
  );
}

/** 503 na primeira chamada e sucesso depois: a fila entra no backoff (1 s ou mais). */
function failOnce(sent: BatchTransportPayload[]): (p: BatchTransportPayload) => Promise<void> {
  let calls = 0;
  return async (p) => {
    calls += 1;
    if (calls === 1) throw new IngestTransportError({ status: 503 });
    sent.push(p);
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdown();
});

describe('o que o app pede explicitamente não espera o backoff (A)', () => {
  it('shutdown() entrega depois de uma falha passageira', async () => {
    const sent: BatchTransportPayload[] = [];
    init({ ...base, transport: failOnce(sent) });
    log('evento 1');
    await flush();
    log('evento 2');
    await shutdown();
    expect(messages(sent)).toEqual(['evento 1', 'evento 2']);
  });

  it('flush() também', async () => {
    const sent: BatchTransportPayload[] = [];
    init({ ...base, transport: failOnce(sent) });
    log('evento 1');
    await flush();
    log('evento 2');
    await flush();
    expect(messages(sent)).toEqual(['evento 1', 'evento 2']);
  });
});

describe('init() de novo', () => {
  it('entrega o que o cliente anterior tinha na fila, pela configuração dele', async () => {
    const first: BatchTransportPayload[] = [];
    init({ ...base, transport: async (p) => void first.push(p) });
    log('do primeiro cliente');
    init({ ...base, transport: async () => undefined });
    await vi.waitFor(() => expect(messages(first)).toEqual(['do primeiro cliente']));
  });
});
