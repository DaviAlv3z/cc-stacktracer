import { hostname } from 'node:os';

/** O user-agent de toda requisição do roteiro: o span raiz tem de trazê-lo em `user_agent.original`. */
const SMOKE_USER_AGENT = 'cc-smoke/1.0';

/**
 * O roteiro HTTP comum a todos os frameworks: um 500 lançado, um 404 de robô e 30 requisições
 * concorrentes, cada uma com usuário e log próprios. As asserções são o contrato do SDK.
 */
export async function runHttpScript(base) {
  const statuses = {};
  const hit = async (path) => {
    const res = await fetch(base + path, { headers: { 'user-agent': SMOKE_USER_AGENT } });
    await res.text();
    statuses[path] = res.status;
  };
  await hit('/boom');
  await hit('/wp-login.php');
  await Promise.all(Array.from({ length: 30 }, (_, i) => hit(`/users/${i}`)));
  return statuses;
}

/** Corpo do `/users/:id` em qualquer framework: usuário, espera variável (intercala as requisições) e log. */
export async function userWork(StackTrace, id) {
  StackTrace.setUser({ id: `u-${id}` });
  await new Promise((resolve) => setTimeout(resolve, 5 + (Number(id) % 7) * 3));
  StackTrace.log(`user ${id}`);
}

export function checkHttpTelemetry(check, receiver, statuses) {
  check.equal(statuses['/boom'], 500, 'status do /boom');
  check.equal(statuses['/wp-login.php'], 404, 'status do 404');
  const events = receiver.events();
  const roots = receiver.spans().filter((s) => s.span_type === 'http' && s.parent_span_id === null);
  const logs = events.filter((e) => e.type === 'log');
  const errors = events.filter((e) => e.type === 'error');
  check.equal(roots.length, 32, 'um span raiz por requisição (1 + 1 + 30)');
  check.equal(new Set(roots.map((s) => s.trace_id)).size, roots.length, 'trace distinto por requisição');
  check.equal(logs.length, 30, 'um log por requisição de usuário');
  check.equal(errors.length, 1, 'um único evento de erro (o do /boom)');
  const boom = roots.find((s) => s.http_status_code === 500);
  check.ok(boom?.status === 'error' && typeof boom?.error_type === 'string', 'span raiz do 500 com error_type');
  const unmatched = roots.find((s) => s.http_status_code === 404);
  check.equal(unmatched?.http_route, '[unmatched]', 'rota do 404');
  check.equal(unmatched?.attributes?.['url.path'], '/wp-login.php', 'url.path do 404');
  const userRoots = roots.filter((s) => s.http_route === '/users/:id');
  check.equal(userRoots.length, 30, 'um span raiz de /users/:id por requisição');
  for (const s of userRoots) {
    const attrs = s.attributes ?? {};
    check.equal(attrs['user_agent.original'], SMOKE_USER_AGENT, 'user_agent.original no span raiz de /users/:id');
    check.equal(attrs['host.name'], hostname(), 'host.name no span raiz de /users/:id');
    check.ok(
      /^\d+\.\d+\.\d+/.test(String(attrs['telemetry.sdk.version'])),
      `telemetry.sdk.version no span raiz de /users/:id (veio ${JSON.stringify(attrs['telemetry.sdk.version'])})`,
    );
    check.ok(!('client.address' in attrs), 'sem client.address por padrão');
  }
  for (const e of errors) {
    check.equal(e.metadata?.http?.status_code, 500, 'status no evento de erro');
    check.equal(e.trace?.span_id, boom?.span_id, 'evento de erro ligado ao span raiz do 500');
  }
  for (const e of logs) {
    const id = String(e.message).split(' ')[1];
    check.equal(e.metadata?.user?.id, `u-${id}`, `usuário do log ${id}`);
    check.equal(e.metadata?.http?.route, '/users/:id', `rota do log ${id}`);
    const root = roots.find((s) => s.trace_id === e.trace?.trace_id);
    check.ok(root !== undefined && root.span_id === e.trace?.span_id, `log ${id} aponta o span raiz da própria requisição`);
  }
}
