/**
 * 连续消息合并设置路由测试
 *
 * 用假的 webServer 捕获注册的 handler，验证：
 * - 路由注册形状（exact + 固定路径）
 * - GET 返回 `{ ok, status }`、同源 Origin 放行
 * - POST 合法 patch → runtime.setConfig → 持久化 + revision 递增
 * - 非法值一律 400（且不改动运行期配置）、未 trusted 403、方法 405
 * - attachMergeRoutes 在 ctx.inject 作用域内注册/注销（未绑定与已绑定 fiber 共用）
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { MERGE_CONFIG_PATH } from '../shared/merge-protocol.ts';
import { attachMergeRoutes, registerMergeRoutes, type MergeRoutesRuntime, type WebRoute } from './routes.ts';
import { MergeCoordinator } from './coordinator.ts';
import { QqbotMergeRuntime } from './service.ts';
import type { Logger } from '../types.ts';
import type { QqbotMergeStatus } from './contract.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** 假 req：EventEmitter + headers/method + 可读 body（与 bind-routes.test.ts 同款） */
function fakeReq(method: string, headers: Record<string, string | undefined> = {}, body?: string): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  (req as { headers: Record<string, string | undefined> }).headers = headers;
  Object.assign(req, {
    resume: vi.fn(),
    [Symbol.asyncIterator]() {
      const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
      let index = 0;
      return {
        next: () => Promise.resolve(index < chunks.length
          ? { done: false, value: chunks[index++] as Buffer }
          : { done: true as const, value: undefined }),
      };
    },
  });
  return req;
}

/** 假 res：捕获 writeHead/end */
function fakeRes(): ServerResponse & { statusCode: number; body: string; headers: Record<string, string> } {
  const res = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(payload?: string) {
      if (payload !== undefined) res.body += payload;
    },
  };
  return res as unknown as ServerResponse & { statusCode: number; body: string; headers: Record<string, string> };
}

interface Harness {
  routes: Map<string, WebRoute>;
  runtime: QqbotMergeRuntime;
  persist: ReturnType<typeof vi.fn>;
  logger: Logger;
}

function createHarness(): Harness {
  const routes = new Map<string, WebRoute>();
  const webServer = {
    register(route: WebRoute): () => void {
      routes.set(route.path, route);
      return () => { routes.delete(route.path); };
    },
  };
  const logger = createLogger();
  const coordinator = new MergeCoordinator({ logger });
  const persist = vi.fn(() => true);
  const runtime = new QqbotMergeRuntime(
    {
      coordinator,
      logger,
      streamingAvailable: () => false,
      persist,
    },
    coordinator.getConfig(),
  );
  registerMergeRoutes(webServer, runtime, logger);
  return { routes, runtime, persist, logger };
}

async function invoke(
  harness: Harness,
  method: string,
  options: { headers?: Record<string, string | undefined>; body?: string } = {},
): Promise<{ statusCode: number; body: string; json: Record<string, unknown> }> {
  const route = harness.routes.get(MERGE_CONFIG_PATH);
  if (route === undefined) throw new Error('route not registered');
  const res = fakeRes();
  await route.handler(fakeReq(method, options.headers, options.body), res);
  return {
    statusCode: res.statusCode,
    body: res.body,
    json: JSON.parse(res.body) as Record<string, unknown>,
  };
}

function post(harness: Harness, payload: unknown, headers?: Record<string, string | undefined>) {
  return invoke(harness, 'POST', {
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

describe('registerMergeRoutes：注册形状', () => {
  it('注册 /qqbot/im-qqbot/merge 的 exact 路由', () => {
    const { routes } = createHarness();
    expect(MERGE_CONFIG_PATH).toBe('/qqbot/im-qqbot/merge');
    const route = routes.get(MERGE_CONFIG_PATH);
    expect(route?.kind).toBe('exact');
    expect(routes.size).toBe(1);
  });
});

describe('registerMergeRoutes：GET', () => {
  it('返回 { ok: true, status }，status 即 runtime.getStatus()', async () => {
    const harness = createHarness();
    const { statusCode, json } = await invoke(harness, 'GET');
    expect(statusCode).toBe(200);
    expect(json['ok']).toBe(true);
    const status = json['status'] as QqbotMergeStatus;
    expect(status.contract).toEqual({ name: 'qqbot-merge', version: 1 });
    expect(status.config).toMatchObject({
      enabled: false,
      windowMs: 800,
      maxBatchMessages: 8,
      maxBatchChars: 4000,
      scope: { c2c: true, group: false },
      busyPolicy: 'steer',
      replyMode: 'single-message',
    });
    expect(status.applied.revision).toBe(0);
    expect(status.counters.batchesMerged).toBe(0);
    expect(status.lastBatch).toBeNull();
    expect(json['status']).toEqual(harness.runtime.getStatus());
  });

  it('同源 Origin 放行', async () => {
    const harness = createHarness();
    const { statusCode } = await invoke(harness, 'GET', {
      headers: { origin: 'http://127.0.0.1:63908', host: '127.0.0.1:63908' },
    });
    expect(statusCode).toBe(200);
  });

  it('跨源 Origin 返回 403', async () => {
    const harness = createHarness();
    const { statusCode, json } = await invoke(harness, 'GET', {
      headers: { origin: 'https://evil.example', host: '127.0.0.1:63908' },
    });
    expect(statusCode).toBe(403);
    expect(json['ok']).toBe(false);
  });
});

describe('registerMergeRoutes：POST 正常路径', () => {
  it('合法 patch 写入运行期并持久化到本插件 row config', async () => {
    const harness = createHarness();
    const { statusCode, json } = await post(harness, {
      config: {
        enabled: true,
        windowMs: 1200,
        maxBatchMessages: 5,
        maxBatchChars: 6000,
        scope: { c2c: true, group: true },
        busyPolicy: 'queue',
        replyMode: 'per-step',
      },
    });

    expect(statusCode).toBe(200);
    expect(json['ok']).toBe(true);
    const status = json['status'] as QqbotMergeStatus;
    expect(status.config).toMatchObject({
      enabled: true,
      windowMs: 1200,
      maxBatchMessages: 5,
      maxBatchChars: 6000,
      scope: { c2c: true, group: true },
      busyPolicy: 'queue',
      replyMode: 'per-step',
    });
    expect(status.applied.revision).toBe(1);
    expect(status.applied.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(harness.persist).toHaveBeenCalledTimes(1);
    const calls = harness.persist.mock.calls as unknown as Array<[Record<string, unknown>]>;
    expect(calls[0]?.[0]['qqbotMerge']).toMatchObject({ enabled: true, windowMs: 1200, busyPolicy: 'queue' });
  });

  it('支持只提交部分字段（其余保持现值）', async () => {
    const harness = createHarness();
    const first = await post(harness, { config: { enabled: true, windowMs: 1500 } });
    expect(first.statusCode).toBe(200);

    const second = await post(harness, { config: { maxBatchMessages: 12 } });
    expect(second.statusCode).toBe(200);
    const status = second.json['status'] as QqbotMergeStatus;
    expect(status.config).toMatchObject({ enabled: true, windowMs: 1500, maxBatchMessages: 12, maxBatchChars: 4000 });
    expect(status.applied.revision).toBe(2);
  });

  it('POST 后 GET 读到新配置', async () => {
    const harness = createHarness();
    await post(harness, { config: { replyMode: 'per-step' } });
    const { json } = await invoke(harness, 'GET');
    expect((json['status'] as QqbotMergeStatus).config.replyMode).toBe('per-step');
  });
});

describe('registerMergeRoutes：POST 非法值', () => {
  const invalid: ReadonlyArray<{ name: string; payload: unknown }> = [
    { name: 'enabled 非布尔', payload: { config: { enabled: 'yes' } } },
    { name: 'windowMs 非数字', payload: { config: { windowMs: '800' } } },
    { name: 'windowMs 小于下限', payload: { config: { windowMs: 50 } } },
    { name: 'windowMs 超过上限', payload: { config: { windowMs: 20000 } } },
    { name: 'windowMs 非整数', payload: { config: { windowMs: 800.5 } } },
    { name: 'maxBatchMessages 小于下限', payload: { config: { maxBatchMessages: 0 } } },
    { name: 'maxBatchMessages 超过上限', payload: { config: { maxBatchMessages: 51 } } },
    { name: 'maxBatchChars 小于下限', payload: { config: { maxBatchChars: 100 } } },
    { name: 'maxBatchChars 超过上限', payload: { config: { maxBatchChars: 20001 } } },
    { name: 'busyPolicy 未知枚举', payload: { config: { busyPolicy: 'abort' } } },
    { name: 'replyMode 未知枚举', payload: { config: { replyMode: 'per-token' } } },
    { name: 'scope 非对象', payload: { config: { scope: 'c2c' } } },
    { name: 'scope.c2c 非布尔', payload: { config: { scope: { c2c: 'yes' } } } },
    { name: 'scope 未知子字段', payload: { config: { scope: { channel: true } } } },
    { name: '未知字段', payload: { config: { enabled: true, nope: 1 } } },
    { name: 'config 为空对象', payload: { config: {} } },
    { name: '缺少 config', payload: {} },
    { name: 'config 非对象', payload: { config: [1, 2] } },
    { name: '顶层未知字段', payload: { config: { enabled: true }, extra: true } },
    { name: '请求体不是对象', payload: [1, 2] },
  ];

  for (const item of invalid) {
    it(`400：${item.name}`, async () => {
      const harness = createHarness();
      const { statusCode, json } = await post(harness, item.payload);
      expect(statusCode).toBe(400);
      expect(json['ok']).toBe(false);
      expect(typeof json['error']).toBe('string');
      // 非法请求不得改动运行期配置，也不得触发持久化
      expect(harness.runtime.getStatus().applied.revision).toBe(0);
      expect(harness.runtime.getConfig().enabled).toBe(false);
      expect(harness.persist).not.toHaveBeenCalled();
    });
  }

  it('400：请求体不是合法 JSON', async () => {
    const harness = createHarness();
    const { statusCode, json } = await post(harness, '{"config":');
    expect(statusCode).toBe(400);
    expect(json['ok']).toBe(false);
    expect(String(json['error'])).toContain('invalid request body');
  });
});

describe('registerMergeRoutes：方法 / 信任边界', () => {
  it('非 GET/POST 返回 405', async () => {
    const harness = createHarness();
    const { statusCode } = await invoke(harness, 'PUT');
    expect(statusCode).toBe(405);
  });

  it('跨源 POST 返回 403 且不写入', async () => {
    const harness = createHarness();
    const { statusCode } = await post(harness, { config: { enabled: true } }, {
      origin: 'https://evil.example',
      host: '127.0.0.1:63908',
    });
    expect(statusCode).toBe(403);
    expect(harness.runtime.getConfig().enabled).toBe(false);
    expect(harness.persist).not.toHaveBeenCalled();
  });

  it('运行期 setConfig 抛错时返回 500 并记录日志', async () => {
    const routes = new Map<string, WebRoute>();
    const webServer = {
      register(route: WebRoute): () => void {
        routes.set(route.path, route);
        return () => { routes.delete(route.path); };
      },
    };
    const logger = createLogger();
    const status = { contract: { name: 'qqbot-merge', version: 1 } } as unknown as QqbotMergeStatus;
    const runtime: MergeRoutesRuntime = {
      getStatus: () => status,
      setConfig: () => Promise.reject(new Error('persist boom')),
    };
    registerMergeRoutes(webServer, runtime, logger);
    const route = routes.get(MERGE_CONFIG_PATH);
    const res = fakeRes();
    await route?.handler(
      fakeReq('POST', { 'content-type': 'application/json' }, JSON.stringify({ config: { enabled: true } })),
      res,
    );
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: 'persist boom' });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('attachMergeRoutes：fiber 挂载', () => {
  function fakeContext(): { ctx: Context; routes: Map<string, WebRoute>; dispose: () => void } {
    const routes = new Map<string, WebRoute>();
    let disposer: (() => void) | undefined;
    const webServer = {
      register(route: WebRoute): () => void {
        routes.set(route.path, route);
        return () => { routes.delete(route.path); };
      },
    };
    const scoped = {
      webServer,
      effect: (fn: () => () => void, _label?: string): void => { disposer = fn(); },
    };
    const ctx = {
      inject: (_deps: readonly string[], callback: (scopedCtx: Context) => void): void => {
        callback(scoped as unknown as Context);
      },
    } as unknown as Context;
    return { ctx, routes, dispose: () => { disposer?.(); } };
  }

  function createRuntime(): { runtime: QqbotMergeRuntime; persist: ReturnType<typeof vi.fn>; logger: Logger } {
    const logger = createLogger();
    const coordinator = new MergeCoordinator({ logger });
    const persist = vi.fn(() => true);
    const runtime = new QqbotMergeRuntime(
      { coordinator, logger, streamingAvailable: () => true, persist },
      coordinator.getConfig(),
    );
    return { runtime, persist, logger };
  }

  it('经 ctx.inject(["webServer"]) 注册，并在作用域 dispose 时注销', () => {
    const { ctx, routes, dispose } = fakeContext();
    const { runtime, logger } = createRuntime();
    attachMergeRoutes(ctx, runtime, logger);
    expect(routes.has(MERGE_CONFIG_PATH)).toBe(true);
    dispose();
    expect(routes.has(MERGE_CONFIG_PATH)).toBe(false);
  });

  it('ctx 没有 inject() 时只记 warn，不抛错', () => {
    const { runtime, logger } = createRuntime();
    expect(() => { attachMergeRoutes({} as Context, runtime, logger); }).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});
