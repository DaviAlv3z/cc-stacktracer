import { AppFactory } from '@adonisjs/core/factories/app';
import { ServerFactory } from '@adonisjs/core/factories/http';
import { ExceptionHandler } from '@adonisjs/core/http';
import * as sdk from 'cc-stacktracer';
import { runAdonisScenario } from '../lib/adonis-scenario.mjs';

await runAdonisScenario({
  name: 'adonis620',
  appRoot: new URL('./', import.meta.url),
  importer: (path) => import(path),
  middlewareImport: () => import('cc-stacktracer/adonis/middleware'),
  AppFactory,
  ServerFactory,
  ExceptionHandler,
  sdk,
});
