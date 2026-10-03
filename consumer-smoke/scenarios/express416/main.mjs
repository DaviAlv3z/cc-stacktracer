import express from 'express';
import * as sdk from 'cc-stacktracer';
import * as integration from 'cc-stacktracer/express';
import { runExpressScenario } from '../lib/express-scenario.mjs';

await runExpressScenario({ name: 'express416', express, sdk, integration });
