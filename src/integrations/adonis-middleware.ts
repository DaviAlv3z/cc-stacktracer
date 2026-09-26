/**
 * Entrada do `server.use` do Adonis, que importa o modulo e instancia a classe `default`:
 *
 * ```ts
 * // start/kernel.ts
 * server.use([() => import('cc-stacktracer/adonis/middleware'), ...])
 * ```
 */
export { StackTraceAdonisMiddleware as default } from './adonis.js';
