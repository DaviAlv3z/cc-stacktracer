/**
 * `db_parameters`: os bindings da query, mascarados. O SQL vai em `db_statement` com placeholders; os valores
 * nunca saem crus.
 *
 * - `masked`: mantém o que ajuda a achar o registro — número, booleano, `null`, UUID — e troca o resto pelo tipo e
 *   tamanho (`[string:11]`, `[date]`, `[binary:512]`).
 * - `types`: só tipo e tamanho, números inclusive (para schema que guarda CPF ou telefone como número).
 * - `off`: não envia o atributo.
 */
export type DbParametersMode = 'off' | 'types' | 'masked';

/** Bulk insert pode ter milhares de bindings. */
export const MAX_DB_PARAMETERS = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MaskedDbParameter = string | number | boolean | null;

function describe(value: unknown, mode: Exclude<DbParametersMode, 'off'>): MaskedDbParameter {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return mode === 'masked' && Number.isFinite(value) ? value : '[number]';
  if (typeof value === 'bigint') return mode === 'masked' ? value.toString() : '[number]';
  if (typeof value === 'string') return mode === 'masked' && UUID.test(value) ? value : `[string:${value.length}]`;
  if (value instanceof Date) return '[date]';
  if (Buffer.isBuffer(value)) return `[binary:${value.length}]`;
  if (Array.isArray(value)) return `[array:${value.length}]`;
  return '[object]';
}

/** `undefined` quando não há o que enviar. Nunca lança. */
export function maskDbParameters(bindings: unknown, mode: DbParametersMode): MaskedDbParameter[] | undefined {
  try {
    if (mode === 'off' || !Array.isArray(bindings) || bindings.length === 0) return undefined;
    const out = bindings.slice(0, MAX_DB_PARAMETERS).map((value) => describe(value, mode));
    if (bindings.length > MAX_DB_PARAMETERS) out.push(`[+${bindings.length - MAX_DB_PARAMETERS}]`);
    return out;
  } catch {
    return undefined;
  }
}
