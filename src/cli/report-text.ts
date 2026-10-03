/**
 * Traduz o `DoctorReport` em linhas de terminal.
 *
 * Separado de `runDoctor` porque a regra é: **se o dev precisar abrir a documentação em algum
 * ponto, a mensagem falhou ali.** Cada falha diz o que está errado, onde, e o que fazer — nunca só
 * o código do erro.
 */
import { renderFindingText } from './finding-text.js';
import { ambiguousStackHint, buildInitSnippet, emptyPackageJsonHint } from './print-snippet.js';
import type { ConnectivityReason } from './check-connectivity.js';
import type { ConfigProblem } from './check-config.js';
import type { DoctorReport } from './run-doctor.js';

const OK = '  ok';
const FAIL = '  FAIL';
const WARN = '  WARN';

function configProblemText(p: ConfigProblem): string {
  switch (p.reason) {
    case 'missing':
      return `${p.key} is not set (or is empty).`;
    case 'not_uuid':
      return `${p.key} is not a UUID. Copy the service id from the dashboard at /services — it is not the service name.`;
    case 'not_url':
      return `${p.key} must be an absolute http(s) URL, e.g. https://ingest.example.com. "localhost:3000" is parsed as a protocol, not a host.`;
  }
}

/** Cada causa aponta para o campo que a conserta — errar o campo custa o dia do dev. */
function connectivityText(reason: ConnectivityReason): string {
  switch (reason) {
    case 'invalid_api_key':
      return 'the server rejected the API key (401). Check STACKTRACE_API_KEY — it must belong to this project.';
    case 'forbidden':
      return 'the API key has no access to this service (403).';
    case 'service_not_found':
      return 'the endpoint is a cc-stacktracer ingestion API, but it does not know this service id (404). Check STACKTRACE_SERVICE_ID.';
    case 'endpoint_not_found':
      return 'the host answered 404 but is not a cc-stacktracer ingestion API. Check STACKTRACE_ENDPOINT.';
    case 'bad_service_id':
      return 'the server rejected the service id format (400). Check STACKTRACE_SERVICE_ID.';
    case 'rate_limited':
      return 'rate limited (429). Wait and retry; if it persists, lower the send rate.';
    case 'server_unavailable':
      return 'the ingestion API is unavailable (503). This is server-side — retry shortly.';
    case 'dns_failure':
      return 'the endpoint host does not resolve. Check STACKTRACE_ENDPOINT for typos.';
    case 'connection_refused':
      return 'connection refused. Check the port, a firewall, or a proxy between you and the endpoint.';
    case 'timeout':
      return 'the request timed out. Check network egress and any proxy.';
    case 'unexpected_status':
      return 'the server answered with an unexpected status.';
    case 'network_error':
      return 'the request failed before reaching the server.';
  }
}

export function renderReport(report: DoctorReport, cwd: string, endpoint?: string): string[] {
  // O endpoint no cabecalho: apontar para staging sem perceber custa horas antes de alguem
  // desconfiar da variavel de ambiente.
  const header =
    endpoint !== undefined && endpoint !== '' ? `cc-stacktracer doctor → ${endpoint}` : 'cc-stacktracer doctor';
  const out: string[] = [header, `v${report.sdkVersion}`, ''];

  out.push('Stack');
  if (report.stack.empty) {
    out.push(
      ...emptyPackageJsonHint(cwd)
        .split('\n')
        .map((l) => `  ${l}`),
    );
  } else {
    out.push(`  http: ${report.stack.http ?? 'not recognized'}`);
    out.push(`  db:   ${report.stack.db ?? 'not recognized'}`);
    if (report.stack.http !== null && report.stack.ambiguous.length > 0) {
      out.push(
        ...ambiguousStackHint(report.stack.http, report.stack.ambiguous)
          .split('\n')
          .map((l) => `  ${l}`),
      );
    }
  }
  out.push('');

  if (report.moduleFormat.format === 'cjs') {
    out.push('Module format');
    out.push(
      report.moduleFormat.ok
        ? `${OK}  CommonJS project on a Node that can require() cc-stacktracer (an ES module)`
        : `${WARN}  this looks like a CommonJS project (no "type": "module") and Node ${report.moduleFormat.nodeVersion} cannot require() an ES module. Unless the app is bundled (Next.js, Vite…), it will fail to boot with ERR_REQUIRE_ESM: use Node 20.19+ or 22.12+, or make the project ESM.`,
    );
    out.push(
      '        TypeScript compiling to CommonJS also needs TypeScript 5.8+ with "module": "nodenext" (or "node20" on 5.9+).',
    );
    out.push('');
  }

  out.push('Configuration');
  if (report.config.ok) {
    out.push(`${OK}  all three environment variables are set and well-formed`);
  } else {
    for (const p of report.config.problems) out.push(`${FAIL}  ${configProblemText(p)}`);
  }
  out.push('');

  if (report.connectivity !== null) {
    out.push('Connectivity');
    out.push(
      report.connectivity.ok
        ? `${OK}  reached the ingestion API and the credentials are valid`
        : `${FAIL}  ${connectivityText(report.connectivity.reason)}`,
    );
    out.push('');
  }

  if (report.probe !== null) {
    out.push('Data path');
    for (const step of report.probe.steps) {
      const target = step.step === 'events' ? 'POST /v1/events (log)' : 'POST /v1/spans (span)';
      out.push(
        step.ok
          ? `${OK}  ${target} accepted`
          : `${FAIL}  ${target} rejected${step.status !== undefined ? ` (${step.status})` : ''} ${step.detail ?? ''}`.trimEnd(),
      );
    }
    if (report.probe.ok) {
      out.push(`        trace id: ${report.probe.traceId} — look it up in the dashboard to confirm.`);
    }
    out.push('');
  }

  if (report.findings !== null) {
    out.push('Instrumentation');
    const actionable = report.findings.filter((f) => f.severity !== 'ok');
    if (actionable.length === 0) {
      out.push(`${OK}  no gaps detected`);
    }
    for (const f of actionable) {
      const guide = f.guide !== undefined && f.guide !== '' ? ` (guide: ${f.guide})` : '';
      out.push(`  ${f.severity === 'fail' ? 'FAIL' : 'warn'}  ${f.service}: ${renderFindingText(f)}${guide}`);
    }
    out.push('');
  } else if (report.auditError !== null) {
    // Não é falha do doctor: as verificações anteriores valem por si.
    out.push('Instrumentation');
    out.push(`  skipped — could not read the audit: ${report.auditError}`);
    out.push('');
  }

  // O snippet fecha: quem chegou aqui com erro precisa dele mais ainda.
  out.push('Suggested init');
  out.push(
    ...buildInitSnippet(report.stack)
      .split('\n')
      .map((l) => `  ${l}`),
  );

  return out;
}
