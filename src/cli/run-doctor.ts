/**
 * O `doctor` como função pura de I/O injetado — o entrypoint só liga isto ao processo.
 *
 * A separação existe para o diagnóstico ser testável sem subir servidor, sem tocar disco e sem
 * capturar stdout: os testes chamam `runDoctor` com um `fetch` e um `package.json` falsos e conferem
 * o **relatório**, não o texto impresso.
 *
 * ## Somente leitura
 *
 * O doctor diagnostica e imprime. **Não escreve no código do cliente** — um `init` que gera arquivo é
 * outra ferramenta, e misturar as duas transforma um comando de diagnóstico em algo que ninguém roda
 * sem medo.
 */
import { SDK_VERSION } from '../core/sdk-version.js';
import { checkConfig, type ConfigCheckResult } from './check-config.js';
import { checkConnectivity, type ConnectivityResult } from './check-connectivity.js';
import { checkModuleFormat, type ModuleFormatCheck } from './check-module-format.js';
import { detectStack, type DetectedStack, type PackageJsonLike } from './detect-stack.js';
import { fetchAudit, type AuditFinding, type FetchAuditResult } from './fetch-audit.js';
import { probeIngest, type ProbeResult } from './probe-ingest.js';

export type DoctorEnv = Partial<Record<'STACKTRACE_API_KEY' | 'STACKTRACE_SERVICE_ID' | 'STACKTRACE_ENDPOINT', string>>;

export type DoctorDeps = {
  cwd: string;
  env: DoctorEnv;
  /** `null` quando não há `package.json` legível no diretório atual. */
  packageJson: PackageJsonLike | null;
  fetchImpl: Parameters<typeof checkConnectivity>[1] & Parameters<typeof probeIngest>[1];
  /** Versão do Node do processo. Injetável para teste. */
  nodeVersion?: string;
};

export type DoctorReport = {
  /** Versao do SDK que produziu este relatorio — o consumidor de `--json` precisa correlacionar. */
  sdkVersion: string;
  stack: DetectedStack;
  /** CommonJS num Node sem `require()` de ESM não carrega o SDK. Informativo: não altera o exit code. */
  moduleFormat: ModuleFormatCheck;
  config: ConfigCheckResult;
  /** `null` quando a etapa não rodou — config inválida torna o resultado sem sentido. */
  connectivity: ConnectivityResult | null;
  probe: ProbeResult | null;
  findings: AuditFinding[] | null;
  auditError: string | null;
  /** 0 = tudo certo. É o código de saída do processo, e o que o CI do cliente lê. */
  exitCode: number;
};

/**
 * Cada etapa depende da anterior ter passado.
 *
 * Rodar conectividade com `serviceId` inválido produz um 400 que o dev lê como "servidor com
 * problema", quando a causa está no `.env` dele. Parar na primeira falha mantém uma causa por
 * execução — é o oposto de despejar cinco erros e deixar o dev adivinhar qual é a raiz.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const stack = detectStack(deps.packageJson ?? {});
  const config = checkConfig(deps.env);

  const report: DoctorReport = {
    sdkVersion: SDK_VERSION,
    stack,
    moduleFormat: checkModuleFormat(deps.packageJson, deps.nodeVersion ?? process.versions.node),
    config,
    connectivity: null,
    probe: null,
    findings: null,
    auditError: null,
    exitCode: 0,
  };

  if (!config.ok) {
    report.exitCode = 1;
    return report;
  }

  // Depois de `config.ok` os três valores existem e têm formato válido.
  const creds = {
    endpoint: deps.env.STACKTRACE_ENDPOINT as string,
    apiKey: deps.env.STACKTRACE_API_KEY as string,
    serviceId: deps.env.STACKTRACE_SERVICE_ID as string,
  };

  report.connectivity = await checkConnectivity(creds, deps.fetchImpl);
  if (!report.connectivity.ok) {
    report.exitCode = 1;
    return report;
  }

  report.probe = await probeIngest(creds, deps.fetchImpl);
  if (!report.probe.ok) {
    report.exitCode = 1;
    return report;
  }

  // Os findings são informativos: a instalação FUNCIONA mesmo com gaps de instrumentação, então um
  // `fail` aqui não vira exit code — viraria CI vermelho por um aviso, e o cliente desligaria o
  // doctor inteiro.
  const audit: FetchAuditResult = await fetchAudit(creds, deps.fetchImpl);
  if (audit.ok) {
    report.findings = audit.audit.findings;
  } else {
    report.auditError = audit.detail !== '' ? audit.detail : `HTTP ${audit.status ?? '?'}`;
  }

  return report;
}
