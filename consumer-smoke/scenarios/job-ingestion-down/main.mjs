import { fileURLToPath } from 'node:url';
import { closedPortUrl, createCheck } from '../lib/check.mjs';
import { runChild } from '../lib/run-child.mjs';

const check = createCheck('job-ingestion-down');
const result = await runChild(fileURLToPath(new URL('./job.mjs', import.meta.url)), [await closedPortUrl()]);
const lines = result.output.split('\n').filter((l) => l.includes('[cc-stacktracer]'));
check.equal(result.code, 0, 'o job sai com 0');
check.ok(result.ms < 5_000, `saiu em ${result.ms}ms (< 5000)`);
check.equal(lines.length, 1, `um único aviso de perda (${JSON.stringify(lines)})`);
check.ok(lines[0]?.includes('still queued') === true, 'o aviso diz que a telemetria ficou na fila');
check.ok(lines[0]?.includes('ECONNREFUSED') === true, 'o aviso traz o porquê (ECONNREFUSED)');
check.done();
