import { DeliveryCancelled } from './delivery-cancelled.js';
import { IngestTransportError } from './ingest-transport-error.js';

/**
 * Por que itens saíram sem entrega:
 * - `rejected`: a ingestão recusou o lote de vez (4xx permanente);
 * - `exhausted`: tentativas esgotadas (ingestão fora do ar, 5xx, timeout);
 * - `overflow`: fila em memória cheia;
 * - `unsent`: ainda na fila quando o processo saiu ou o `shutdown()` terminou;
 * - `partial`: a ingestão aceitou o lote (202) e recusou itens soltos (`rejectedIndexes`);
 * - `invalid`: o evento não passou na validação local do contrato v4 e nem foi enviado.
 */
export type DropReason = 'rejected' | 'exhausted' | 'overflow' | 'unsent' | 'partial' | 'invalid';
export type DropInfo = { count: number; reason: DropReason; error?: unknown; detail?: string };

type WarningKind = 'auth' | 'not_found' | 'rejected' | 'unreachable' | 'overflow' | 'unsent' | 'partial' | 'invalid';

const SUFFIX = 'Run `npx cc-stacktracer doctor` to diagnose. (Shown once per kind.)';

function kindOf(info: DropInfo): WarningKind {
  if (
    info.reason === 'overflow' ||
    info.reason === 'unsent' ||
    info.reason === 'partial' ||
    info.reason === 'invalid'
  ) {
    return info.reason;
  }
  const status = info.error instanceof IngestTransportError ? info.error.status : undefined;
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  return info.reason === 'rejected' ? 'rejected' : 'unreachable';
}

function describeError(error: unknown): string {
  if (error instanceof IngestTransportError) {
    return error.status !== undefined ? `HTTP ${error.status}` : error.message;
  }
  if (error instanceof Error) {
    // O undici do fetch embrulha a causa: `fetch failed` sozinho não diz nada. Código quando há (ECONNREFUSED,
    // ENOTFOUND); senão, a mensagem da causa (`bad port`, `other side closed`).
    const cause = (error as Error & { cause?: unknown }).cause;
    const code = (cause as { code?: unknown } | undefined)?.code;
    const detail = typeof code === 'string' ? code : cause instanceof Error ? cause.message : undefined;
    return detail !== undefined && detail !== '' ? `${error.message} (${detail})` : error.message;
  }
  return String(error);
}

function messageFor(kind: WarningKind, info: DropInfo, host: string): string {
  const lost = `${info.count} telemetry item(s) dropped`;
  switch (kind) {
    case 'auth':
      return `[cc-stacktracer] ${host} rejected the API key (${describeError(info.error)}) — ${lost}. Check STACKTRACE_API_KEY. ${SUFFIX}`;
    case 'not_found':
      return `[cc-stacktracer] ${host} answered 404 — ${lost}. Check STACKTRACE_ENDPOINT (base URL only) and STACKTRACE_SERVICE_ID. ${SUFFIX}`;
    case 'rejected':
      return `[cc-stacktracer] ${host} rejected a batch (${describeError(info.error)}) — ${lost}. This is a bug in cc-stacktracer or in a custom beforeSend/transport; please report it with the SDK version. ${SUFFIX}`;
    case 'unreachable':
      return `[cc-stacktracer] could not deliver to ${host} (${describeError(info.error)}) — ${lost} after retries. ${SUFFIX}`;
    case 'overflow':
      return `[cc-stacktracer] in-memory queue is full — ${lost}, oldest first. Ingestion is down or slower than this process produces telemetry. ${SUFFIX}`;
    case 'unsent': {
      const why =
        info.error !== undefined ? `last delivery error: ${describeError(info.error)}` : 'no delivery finished in time';
      return `[cc-stacktracer] ${info.count} telemetry item(s) were still queued when the process exited or StackTrace.shutdown() returned (${why}) — they are lost. If the app calls process.exit(), await StackTrace.shutdown() before it. ${SUFFIX}`;
    }
    case 'partial': {
      const why = info.detail !== undefined ? ` (first reason: "${info.detail}")` : '';
      return `[cc-stacktracer] ${host} accepted a batch but rejected ${info.count} item(s)${why}. If the reason mentions service_id, STACKTRACE_SERVICE_ID must be a service of the API key's project. ${SUFFIX}`;
    }
    case 'invalid':
      return `[cc-stacktracer] ${info.count} event(s) failed local validation and were not sent (${describeError(info.error)}). This is a bug in cc-stacktracer or in a custom beforeSend; please report it with the SDK version. ${SUFFIX}`;
  }
}

/**
 * Aviso de PERDA de telemetria: um por tipo, por cliente. O fail-open continua — nada lança, o app segue —,
 * mas a perda silenciosa escondeu configuração quebrada por meses (a integração Adonis na 3.x inteira, o
 * Lucid que nunca gerou span). Só avisa quando o dado foi DESCARTADO, nunca numa falha que ainda vai ser
 * retentada: instabilidade passageira da ingestão não vira ruído no log do cliente.
 */
export function createDeliveryWarnings(params: {
  endpoint: string;
  warn: (message: string) => void;
}): (info: DropInfo) => void {
  const seen = new Set<WarningKind>();
  let host = params.endpoint;
  try {
    host = new URL(params.endpoint).host;
  } catch {
    /* o endpoint já foi validado no init; o texto cru serve */
  }
  return (info) => {
    if (info.error instanceof DeliveryCancelled || info.count <= 0) return;
    const kind = kindOf(info);
    if (seen.has(kind)) return;
    seen.add(kind);
    params.warn(messageFor(kind, info, host));
  };
}
