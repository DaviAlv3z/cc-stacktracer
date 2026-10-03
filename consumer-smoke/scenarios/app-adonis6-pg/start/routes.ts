/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import router from '@adonisjs/core/services/router'

router.get('/', async () => {
  return {
    hello: 'world',
  }
})

import db from '@adonisjs/lucid/services/db'
import { StackTrace } from 'cc-stacktracer'

router.get('/users/:id', async ({ params }) => {
  StackTrace.setUser({ id: `u-${params.id}` })
  await db.rawQuery('select 1')
  await new Promise((resolve) => setTimeout(resolve, 5 + (Number(params.id) % 7) * 3))
  StackTrace.log(`user ${params.id}`)
  return { ok: true }
})

router.get('/boom', async () => {
  throw new Error('boom')
})
