import { describe, expect, it } from 'vitest';
import { getScopeContextForMerge, resetScopeMetadata, runWithScope, setUser, tag } from './scope-metadata.js';

describe('scope-metadata sob concorrencia', () => {
  it('nao mistura usuario entre dois escopos simultaneos', async () => {
    resetScopeMetadata();

    const capture = async (id: string, delayMs: number): Promise<unknown> =>
      runWithScope(async () => {
        setUser({ id });
        await new Promise((r) => setTimeout(r, delayMs));
        return (getScopeContextForMerge() as { user?: { id: string } } | undefined)?.user?.id;
      });

    const [a, b] = await Promise.all([capture('user-a', 20), capture('user-b', 1)]);

    expect(a).toBe('user-a');
    expect(b).toBe('user-b');
  });

  it('nao mistura tags entre dois escopos simultaneos', async () => {
    resetScopeMetadata();

    const capture = async (value: string, delayMs: number): Promise<unknown> =>
      runWithScope(async () => {
        tag('tenant', value);
        await new Promise((r) => setTimeout(r, delayMs));
        return (getScopeContextForMerge() as { tags?: Record<string, string> } | undefined)?.tags?.tenant;
      });

    const [a, b] = await Promise.all([capture('peruibe', 20), capture('itanhaem', 1)]);

    expect(a).toBe('peruibe');
    expect(b).toBe('itanhaem');
  });

  it('mantem o fallback global fora de qualquer escopo (worker, script, boot)', () => {
    resetScopeMetadata();
    tag('deploy', 'nightly');
    expect((getScopeContextForMerge() as { tags?: Record<string, string> } | undefined)?.tags?.deploy).toBe('nightly');
  });

  // O escopo nasce herdando o que ja estava no fallback: um `tag()` de boot (versao, regiao, host)
  // precisa continuar valendo dentro da requisicao. E a escrita dentro do escopo NAO pode voltar
  // para o fallback, senao o vazamento so mudaria de lugar.
  it('herda o fallback ao abrir, sem escrever de volta nele', () => {
    resetScopeMetadata();
    tag('regiao', 'sa-east-1');

    const dentro = runWithScope(() => {
      tag('requisicao', 'r-1');
      return getScopeContextForMerge() as { tags?: Record<string, string> } | undefined;
    });

    expect(dentro?.tags?.regiao).toBe('sa-east-1');
    expect(dentro?.tags?.requisicao).toBe('r-1');

    const fora = getScopeContextForMerge() as { tags?: Record<string, string> } | undefined;
    expect(fora?.tags?.regiao).toBe('sa-east-1');
    expect(fora?.tags?.requisicao).toBeUndefined();
  });

  // Até a 3.3.0 o escopo novo herdava o USUÁRIO do fallback: um job que chamou setUser fora de requisição
  // atribuía o usuário dele a toda requisição seguinte, anônimas inclusive.
  it('nao herda o usuario do fallback ao abrir um escopo novo', () => {
    resetScopeMetadata();
    setUser({ id: 'usuario-do-job' });

    const dentro = runWithScope(() => getScopeContextForMerge() as { user?: { id: string } } | undefined);

    expect(dentro?.user).toBeUndefined();
    resetScopeMetadata();
  });

  it('escopo aninhado herda o usuario do escopo pai', () => {
    resetScopeMetadata();
    const aninhado = runWithScope(() => {
      setUser({ id: 'u-1' });
      return runWithScope(() => getScopeContextForMerge() as { user?: { id: string } } | undefined);
    });
    expect(aninhado?.user?.id).toBe('u-1');
  });
});
