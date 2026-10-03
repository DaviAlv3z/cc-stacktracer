import { afterEach, describe, expect, it, vi } from 'vitest';
import { init, log, shutdown, withTrace } from '../index.js';

const SERVICE_ID = '00000000-0000-4000-8000-000000000001';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

/** Ingestão que aceita a conexão e nunca responde: o envio só termina quando o sinal aborta. */
function hangingFetch(calls: { path: string; aborted: boolean }[]): typeof fetch {
  return ((url: string, requestInit: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const call = { path: new URL(String(url)).pathname, aborted: false };
      calls.push(call);
      requestInit.signal?.addEventListener('abort', () => {
        call.aborted = true;
        reject(requestInit.signal?.reason);
      });
    })) as unknown as typeof fetch;
}

describe('prazo do shutdown com ingestão pendurada', () => {
  it('cancela o envio pendurado no prazo e não começa o envio dos spans', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls: { path: string; aborted: boolean }[] = [];
    globalThis.fetch = hangingFetch(calls);
    const onTransportError = vi.fn();
    init({
      apiKey: 'k',
      endpoint: 'http://ingest.test',
      service: 's',
      environment: 'test',
      serviceId: SERVICE_ID,
      onTransportError,
    });
    log('antes do shutdown');
    await withTrace('job', async () => undefined);
    const done = shutdown();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(calls).toEqual([{ path: '/v1/events', aborted: true }]);
    expect(onTransportError).not.toHaveBeenCalled();
  });
});
