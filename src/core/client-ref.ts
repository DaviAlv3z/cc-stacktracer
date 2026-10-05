import type { ErrorTrackingConfig } from './error-tracking-config.js';
import type { StackTraceClient } from './stacktrace-client.js';
import type { ServiceDescriptor } from './stacktrace-event.types.js';

export type SdkInitConfig = {
  service: ServiceDescriptor;
  environment: string;
  /** Ingestion base URL — used by outbound instrumentation to never trace the SDK's own egress. */
  endpoint: string;
  tenantId?: string;
  projectId?: string;
  /** Resolvida no `init` (opcao > env > padrao). Ausente = padrao. */
  errorTracking?: ErrorTrackingConfig;
  /** `init({ identityOnSpans })`: `user.id` e `subtenant` do escopo nos spans. */
  identityOnSpans?: boolean;
};

let client: StackTraceClient | null = null;
let initConfig: SdkInitConfig | null = null;

export function setSdkRuntime(nextClient: StackTraceClient | null, nextConfig: SdkInitConfig | null): void {
  client = nextClient;
  initConfig = nextConfig;
}

export function getSdkRuntime(): {
  client: StackTraceClient | null;
  initConfig: SdkInitConfig | null;
} {
  return { client, initConfig };
}
