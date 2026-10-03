/**
 * O cc-stacktracer é ESM. Projeto CommonJS (o padrão do NestJS) só o carrega num Node com `require()` de
 * ES module sem flag; num Node anterior, o `require` derruba o boot com ERR_REQUIRE_ESM.
 */
export type ModuleFormatCheck = { ok: true; format: 'esm' | 'cjs' } | { ok: false; format: 'cjs'; nodeVersion: string };

/** `require()` de ESM sem flag: 20.19+ na linha 20, 22.12+ na 22, e toda versão a partir da 23. */
export function nodeSupportsRequireEsm(version: string): boolean {
  const [major = 0, minor = 0] = version
    .replace(/^v/u, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (major >= 23) return true;
  if (major === 22) return minor >= 12;
  if (major === 20) return minor >= 19;
  return false;
}

export function checkModuleFormat(pkg: { type?: unknown } | null, nodeVersion: string): ModuleFormatCheck {
  if (pkg?.type === 'module') return { ok: true, format: 'esm' };
  return nodeSupportsRequireEsm(nodeVersion) ? { ok: true, format: 'cjs' } : { ok: false, format: 'cjs', nodeVersion };
}
