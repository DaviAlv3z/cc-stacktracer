/** Conexões dos cenários a partir das URLs que o `docker.mjs` (ou o CI) define. */

/** CC_SMOKE_PG_URL: postgres://user:senha@host:porta/banco */
export function pgConnectionFromEnv() {
  const url = new URL(process.env.CC_SMOKE_PG_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
  };
}

/** CC_SMOKE_MYSQL_URL: mysql://user:senha@host:porta/banco */
export function mysqlConnectionFromEnv() {
  const url = new URL(process.env.CC_SMOKE_MYSQL_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
  };
}

/**
 * CC_SMOKE_MSSQL_URL no formato do Prisma — `sqlserver://host:porta;database=x;user=y;password=z;...` — vira a
 * config do `mssql`/`tedious` (Lucid, adapter do Prisma 7 e o app de exemplo).
 */
export function mssqlConnectionFromEnv() {
  const [hostPart, ...pairs] = process.env.CC_SMOKE_MSSQL_URL.replace(/^sqlserver:\/\//u, '').split(';');
  const [server, port = '1433'] = hostPart.split(':');
  const kv = Object.fromEntries(pairs.filter(Boolean).map((pair) => pair.split('=')));
  return {
    server,
    port: Number(port),
    user: kv.user,
    password: kv.password,
    database: kv.database,
    options: { encrypt: true, trustServerCertificate: true },
  };
}
