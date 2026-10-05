/*
|--------------------------------------------------------------------------
| cc-stacktracer
|--------------------------------------------------------------------------
|
| Preload ANTES de routes e kernel (adonisrc.ts). Uma única inicialização:
| o `lucid: db` liga os spans de toda conexão do Lucid.
|
*/

import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { StackTrace } from 'cc-stacktracer'

await StackTrace.auto({
  apiKey: process.env.STACKTRACE_API_KEY!,
  serviceId: process.env.STACKTRACE_SERVICE_ID!,
  endpoint: process.env.STACKTRACE_ENDPOINT!,
  enableGlobalHandlers: true,
  identityOnSpans: true,
  lucid: db,
  lucidOptions: { statement: true, parameters: 'masked' },
})

// SIGTERM (deploy, `docker stop`): o Adonis encerra a app e o SDK envia o que ainda está na fila.
app.terminating(async () => {
  await StackTrace.shutdown()
})
