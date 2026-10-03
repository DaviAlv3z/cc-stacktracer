import { afterEach, describe, it, expect, vi } from 'vitest';
import { parseStackTraceInit, stackTraceInitSchema } from './config.schema.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

describe('parseStackTraceInit', () => {
  afterEach(() => {
    delete process.env.STACKTRACE_CAPTURE_POLICY_REFRESH_MS;
    vi.restoreAllMocks();
  });

  it('parses minimal valid config and applies defaults', () => {
    const parsed = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
    });
    expect(parsed.sendMode).toBe('batch');
    expect(parsed.enableGlobalHandlers).toBe(false);
    expect(parsed.apiKey).toBe('k');
    expect(parsed.serviceId).toBe(serviceId);
  });

  it('accepts the minimal service identity contract', () => {
    const parsed = parseStackTraceInit({
      apiKey: 'key',
      serviceId,
      endpoint: 'http://localhost:3000',
    });

    expect(parsed.apiKey).toBe('key');
    expect(parsed.serviceId).toBe(serviceId);
    expect(parsed.endpoint).toBe('http://localhost:3000');
    expect(parsed.service).toBe('service-11111111');
    expect(parsed.environment).toBe(process.env.NODE_ENV ?? 'production');
  });

  it('still rejects invalid serviceId in minimal config', () => {
    expect(() =>
      parseStackTraceInit({
        apiKey: 'key',
        serviceId: 'not-a-uuid',
        endpoint: 'http://localhost:3000',
      }),
    ).toThrow(/serviceId must be a service UUID/);
  });

  it('rejects missing serviceId', () => {
    expect(() =>
      stackTraceInitSchema.parse({
        apiKey: 'k',
        service: 'svc',
        environment: 'prod',
        endpoint: 'https://ingest.example.com',
      }),
    ).toThrow(/serviceId/i);
  });

  it('rejects invalid serviceId', () => {
    expect(() =>
      stackTraceInitSchema.parse({
        apiKey: 'k',
        serviceId: 'holerite-web',
        service: 'svc',
        environment: 'prod',
        endpoint: 'https://ingest.example.com',
      }),
    ).toThrow();
  });

  it('rejects missing apiKey', () => {
    expect(() =>
      stackTraceInitSchema.parse({
        serviceId,
        service: 'svc',
        environment: 'prod',
        endpoint: 'https://ingest.example.com',
      }),
    ).toThrow();
  });

  it('rejects tenantId without projectId', () => {
    expect(() =>
      stackTraceInitSchema.parse({
        apiKey: 'k',
        serviceId,
        service: 'svc',
        environment: 'prod',
        endpoint: 'https://ingest.example.com',
        tenantId: '11111111-1111-4111-a111-111111111111',
      }),
    ).toThrow();
  });

  it('rejects endpoint with ingest path segment', () => {
    expect(() =>
      stackTraceInitSchema.parse({
        apiKey: 'k',
        serviceId,
        service: 'svc',
        environment: 'prod',
        endpoint: 'https://ingest.example.com/v1/events',
      }),
    ).toThrow(/endpoint must be the ingest service base URL/i);
  });

  it('parses URL redaction extra sensitive query keys', () => {
    const parsed = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      urlRedaction: {
        extraSensitiveQueryKeys: ['custom_secret'],
      },
    });

    expect(parsed.urlRedaction?.extraSensitiveQueryKeys).toEqual(['custom_secret']);
  });

  it('normalizes sub-minute capture policy refresh intervals to the safe minimum', () => {
    const warn = vi.fn();
    const parsed = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      capturePolicyRefreshMs: 10,
      logger: { warn },
    });

    expect(parsed.capturePolicyRefreshMs).toBe(60_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        configKey: 'capturePolicyRefreshMs',
        inputMs: 10,
        normalizedMs: 60_000,
        minMs: 60_000,
      }),
      '[cc-stacktracer] capturePolicyRefreshMs below minimum. Using 60000ms.',
    );
  });

  it('keeps zero capture policy refresh interval disabled', () => {
    const parsed = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      capturePolicyRefreshMs: 0,
    });

    expect(parsed.capturePolicyRefreshMs).toBe(0);
  });

  it('reads STACKTRACE_CAPTURE_POLICY_REFRESH_MS when the option is omitted', () => {
    process.env.STACKTRACE_CAPTURE_POLICY_REFRESH_MS = '59999';
    const warn = vi.fn();

    const parsed = parseStackTraceInit({
      apiKey: 'k',
      serviceId,
      service: 'svc',
      environment: 'prod',
      endpoint: 'https://ingest.example.com',
      logger: { warn },
    });

    expect(parsed.capturePolicyRefreshMs).toBe(60_000);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(['abc', '1.5', '-1', 'NaN', 'Infinity'])(
    'rejects invalid STACKTRACE_CAPTURE_POLICY_REFRESH_MS value %s',
    (value) => {
      process.env.STACKTRACE_CAPTURE_POLICY_REFRESH_MS = value;

      expect(() =>
        parseStackTraceInit({
          apiKey: 'k',
          serviceId,
          service: 'svc',
          environment: 'prod',
          endpoint: 'https://ingest.example.com',
        }),
      ).toThrow(/STACKTRACE_CAPTURE_POLICY_REFRESH_MS/);
    },
  );
});

describe('opcoes do Error Tracking', () => {
  const base = { apiKey: 'k', serviceId, endpoint: 'https://ingest.example.com' };

  it('aceita errorTracking e faixas validas', () => {
    const parsed = parseStackTraceInit({
      ...base,
      errorTracking: false,
      httpServerErrorStatuses: '500-599,429',
      httpClientErrorStatuses: '400-599',
    });
    expect(parsed.errorTracking).toBe(false);
    expect(parsed.httpServerErrorStatuses).toBe('500-599,429');
    expect(parsed.httpClientErrorStatuses).toBe('400-599');
  });

  it('rejeita faixa invalida na opcao, com a dica do formato', () => {
    expect(() => parseStackTraceInit({ ...base, httpServerErrorStatuses: '5xx' })).toThrow(/100 to 599/);
    expect(() => parseStackTraceInit({ ...base, httpClientErrorStatuses: '500-' })).toThrow(/100 to 599/);
  });
});

describe('opcao clientIp', () => {
  const base = { apiKey: 'k', serviceId, endpoint: 'https://ingest.example.com' };

  it('aceita clientIp com header e trustedProxies', () => {
    const parsed = parseStackTraceInit({
      ...base,
      clientIp: { enabled: true, header: 'x-forwarded-for', trustedProxies: 2 },
    });
    expect(parsed.clientIp).toEqual({ enabled: true, header: 'x-forwarded-for', trustedProxies: 2 });
    expect(parseStackTraceInit({ ...base, clientIp: {} }).clientIp).toEqual({});
  });

  it('rejeita trustedProxies 0 e nao inteiro', () => {
    expect(() => parseStackTraceInit({ ...base, clientIp: { enabled: true, trustedProxies: 0 } })).toThrow(
      /trustedProxies/,
    );
    expect(() => parseStackTraceInit({ ...base, clientIp: { enabled: true, trustedProxies: 1.5 } })).toThrow(
      /trustedProxies/,
    );
  });

  it('rejeita header vazio e chave desconhecida dentro de clientIp', () => {
    expect(() => parseStackTraceInit({ ...base, clientIp: { enabled: true, header: ' ' } })).toThrow(/header/);
    expect(() => parseStackTraceInit({ ...base, clientIp: { enabled: true, trustProxy: true } })).toThrow(/trustProxy/);
  });
});
