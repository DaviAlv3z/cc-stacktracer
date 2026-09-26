import { maskDynamicRouteSegments, normalizeHttpRouteForSpan } from '../shared/schema/index.js';

/**
 * Rota do span raiz quando nenhuma rota casou: 404, robo varrendo `/.env` e `/wp-login.php`, arquivo
 * servido por middleware estatico. Ate a 3.1 o span levava o path mascarado, e cada URL de robo virava uma
 * linha de rota no painel. OpenTelemetry (`http.route` ausente, nome = metodo) e Datadog (resource = metodo)
 * fazem o mesmo que aqui: sem template nao ha rota, ha um balde so.
 */
export const UNMATCHED_HTTP_ROUTE = '[unmatched]';

const MAX_URL_PATH = 2048;

/**
 * `span_name`/`http_route` do span raiz. Com rota casada, o template. Sem ela, {@link UNMATCHED_HTTP_ROUTE},
 * e o path (ids mascarados) fica no atributo `url.path` — o nome do OpenTelemetry — para quem precisar
 * saber o que os robos procuram.
 */
export function httpRootSpanRoute(
  method: string,
  matchedRoute: string | undefined,
  url: string,
): { span_name: string; http_route: string; attributes?: Record<string, unknown> } {
  if (matchedRoute !== undefined && matchedRoute.trim() !== '') {
    const httpRoute = normalizeHttpRouteForSpan(method, matchedRoute) ?? matchedRoute;
    return { span_name: `${method} ${matchedRoute}`.slice(0, 1024), http_route: httpRoute.slice(0, 4096) };
  }
  const path = maskDynamicRouteSegments(url.split('?')[0] ?? url);
  return {
    span_name: `${method} ${UNMATCHED_HTTP_ROUTE}`.slice(0, 1024),
    http_route: UNMATCHED_HTTP_ROUTE,
    attributes: { 'url.path': path.slice(0, MAX_URL_PATH) },
  };
}
