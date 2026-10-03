import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import * as sdk from 'cc-stacktracer';
import plugin from 'cc-stacktracer/fastify';
import { runFastifyScenario } from '../lib/fastify-scenario.mjs';

const pluginAbsent = !existsSync(new URL('./node_modules/fastify-plugin', import.meta.url));
await runFastifyScenario({ name: 'fastify4', Fastify, sdk, plugin, pluginAbsent });
