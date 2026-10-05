/**
 * O que o objeto de erro sabe e o evento não levava: o evento de erro tinha só `name`, `message` e `stack`. Um
 * 500 de banco chegava sem o SQLSTATE, a constraint ou o código do driver — e o `error_type` do `pg` é
 * `"error"`, o que não distingue nada.
 *
 * Tudo vira string: entra no evento como tag e no span de banco como atributo.
 *
 * Fora de propósito: `detail`/`where` do pg e `originalError` do mssql, que trazem VALORES
 * ("Key (email)=(fulano@x.com) already exists"), e a mensagem da `cause`.
 */

type Fields = Record<string, unknown>;

const MAX_VALUE = 256;

const DRIVER_STRING_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['code', 'db.error.code'], // pg: SQLSTATE '23505'; mysql2: 'ER_DUP_ENTRY'; sqlite: 'SQLITE_CONSTRAINT_UNIQUE'
  ['sqlState', 'db.error.sqlstate'], // mysql2
  ['constraint', 'db.error.constraint'], // pg
  ['table', 'db.error.table'], // pg
  ['column', 'db.error.column'], // pg
  ['schema', 'db.error.schema'], // pg
  ['severity', 'db.error.severity'], // pg
  ['routine', 'db.error.routine'], // pg
  ['procName', 'db.error.procedure'], // mssql
];

const DRIVER_NUMBER_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['errno', 'db.error.errno'], // mysql2
  ['number', 'db.error.number'], // mssql
  ['state', 'db.error.state'], // mssql
  ['class', 'db.error.class'], // mssql
  ['lineNumber', 'db.error.line'], // mssql
];

/** Erros de rede até o banco: o `code` vem do Node, e a falha é de conexão, não da query. */
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE']);

/** Erro que veio do driver de banco, e não da aplicação. Pela forma: os drivers não exportam classe comum. */
export function isDriverError(error: unknown): error is Error & Fields {
  if (!(error instanceof Error)) return false;
  const e = error as Error & Fields;
  if (e.name === 'KnexTimeoutError') return true;
  if (typeof e.severity === 'string' && typeof e.code === 'string') return true; // pg
  if (typeof e.sqlState === 'string' || typeof e.sqlMessage === 'string') return true; // mysql2
  if (typeof e.number === 'number' && typeof e.state === 'number') return true; // mssql (tedious)
  return typeof e.code === 'string' && e.code.startsWith('SQLITE_');
}

function driverErrorKind(e: Error & Fields): string {
  const code = typeof e.code === 'string' ? e.code : '';
  const mssql = typeof e.number === 'number' ? e.number : undefined;
  if (CONNECTION_CODES.has(code) || code.startsWith('08') || code === '57P01') return 'connection';
  if (e.name === 'KnexTimeoutError' || code === '57014' || code === 'ETIMEOUT') return 'timeout';
  if (code === '40P01' || code === 'ER_LOCK_DEADLOCK' || mssql === 1205) return 'deadlock';
  if (
    code.startsWith('23') ||
    code === 'ER_DUP_ENTRY' ||
    code.startsWith('ER_NO_REFERENCED_ROW') ||
    code.startsWith('ER_ROW_IS_REFERENCED') ||
    code.startsWith('SQLITE_CONSTRAINT') ||
    mssql === 2627 ||
    mssql === 2601 ||
    mssql === 547
  ) {
    return 'constraint';
  }
  if (
    code.startsWith('42') ||
    code === 'ER_PARSE_ERROR' ||
    code === 'ER_NO_SUCH_TABLE' ||
    code === 'ER_BAD_FIELD_ERROR' ||
    mssql === 102 ||
    mssql === 207 ||
    mssql === 208
  ) {
    return 'syntax_or_schema';
  }
  return 'other';
}

/** `db.error.*` de um erro de driver; `{}` para qualquer outro. Nunca lança. */
export function dbErrorFields(error: unknown): Record<string, string> {
  try {
    if (!isDriverError(error)) return {};
    const out: Record<string, string> = { 'db.error.kind': driverErrorKind(error) };
    for (const [field, key] of DRIVER_STRING_FIELDS) {
      const value = error[field];
      if (typeof value === 'string' && value !== '') out[key] = value.slice(0, MAX_VALUE);
    }
    for (const [field, key] of DRIVER_NUMBER_FIELDS) {
      const value = error[field];
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Campos do erro para o evento: os `db.error.*` do driver, ou — para erro de aplicação, framework ou rede — o
 * `error.code` (`E_ROW_NOT_FOUND`, `P2002`, `ECONNREFUSED`), e o tipo da `cause`. Nunca lança.
 */
export function errorFields(error: unknown): Record<string, string> {
  try {
    if (!(error instanceof Error)) return {};
    const out = dbErrorFields(error);
    const e = error as Error & { code?: unknown; cause?: unknown };
    if (out['db.error.code'] === undefined && typeof e.code === 'string' && e.code !== '') {
      out['error.code'] = e.code.slice(0, 128);
    }
    if (e.cause instanceof Error && typeof e.cause.name === 'string' && e.cause.name !== '') {
      out['error.cause.type'] = e.cause.name.slice(0, 128);
    }
    return out;
  } catch {
    return {};
  }
}
