# Integração com AdonisJS

Como instrumentar uma aplicação AdonisJS 6 ou 7 com o SDK cc-stacktracer: o middleware HTTP, o exception
handler, o usuário e o cliente (subtenant) nos spans, e a instrumentação de banco via Lucid/Knex. O básico
requer SDK 3.2 ou posterior; identidade nos spans, SQL nos spans de banco e os campos de erro do driver
requerem a 3.4.

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
  release: process.env.APP_VERSION,
  enableGlobalHandlers: true,
  // 3.4: user.id e subtenant do escopo (setUser / setTags) nos spans, inclusive no span raiz.
  identityOnSpans: true,
  lucid: db,
  // 3.4: o SQL com placeholders em db_statement, os bindings mascarados em db_parameters.
  lucidOptions: { statement: true, parameters: 'masked' },
})

// SIGTERM (deploy, `docker stop`): o Adonis encerra a app e o SDK envia o que ainda está na fila.
app.terminating(async () => {
  await StackTrace.shutdown()
})
```

```ts
// adonisrc.ts
preloads: [
  { file: () => import('#start/stacktrace'), environment: ['web', 'console'] },
  () => import('#start/routes'),
  () => import('#start/kernel'),
],
```

`console` serve para jobs e comandos `node ace ...` (veja "Jobs e comandos"); deixe o ambiente `test` de
fora, para a telemetria dos testes não chegar ao painel. Não chame `init` e depois `auto`: a segunda chamada
substitui o cliente da primeira. Este é o arranjo que o smoke de consumidor roda num app gerado pelo
`create-adonisjs` (Adonis 6 e 7).

## Middleware HTTP

Registre o middleware do SDK como **middleware de servidor**, em `start/kernel.ts`, antes de tudo que processa a
requisição — mas **depois** dos middlewares que respondem sozinhos, sem chegar ao roteador:

```ts
server.use([
  () => import('#middleware/container_bindings_middleware'),
  () => import('@adonisjs/static/static_middleware'), // se existir
  () => import('@adonisjs/cors/cors_middleware'), // responde o preflight OPTIONS sem chamar next()
  () => import('cc-stacktracer/adonis/middleware'),
  // ...o resto
]);
```

Ele precisa ser middleware de servidor, e não de rota: o de servidor roda antes do roteamento. Assim:

- 404, falha de sessão e falha de CSRF também têm trace;
- o span raiz leva o pattern da rota (`/users/:id`), lido depois do match;
- requisição que não casou com nenhuma rota (404, robô procurando `/.env`) vai para um balde só,
  `[unmatched]`, em vez de virar uma linha de rota por URL. O path, com os ids mascarados, fica no atributo
  `url.path` do span.

Arquivo estático e preflight de CORS não casam com rota nenhuma: com o SDK **na frente** do static e do CORS,
cada um vira um `[unmatched]`. Por isso eles vêm antes. Para amostrar a varredura de robôs, crie no painel, em
**Capture** do serviço, a regra `eventType: http`, `endpoint: [unmatched]`, `sampleRate: 0.05` (requer
`capturePolicyRefreshMs` no `init`).

Cada requisição roda dentro de um `AsyncLocalStorage` com o snapshot HTTP, e logs, erros e spans filhos
herdam o trace, o método e a rota. O span raiz já traz a identidade da requisição: `http.request_id` (o
`X-Request-Id` que o Adonis gera com `generateRequestId: true`), `user_agent.original`, `host.name`,
`process.pid`, `telemetry.sdk.version` e, com `init({ clientIp })`, `client.address`.

Para instrumentar só algumas rotas, a forma de função serve como middleware de rota:

```ts
import { stacktraceAdonisMiddleware } from 'cc-stacktracer/adonis';

router.get('/relatorios/:id', [ReportsController, 'show']).use(stacktraceAdonisMiddleware());
```

Não registre os dois (servidor e rota) para a mesma requisição: seriam dois spans raiz.

## Usuário e cliente (subtenant)

Depois de autenticar, marque o usuário e — numa aplicação que atende vários clientes — o cliente:

```ts
// app/middleware/auth_middleware.ts
import { StackTrace } from 'cc-stacktracer'

export default class AuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { guards?: (keyof Authenticators)[] } = {}) {
    await ctx.auth.authenticateUsing(options.guards)
    StackTrace.setUser({ id: String(ctx.auth.user!.id) })
    StackTrace.setTags({ subtenant: tenant.slug }) // o slug do cliente; de onde ele vem é da sua app
    return next()
  }
}
```

- **Eventos** (logs e erros) da requisição saem com `metadata.user.id` e `tags.subtenant`.
- **Spans**, com `init({ identityOnSpans: true })` (3.4): o span raiz da requisição — lido no fim dela — e todo
  span criado depois da marcação (banco, chamadas de saída, `withSpan`) levam `user.id` e `subtenant`. Assim todo
  trace autenticado aparece no filtro de subtenant da tela de traces. As queries do próprio auth rodam antes da
  marcação e não levam.
- O escopo é da requisição: o usuário de uma não aparece em outra.
- Use o id interno do usuário — nunca e-mail, CPF ou nome — e um slug legível e estável para o cliente
  (`0042-prefeitura-de-peruibe`), nunca um id. Veja o [guia de subtenant](./subtenant.md).

Para outros atributos do span raiz (o plano do cliente, uma feature flag), use
`StackTrace.setRootSpanAttributes({ 'cliente.plano': 'premium' })` de qualquer ponto da requisição.

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

Na 3.4 o evento leva sozinho os campos do erro: num erro de banco, `db.error.kind`, `db.error.code`
(SQLSTATE `23505`, `ER_DUP_ENTRY`…), `db.error.constraint` e afins; num erro do Adonis, `error.code`
(`E_ROW_NOT_FOUND`). Não é preciso copiá-los para tags no `report()`.

Não chame `captureException` no `report()`: ele envia na hora, antes de existir status — um 404 ou um 422
viraria evento. `recordRequestError` segue o Error Tracking: com `init({ errorTracking: false })`, só o span
raiz recebe a exceção, e nenhum evento sai. Fora de uma requisição, ela envia o erro na hora, como
`captureException`.

`captureException` continua valendo para erros que o app trata sem relançar. Chamar os dois no mesmo
objeto de erro gera um evento só.

Uma exceção registrada num span — uma query que falhou, por exemplo — vira evento mesmo que o app a capture e
responda 409: no modelo do Error Tracking, o erro do span é o erro da requisição. Se o app usa violação de
constraint como fluxo de controle, valide antes (VineJS `unique`/`exists`).

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

O `lucid: db` do preload acima instrumenta toda conexão do Lucid, inclusive as abertas depois do boot (e as
criadas por tenant em runtime), com `db_system` do driver: `pg` → `postgres`, `mysql2` → `mysql`, `mssql` →
`sqlserver`, `better-sqlite3` → `sqlite`. Funciona do Lucid 20 ao 22. Cada query é um span `db`, com:

| Atributo | Conteúdo | Desde |
|---|---|---|
| `db_system`, `db_operation`, `db_table` | engine, verbo e tabela | 3.3 |
| `db.namespace`, `db.connection` | o banco e o nome da conexão do Lucid | 3.4 |
| `db_statement` | o SQL com **placeholders** (`$1`, `?`), até 4.000 caracteres — com `lucidOptions.statement` | 3.4 |
| `db_parameters` | os bindings mascarados — com `lucidOptions.parameters` | 3.4 |
| `db.error.*` | numa query com erro: `kind`, `code`, `constraint`, `table`, `sqlstate`, `errno`… | 3.4 |

`parameters: 'masked'` mantém números, booleanos, `null` e UUIDs e troca texto por `[string:<tamanho>]` e datas
por `[date]`. Se o schema guarda CPF ou telefone como número, use `parameters: 'types'`, que mascara números
também. `lucidOptions.attributes: () => ({ ... })` acrescenta atributos a cada span de banco, lidos quando a
query começa. Nenhum dos três é ligado por padrão.

### Configure o knex em cada conexão

```ts
// config/database.ts
/**
 * Para o knex: `compileSqlOnError: false` poe o SQL com PLACEHOLDERS (e nao com os valores) na mensagem de
 * erro; `asyncStackTraces` faz a stack do erro apontar a linha da app que disparou a query.
 * `compileSqlOnError` nao esta no tipo do Lucid, dai o objeto a parte.
 */
const knexErrorOptions: Record<string, unknown> = { compileSqlOnError: false }

// em cada conexão:
  asyncStackTraces: true,
  ...knexErrorOptions,
```

- Por padrão o knex prefixa a mensagem de erro com o SQL **com os valores**: no MySQL e no SQLite, um insert
  duplicado vira `insert ... values ('fulano@x.com') - Duplicate entry ...`, e essa mensagem vai para o seu log
  e para o evento. Com `compileSqlOnError: false`, fica `values (?)`. No PostgreSQL não muda nada (o SQL já está
  com `$1`), mas deixe uniforme.
- Sem `asyncStackTraces`, a stack de um erro do `pg` só tem frames do parser do driver — nenhuma linha da sua
  app. O custo é um `new Error()` por query montada.
- O MySQL e o SQL Server põem o **valor** duplicado na mensagem do próprio driver
  (`Duplicate entry 'fulano@x.com' for key ...`), com ou sem `compileSqlOnError`. Nos eventos, redija com
  `beforeSend`; o `error_message` do span de banco mantém a mensagem do driver.

### Não meça a mesma query duas vezes

**Não envolva query do Lucid em `StackTrace.runQuery`** nem em `measure({ kind: 'db' })`: com o plugin ligado,
isso cria um segundo span `db` para a mesma query, e o painel a conta duas vezes nos gargalos. Para dar nome de
negócio a um conjunto de queries, use um span de negócio — as queries viram filhas dele:

```ts
import { StackTrace } from 'cc-stacktracer';

const relatorio = await StackTrace.withSpan(
  'relatorio.mensal',
  () => Relatorio.query().where('competencia', competencia),
  { type: 'business' },
);
```

`runQuery` fica para banco **fora** do Lucid — um pool próprio de `pg` ou `mssql`.

Sem `auto`: `StackTrace.register(createLucidStackTracePlugin(db, { statement: true, parameters: 'masked' }))`
(de `cc-stacktracer/db-lucid`) antes ou depois do `init`.

## Jobs e comandos

Um job, cron, consumer de fila ou comando ace não tem requisição: abra o trace com `withTrace`.

```ts
import { StackTrace } from 'cc-stacktracer';

await StackTrace.withTrace('job.processa-lote', async () => {
  StackTrace.setTags({ subtenant: cliente.slug });
  await processaLote(cliente);
});
```

Na 3.4 o `withTrace` abre um escopo próprio: o `setUser`/`setTags` do job vale só para ele. **Fora** de uma
requisição ou de um `withTrace`, `setUser` e `setTags` gravam no escopo do processo inteiro — nunca marque
usuário ou cliente ali. O job que termina naturalmente entrega a telemetria sozinho; antes de
`process.exit()`, chame `await StackTrace.shutdown()`.

## Contexto de negócio

Envolva operações de domínio com `withBusinessContextAsync` para que entidade e operação apareçam em todos
os eventos emitidos dentro do callback.

```ts
await StackTrace.withBusinessContextAsync({ entity: 'order', operation: 'approve' }, async () => {
  StackTrace.log('pedido aprovado', { orderId });
});
```
