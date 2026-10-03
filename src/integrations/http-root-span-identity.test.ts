import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createStackTraceClient } from '../index.js';
import { SDK_VERSION } from '../core/sdk-version.js';
import { redactHeaders } from '../utils/redact-headers.js';
import { httpRootSpanIdentity, withRootSpanAttributes } from './http-root-span-identity.js';

const serviceId = '11111111-1111-4111-8111-111111111111';

function clientWith(extra: Record<string, unknown> = {}) {
  return createStackTraceClient({
    apiKey: 'k',
    serviceId,
    endpoint: 'https://ingest.example.com',
    transport: async () => undefined,
    ...extra,
  });
}

/** Como as integracoes chamam: headers crus e o mapa redigido com o corte de 512 do snapshot. */
function identityOf(
  raw: Record<string, string>,
  params: { requestId?: string; socketAddress?: string; client?: ReturnType<typeof clientWith> | null } = {},
) {
  const client = params.client === undefined ? clientWith() : params.client;
  return httpRootSpanIdentity({
    client,
    rawHeaders: raw,
    headers: redactHeaders(raw, { maxValueLength: 512, ...client?.getHeaderRedactionOptions() }),
    requestId: params.requestId,
    socketAddress: params.socketAddress,
  });
}

const CONSTANTS = {
  'host.name': hostname(),
  'process.pid': process.pid,
  'telemetry.sdk.version': SDK_VERSION,
};

describe('httpRootSpanIdentity', () => {
  it('sem user-agent nem request id, ainda devolve as tres constantes', () => {
    expect(identityOf({})).toEqual(CONSTANTS);
  });

  it('com cliente ausente, ainda devolve as tres constantes', () => {
    expect(identityOf({ 'user-agent': 'curl/8' }, { client: null })).toEqual({
      ...CONSTANTS,
      'user_agent.original': 'curl/8',
    });
  });

  it('user-agent e request id', () => {
    expect(identityOf({ 'user-agent': 'Mozilla/5.0', 'x-request-id': 'req-1' }, { requestId: 'req-1' })).toEqual({
      ...CONSTANTS,
      'user_agent.original': 'Mozilla/5.0',
      'http.request_id': 'req-1',
    });
  });

  it('user-agent vazio fica de fora', () => {
    expect(identityOf({ 'user-agent': '' })).toEqual(CONSTANTS);
  });

  it('limites: user-agent 512 sem a reticencia do snapshot, request id 256', () => {
    const ua = 'u'.repeat(600);
    const id = 'r'.repeat(300);
    const out = identityOf({ 'user-agent': ua, 'x-request-id': id }, { requestId: id });
    expect(out?.['user_agent.original']).toBe('u'.repeat(512));
    expect(out?.['http.request_id']).toBe('r'.repeat(256));
  });

  it('client.address so com clientIp ligado', () => {
    expect(identityOf({}, { socketAddress: '::ffff:127.0.0.1' })).not.toHaveProperty('client.address');
    const on = clientWith({ clientIp: { enabled: true } });
    expect(identityOf({}, { socketAddress: '::ffff:127.0.0.1', client: on })?.['client.address']).toBe('127.0.0.1');
  });

  it('valor [REDACTED] nao sai: user-agent, header do request id e header do IP', () => {
    const client = clientWith({
      headerRedaction: { extraSensitiveKeys: ['user-agent', 'x-request-id', 'x-real-ip'] },
      clientIp: { enabled: true, header: 'x-real-ip' },
    });
    const out = identityOf(
      { 'user-agent': 'Mozilla/5.0', 'x-request-id': 'req-1', 'x-real-ip': '198.51.100.4' },
      { requestId: 'req-1', socketAddress: '10.0.0.2', client },
    );
    expect(out).toEqual(CONSTANTS);
  });

  it('request id vindo de outro header: so o header de onde ele veio decide a redacao', () => {
    const client = clientWith({ headerRedaction: { extraSensitiveKeys: ['x-correlation-id'] } });
    const out = identityOf({ 'x-request-id': 'req-1', 'x-correlation-id': 'corr-1' }, { requestId: 'req-1', client });
    expect(out?.['http.request_id']).toBe('req-1');
    const hidden = identityOf({ 'x-correlation-id': 'corr-1' }, { requestId: 'corr-1', client });
    expect(hidden).not.toHaveProperty('http.request_id');
  });

  it('falha ao ler a configuracao: devolve undefined e nao lanca', () => {
    const client = clientWith();
    client.getClientIpOptions = () => {
      throw new Error('boom');
    };
    expect(identityOf({ 'user-agent': 'x' }, { client })).toBeUndefined();
  });
});

describe('withRootSpanAttributes', () => {
  it('mescla a identidade com o url.path do balde [unmatched], sem perder nenhum dos dois', () => {
    const identity = identityOf({ 'user-agent': 'bot' });
    expect(withRootSpanAttributes(identity, { 'url.path': '/.env' })).toEqual({
      attributes: { ...CONSTANTS, 'user_agent.original': 'bot', 'url.path': '/.env' },
    });
  });

  it('sem nenhum dos dois, nao cria attributes', () => {
    expect(withRootSpanAttributes(undefined, undefined)).toEqual({});
    expect(withRootSpanAttributes(undefined, { 'url.path': '/x' })).toEqual({ attributes: { 'url.path': '/x' } });
  });
});
