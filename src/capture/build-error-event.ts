import { mergeEventContext } from '../core/request-context.js';
import { SCHEMA_VERSION, type ErrorEvent, type ServiceDescriptor } from '../core/stacktrace-event.types.js';
import { errorFields } from '../utils/error-fields.js';
import { sanitizeStackTrace } from '../utils/sanitize-stack.js';
import { nowIso } from '../utils/time.js';

export type BuildErrorEventParams = {
  service: ServiceDescriptor;
  environment: string;
  error: Error;
  context?: Record<string, unknown>;
  /** Instante da excecao (ISO). Ausente = agora. */
  timestamp?: string;
};

export function buildErrorEvent(params: BuildErrorEventParams): ErrorEvent {
  // Os campos do erro (SQLSTATE, constraint, código da app) entram por baixo: o contexto explícito vence.
  const fields = errorFields(params.error);
  const context = mergeEventContext(Object.keys(fields).length > 0 ? { ...fields, ...params.context } : params.context);
  return {
    schemaVersion: SCHEMA_VERSION,
    type: 'error',
    service: params.service,
    environment: params.environment,
    timestamp: params.timestamp ?? nowIso(),
    message: params.error.message,
    ...(params.error.stack !== undefined ? { stack: sanitizeStackTrace(params.error.stack) } : {}),
    ...(params.error.name !== undefined ? { name: params.error.name } : {}),
    ...(context !== undefined ? { context } : {}),
  };
}
