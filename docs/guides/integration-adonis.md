# Integração com AdonisJS

Como instrumentar uma aplicação AdonisJS 6 ou 7 com o SDK cc-stacktracer: o middleware HTTP, o exception
handler e a instrumentação de banco via Lucid/Knex. Requer SDK 3.2 ou posterior.

> Até a 3.1, o middleware oficial não emitia nada num app Adonis real: ele chamava
> `ctx.response.getResponse()`, que o Adonis não tem. Se você escreveu um middleware próprio por causa
> disso, a 3.2 permite trocá-lo pelo oficial.

## Onde inicializar

Num preload próprio, `start/stacktrace.ts`, registrado **primeiro** em `preloads` no `adonisrc.ts`, antes de `#start/routes` e `#start/kernel`. É uma única inicialização, pelo `auto`. Ela também liga o Lucid e, quando o Adonis encerra (o SIGTERM do deploy), envia o que estiver na fila:

```ts
// start/stacktrace.ts
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { StackTrace } from 'cc-stacktracer'

await StackTrace.auto({
  apiKey: process.env.STACKTRACE_API_KEY!,
  serviceId: process.env.STACKTRACE_SERVICE_ID!,
  endpoint: process.env.STACKTRACE_ENDPOINT!,
  enableGlobalHandlers: true,
  lucid: db,
})

// SIGTERM (deploy, `docker stop`): o Adonis encerra a app e o SDK envia o que ainda está na fila.
app.terminating(async () => {
  await StackTrace.shutdown()
})
```

```ts
// adonisrc.ts
preloads: [() => import('#start/stacktrace'), () => import('#start/routes'), () => import('#start/kernel')],
```

Não chame `init` e depois `auto`: a segunda chamada substitui o cliente da primeira. Este é o arranjo que o smoke de consumidor roda num app gerado pelo `create-adonisjs` (Adonis 6 e 7).

## Middleware HTTP

Registre o middleware do SDK como **middleware de servidor**, o primeiro da lista, em `start/kernel.ts`:

```ts
server.use([
  () => import('cc-stacktracer/adonis/middleware'),
  () => import('#middleware/container_bindings_middleware'),
  // ...o resto
]);
```

Ele precisa ser middleware de servidor, e não de rota: o de servidor roda antes do roteamento. Assim:

- 404, falha de sessão e falha de CSRF também têm trace;
- o span raiz leva o pattern da rota (`/users/:id`), lido depois do match;
- requisição que não casou com nenhuma rota (404, robô procurando `/.env`, arquivo estático) vai para
  um balde só, `[unmatched]`, em vez de virar uma linha de rota por URL. O path, com os ids mascarados,
  fica no atributo `url.path` do span.

Cada requisição roda dentro de um `AsyncLocalStorage` com o snapshot HTTP, e logs, erros e spans filhos
herdam o trace, o método e a rota.

Para instrumentar só algumas rotas, a forma de função serve como middleware de rota:

```ts
import { stacktraceAdonisMiddleware } from 'cc-stacktracer/adonis';

router.get('/relatorios/:id', [ReportsController, 'show']).use(stacktraceAdonisMiddleware());
```

## Exception handler: `recordRequestError`

O exception handler do Adonis trata a exceção **dentro** do `next()` do middleware. O middleware do SDK
nunca vê a exceção: para ele, a requisição só terminou com um status. Por isso, chame
`StackTrace.recordRequestError` no `report()` do handler:

```ts
// app/exceptions/handler.ts
import { ExceptionHandler, type HttpContext } from '@adonisjs/core/http';
import { StackTrace } from 'cc-stacktracer';

export default class HttpExceptionHandler extends ExceptionHandler {
  async report(error: unknown, ctx: HttpContext) {
    StackTrace.recordRequestError(error);
    return super.report(error, ctx);
  }
}
```

A resposta decide o que acontece:

- **5xx** (padrão `500-599`, configurável em `httpServerErrorStatuses`): UM evento de erro, com o status
  final e a rota, ligado ao span raiz. O span raiz leva `error_type` e `error_message`.
- **4xx** (validação, 404, 403): nada. Uma exceção que vira 4xx não é erro de aplicação.

Sem essa linha, um 5xx sai com o span raiz marcado como erro, mas sem evento, sem stack e sem
`error_type`.

`recordRequestError` segue o Error Tracking: com `init({ errorTracking: false })`, só o span raiz
recebe a exceção, e nenhum evento sai. Fora de uma requisição, ela envia o erro na hora, como
`captureException`.

`captureException` continua valendo para erros que o app trata sem relançar. Chamar os dois no mesmo
objeto de erro gera um evento só.

## Middleware próprio com `startHttpRequest`

Se você precisa de um middleware próprio, abra a requisição antes do roteamento e passe a rota como
**função**. Ela é lida quando cada evento sai e quando o span raiz fecha.

```ts
import { startHttpRequest } from 'cc-stacktracer/generic-http';

const trace = startHttpRequest({
  method: ctx.request.method(),
  url: ctx.request.url(true),
  headers: ctx.request.headers(),
  route: () => ctx.route?.pattern,
});
```

Não escreva em campos internos do objeto devolvido: eles podem mudar em qualquer versão. Para informar a
rota mais tarde, use `trace.setRoute(pattern)`.

## Banco de dados (Lucid / Knex)

O `lucid: db` do preload acima instrumenta toda conexão do Lucid, inclusive as abertas depois do boot, com `db_system` do driver: `pg` → `postgres`, `mysql2` → `mysql`, `mssql` → `sqlserver`, `better-sqlite3` → `sqlite`. Funciona do Lucid 20 ao 22.

Sem `auto`: `StackTrace.register(createLucidStackTracePlugin(db))` (de `cc-stacktracer/db-lucid`) depois do `init`. Para dar nome a operações críticas, envolva-as também com `StackTrace.runQuery`:

```ts
import { StackTrace } from 'cc-stacktracer';

const user = await StackTrace.runQuery(
  'postgres',
  'users.findByEmail',
  () => User.findBy('email', email),
  { table: 'users' },
);
```

## Contexto de negócio

Envolva operações de domínio com `withBusinessContextAsync` para que entidade e operação apareçam em todos
os eventos emitidos dentro do callback.

```ts
await StackTrace.withBusinessContextAsync({ entity: 'order', operation: 'approve' }, async () => {
  StackTrace.log('pedido aprovado', { orderId });
});
```
