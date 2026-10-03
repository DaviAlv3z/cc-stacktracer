import { AppFactory } from '@adonisjs/core/factories/app';
import { Logger } from '@adonisjs/core/logger';
import { Emitter } from '@adonisjs/core/events';
import { Database } from '@adonisjs/lucid/database';
import * as sdk from 'cc-stacktracer';
import { createLucidStackTracePlugin } from 'cc-stacktracer/db-lucid';
import { runLucidScenario } from '../lib/lucid-scenario.mjs';

await runLucidScenario({
  name: 'lucid22-mysql',
  mode: 'auto',
  client: 'mysql2',
  appRoot: new URL('./', import.meta.url),
  importer: (path) => import(path),
  AppFactory,
  Logger,
  Emitter,
  Database,
  sdk,
  createLucidStackTracePlugin,
});
