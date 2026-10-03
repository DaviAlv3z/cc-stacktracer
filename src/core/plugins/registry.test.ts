import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasDependency } from './auto-loader.js';
import { clearPluginsForTests, getPlugins, initRegisteredPlugins, register, resetPluginInitState } from './registry.js';
import type { StackTracePlugin } from './types.js';
import { init, shutdown } from '../../index.js';

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const initSdk = (): void =>
  init({ apiKey: 'k', serviceId: SERVICE_ID, endpoint: 'http://localhost:1', transport: async () => {} });

describe('plugin registry', () => {
  afterEach(async () => {
    clearPluginsForTests();
    resetPluginInitState();
    await shutdown();
  });

  it('register and use add plugins; getPlugins returns copy', () => {
    const p: StackTracePlugin = {
      name: 'a',
      type: 'custom',
      init: () => {},
    };
    register(p);
    expect(getPlugins()).toHaveLength(1);
    expect(getPlugins()[0]?.name).toBe('a');
  });

  it('initRegisteredPlugins runs init once per name', async () => {
    const spy = vi.fn();
    register({
      name: 'x',
      type: 'runtime',
      init: spy,
    });
    await initRegisteredPlugins();
    await initRegisteredPlugins();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('um plugin cujo init lança é pulado; os outros ainda inicializam', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const good = vi.fn();
    register({
      name: 'broken',
      type: 'custom',
      init: () => {
        throw new Error('boom');
      },
    });
    register({ name: 'good', type: 'custom', init: good });
    await expect(initRegisteredPlugins()).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('register() depois do init() inicializa o plugin', async () => {
    initSdk();
    const spy = vi.fn();
    register({ name: 'tardio', type: 'db', init: spy });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  it('init() inicializa os plugins registrados antes dele', async () => {
    const spy = vi.fn();
    register({ name: 'antecipado', type: 'db', init: spy });
    expect(spy).not.toHaveBeenCalled();
    initSdk();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });

  it('inits concorrentes rodam o init de cada plugin uma vez, e os dois esperam por ele', async () => {
    let finished = false;
    const spy = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
    });
    register({ name: 'lento', type: 'db', init: spy });
    await Promise.all([initRegisteredPlugins(), initRegisteredPlugins()]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(finished).toBe(true);
  });

  it('register() sem SDK iniciado só registra', () => {
    const spy = vi.fn();
    register({ name: 'sem-sdk', type: 'db', init: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  it('init de plugin substituído (mesmo nome) não marca o nome como iniciado', async () => {
    let release!: () => void;
    register({ name: 'dup', type: 'db', init: () => new Promise<void>((resolve) => (release = resolve)) });
    const running = initRegisteredPlugins();
    let calls = 0;
    const second = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('primeira tentativa falha');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    register({ name: 'dup', type: 'db', init: second });
    await initRegisteredPlugins();
    release();
    await running;
    await initRegisteredPlugins();
    expect(second).toHaveBeenCalledTimes(2);
  });
});

describe('hasDependency', () => {
  it('returns true for zod (always present in this repo)', () => {
    expect(hasDependency('zod')).toBe(true);
  });

  it('returns false for a non-existent package name', () => {
    expect(hasDependency('__non_existent_pkg_cc_stacktrace__')).toBe(false);
  });
});
