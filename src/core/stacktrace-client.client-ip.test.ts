import { describe, expect, it } from 'vitest';
import { createStackTraceClient } from '../index.js';

const base = {
  apiKey: 'k',
  serviceId: '11111111-1111-4111-8111-111111111111',
  endpoint: 'https://ingest.example.com',
};

describe('StackTraceClient.getClientIpOptions', () => {
  it('padrao: desligado, socket, 1 proxy confiavel', () => {
    expect(createStackTraceClient(base).getClientIpOptions()).toEqual({
      enabled: false,
      header: undefined,
      trustedProxies: 1,
    });
  });

  it('resolve a opcao do init, com o nome do header em minusculas', () => {
    const client = createStackTraceClient({
      ...base,
      clientIp: { enabled: true, header: ' X-Forwarded-For ', trustedProxies: 2 },
    });
    expect(client.getClientIpOptions()).toEqual({ enabled: true, header: 'x-forwarded-for', trustedProxies: 2 });
  });
});
