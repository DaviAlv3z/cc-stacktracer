import { describe, expect, it } from 'vitest';
import { resolveClientIp, type ResolvedClientIpOptions } from './client-ip.js';

const SOCKET = '10.0.0.2';

function on(header?: string, trustedProxies = 1): ResolvedClientIpOptions {
  return { enabled: true, header, trustedProxies };
}

describe('resolveClientIp', () => {
  it.each<
    [string, ResolvedClientIpOptions | undefined, Record<string, string>, string | undefined, string | undefined]
  >([
    ['desligado: nada, nem o socket', undefined, {}, SOCKET, undefined],
    ['enabled false: nada', { enabled: false, header: undefined, trustedProxies: 1 }, {}, SOCKET, undefined],
    ['sem header: o socket', on(), {}, '127.0.0.1', '127.0.0.1'],
    ['sem header: o socket IPv6', on(), {}, '::1', '::1'],
    ['sem header: socket IPv6 mapeado vira IPv4', on(), {}, '::ffff:127.0.0.1', '127.0.0.1'],
    ['sem header e sem socket: nada', on(), {}, undefined, undefined],
    ['sem header: ignora o XFF', on(), { 'x-forwarded-for': '1.1.1.1' }, SOCKET, SOCKET],
    ['XFF, 1 proxy', on('x-forwarded-for'), { 'x-forwarded-for': '203.0.113.7' }, SOCKET, '203.0.113.7'],
    ['XFF, 2 proxies', on('x-forwarded-for', 2), { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, SOCKET, '203.0.113.7'],
    [
      'XFF forjado: a entrada da esquerda e do cliente, nao do proxy',
      on('x-forwarded-for'),
      { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' },
      SOCKET,
      '203.0.113.7',
    ],
    [
      'XFF com mais proxies confiaveis que saltos: a entrada mais a esquerda',
      on('x-forwarded-for', 3),
      { 'x-forwarded-for': '203.0.113.7' },
      SOCKET,
      '203.0.113.7',
    ],
    [
      'XFF sem socket conhecido: a contagem nao muda',
      on('x-forwarded-for'),
      { 'x-forwarded-for': '1.1.1.1, 203.0.113.7' },
      undefined,
      '203.0.113.7',
    ],
    ['XFF com IPv6 mapeado', on('x-forwarded-for'), { 'x-forwarded-for': '::ffff:203.0.113.7' }, SOCKET, '203.0.113.7'],
    ['XFF com porta', on('x-forwarded-for'), { 'x-forwarded-for': '203.0.113.7:5678' }, SOCKET, '203.0.113.7'],
    [
      'XFF IPv6 com colchetes e porta',
      on('x-forwarded-for'),
      { 'x-forwarded-for': '[2001:db8::1]:443' },
      SOCKET,
      '2001:db8::1',
    ],
    ['XFF IPv6 com colchetes sem porta', on('x-forwarded-for'), { 'x-forwarded-for': '[::1]' }, SOCKET, '::1'],
    ['XFF com lixo: omitido', on('x-forwarded-for'), { 'x-forwarded-for': 'unknown' }, SOCKET, undefined],
    [
      'XFF com lixo na posicao escolhida: omitido, sem cair em outra entrada',
      on('x-forwarded-for'),
      { 'x-forwarded-for': '203.0.113.7, garbage' },
      SOCKET,
      undefined,
    ],
    ['XFF vazio: omitido', on('x-forwarded-for'), { 'x-forwarded-for': ' ' }, SOCKET, undefined],
    ['header configurado e ausente: omitido, sem cair no socket', on('x-forwarded-for'), {}, SOCKET, undefined],
    ['x-real-ip: o valor dele', on('x-real-ip'), { 'x-real-ip': '198.51.100.4' }, SOCKET, '198.51.100.4'],
    [
      'cf-connecting-ip: o valor dele',
      on('cf-connecting-ip'),
      { 'cf-connecting-ip': '2001:db8::7' },
      SOCKET,
      '2001:db8::7',
    ],
    [
      'header de valor unico com lista: omitido',
      on('x-real-ip'),
      { 'x-real-ip': '1.1.1.1, 2.2.2.2' },
      SOCKET,
      undefined,
    ],
    ['nome do header sem diferenca de caixa', on('X-Real-IP'), { 'X-REAL-IP': '198.51.100.4' }, SOCKET, '198.51.100.4'],
    ['mais de 64 caracteres: omitido', on('x-real-ip'), { 'x-real-ip': `${'a'.repeat(70)}::1` }, SOCKET, undefined],
  ])('%s', (_name, options, headers, socketAddress, expected) => {
    expect(resolveClientIp(options, { headers, socketAddress })).toBe(expected);
  });
});
