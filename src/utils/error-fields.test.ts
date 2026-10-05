import { describe, expect, it } from 'vitest';
import { normalizeEventV4 } from '../shared/schema/index.js';
import { toWirePayloadForIngest } from '../core/wire-event.js';
import { buildErrorEvent } from '../capture/build-error-event.js';
import { dbErrorFields, errorFields, isDriverError } from './error-fields.js';

/** Erros com a forma que os drivers produzem (campos medidos com pg 8, mysql2 3, tedious e better-sqlite3). */
function pgUniqueViolation(): Error {
  // O `name` do erro do pg é "error" — por isso o SQLSTATE importa.
  return Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
    name: 'error',
    severity: 'ERROR',
    code: '23505',
    detail: 'Key (email)=(fulano@x.com) already exists.',
    schema: 'public',
    table: 'users',
    constraint: 'users_email_unique',
    routine: '_bt_check_unique',
  });
}

function mysqlDuplicate(): Error {
  return Object.assign(new Error("Duplicate entry 'fulano@x.com' for key 'users.users_email_unique'"), {
    code: 'ER_DUP_ENTRY',
    errno: 1062,
    sqlState: '23000',
    sqlMessage: "Duplicate entry 'fulano@x.com' for key 'users.users_email_unique'",
  });
}

function mssqlDuplicate(): Error {
  return Object.assign(new Error('Violation of UNIQUE KEY constraint'), {
    number: 2627,
    state: 1,
    class: 14,
    lineNumber: 1,
    originalError: { message: 'The duplicate key value is (fulano@x.com).' },
  });
}

describe('errorFields', () => {
  it('pg: SQLSTATE, constraint, tabela — sem o detail, que traz o valor', () => {
    const fields = errorFields(pgUniqueViolation());
    expect(fields).toEqual({
      'db.error.kind': 'constraint',
      'db.error.code': '23505',
      'db.error.constraint': 'users_email_unique',
      'db.error.table': 'users',
      'db.error.schema': 'public',
      'db.error.severity': 'ERROR',
      'db.error.routine': '_bt_check_unique',
    });
    expect(JSON.stringify(fields)).not.toContain('fulano');
  });

  it('mysql2 e mssql: códigos numéricos; nada do valor duplicado', () => {
    expect(errorFields(mysqlDuplicate())).toEqual({
      'db.error.kind': 'constraint',
      'db.error.code': 'ER_DUP_ENTRY',
      'db.error.sqlstate': '23000',
      'db.error.errno': '1062',
    });
    const mssql = errorFields(mssqlDuplicate());
    expect(mssql).toEqual({
      'db.error.kind': 'constraint',
      'db.error.number': '2627',
      'db.error.state': '1',
      'db.error.class': '14',
      'db.error.line': '1',
    });
  });

  it('sqlite e timeout do pool do knex', () => {
    const sqlite = Object.assign(new Error('UNIQUE constraint failed: users.email'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    expect(dbErrorFields(sqlite)).toEqual({
      'db.error.kind': 'constraint',
      'db.error.code': 'SQLITE_CONSTRAINT_UNIQUE',
    });
    const pool = Object.assign(new Error('Knex: Timeout acquiring a connection.'), { name: 'KnexTimeoutError' });
    expect(dbErrorFields(pool)).toEqual({ 'db.error.kind': 'timeout' });
  });

  it('erro de app, framework ou rede: só error.code e o tipo da causa', () => {
    const adonis = Object.assign(new Error('Row not found'), { code: 'E_ROW_NOT_FOUND', status: 404 });
    expect(errorFields(adonis)).toEqual({ 'error.code': 'E_ROW_NOT_FOUND' });
    const rede = new Error('fetch failed', { cause: Object.assign(new TypeError('x'), { code: 'ECONNREFUSED' }) });
    expect(errorFields(rede)).toEqual({ 'error.cause.type': 'TypeError' });
    expect(isDriverError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(false);
  });

  it('Error comum e não-Error: nada', () => {
    expect(errorFields(new Error('x'))).toEqual({});
    expect(errorFields('x')).toEqual({});
    expect(errorFields(null)).toEqual({});
  });

  it('getter que lança não derruba ninguém', () => {
    const hostil = new Error('x');
    Object.defineProperty(hostil, 'code', {
      get() {
        throw new Error('getter');
      },
    });
    expect(errorFields(hostil)).toEqual({});
  });
});

describe('buildErrorEvent com os campos do erro', () => {
  const service = { name: 'api', version: '1', environment: 'test' };

  it('os campos do driver viram tags do evento, e o contexto explícito vence', () => {
    const event = buildErrorEvent({
      service,
      environment: 'test',
      error: pgUniqueViolation(),
      context: { 'db.error.table': 'explicita' },
    });
    const wire = normalizeEventV4(toWirePayloadForIngest(event), { serviceId: '11111111-1111-4111-8111-111111111111' });
    expect(wire.metadata.tags).toMatchObject({
      'db.error.kind': 'constraint',
      'db.error.code': '23505',
      'db.error.constraint': 'users_email_unique',
      'db.error.table': 'explicita',
    });
  });
});
