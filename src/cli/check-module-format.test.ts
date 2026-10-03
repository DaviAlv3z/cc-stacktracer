import { describe, expect, it } from 'vitest';
import { checkModuleFormat, nodeSupportsRequireEsm } from './check-module-format.js';

describe('nodeSupportsRequireEsm', () => {
  it.each([
    ['18.20.8', false],
    ['20.18.3', false],
    ['20.19.0', true],
    ['21.7.3', false],
    ['22.11.0', false],
    ['22.12.0', true],
    ['23.0.0', true],
    ['24.13.0', true],
  ])('%s → %s', (version, expected) => {
    expect(nodeSupportsRequireEsm(version)).toBe(expected);
  });
});

describe('checkModuleFormat', () => {
  it('"type": "module" é ESM e passa em qualquer Node', () => {
    expect(checkModuleFormat({ type: 'module' }, '18.20.8')).toEqual({ ok: true, format: 'esm' });
  });

  it('CommonJS num Node com require() de ESM passa', () => {
    expect(checkModuleFormat({}, '22.12.0')).toEqual({ ok: true, format: 'cjs' });
  });

  it('CommonJS num Node sem require() de ESM é apontado', () => {
    expect(checkModuleFormat(null, '20.18.0')).toEqual({ ok: false, format: 'cjs', nodeVersion: '20.18.0' });
  });
});
