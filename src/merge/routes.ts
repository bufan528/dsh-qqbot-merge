/**
 * 连续消息智能合并设置路由 — /qqbot/im-qqbot/merge
 *
 * 注册在 dsh-host-webserver（ctx.webServer）的具名路由：
 * - Web 模式：设置页同源直接访问
 * - Desktop：渲染进程的 fetch 经 IPC 桥自动附加 Host 认证转发
 *
 * 与绑定页路由（setup/bind-routes.ts）的差异：
 * - 未绑定（扫码中）与已绑定两种 fiber 都注册（见 index.ts 两条分支）：
 *   扫码成功后写入 profile 会触发 HMR，旧 fiber 卸载、新 fiber 走已绑定
 *   分支；两条分支都接上才能保证设置页的合并面板不会在扫码前后失效。
 * - 配置写入直接调用 runtime.setConfig()：运行期即时生效 + 持久化到本插件
 *   自己的 cordis row config（`qqbotMerge` 字段），不写别人的 profile。
 *
 * 协议：
 * - GET  → `{ ok: true, status }`，status 即 runtime.getStatus()
 * - POST body `{ config: Partial<MergeConfig> }` → 校验后 runtime.setConfig，
 *   返回同样的 `{ ok: true, status }`；非法值 400。
 *
 * 校验策略：HTTP 边界比运行期更严格——数值必须落在契约声明的范围内
 * （越界直接 400 而不是被 setConfig 静默截断），未知字段一律拒绝，
 * 避免「看起来保存成功、实际值被改写」。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { Logger } from '../types.ts';
import {
  QQBOT_MERGE_BUSY_POLICIES,
  QQBOT_MERGE_REPLY_MODES,
  type QqbotMergeConfig,
  type QqbotMergeStatus,
} from './contract.ts';
import { MERGE_CONFIG_PATH } from '../shared/merge-protocol.ts';
import { readJsonBody, sendJson, trusted, type WebRoute, type WebServerLike } from '../setup/bind-routes.ts';

// ── 校验 ──

/** 可经 HTTP 修改的字段白名单（其余字段只能走 profile patch / 环境变量） */
const PATCH_KEYS = new Set(['enabled', 'windowMs', 'maxBatchMessages', 'maxBatchChars', 'scope', 'busyPolicy', 'replyMode']);

/** 数值字段的合法区间（与 merge/contract.ts 的归一化区间一致） */
function readInt(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  label: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${key} 必须是数字`);
  if (!Number.isInteger(value)) throw new TypeError(`${key} 必须是整数`);
  if (value < min || value > max) throw new TypeError(`${label}（${key}）需在 ${min}–${max} 之间`);
  return value;
}

/**
 * 严格校验并构造配置 patch（非法值抛 TypeError，调用方转 400）。
 *
 * 不直接复用 service 的 applyMergeConfigPatch：那里按契约做「归一化」
 * （越界截断、非法枚举回落默认），对 HTTP 用户来说等于悄悄改值；
 * 设置页需要明确的错误提示。
 */
export function validateMergePatch(raw: unknown): Partial<QqbotMergeConfig> {
  if (raw === undefined) throw new TypeError('缺少 config 对象');
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('config 必须是 JSON 对象');
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) throw new TypeError('config 不能为空（至少提交一个字段）');
  for (const key of keys) {
    if (!PATCH_KEYS.has(key)) throw new TypeError(`不支持的字段: ${key}`);
  }

  const patch: Partial<QqbotMergeConfig> = {};

  if (record['enabled'] !== undefined) {
    if (typeof record['enabled'] !== 'boolean') throw new TypeError('enabled 必须是布尔值');
    patch.enabled = record['enabled'];
  }

  const windowMs = readInt(record, 'windowMs', 100, 10000, '静默合并窗口');
  if (windowMs !== undefined) patch.windowMs = windowMs;
  const maxBatchMessages = readInt(record, 'maxBatchMessages', 1, 50, '单批条数上限');
  if (maxBatchMessages !== undefined) patch.maxBatchMessages = maxBatchMessages;
  const maxBatchChars = readInt(record, 'maxBatchChars', 200, 20000, '单批字符上限');
  if (maxBatchChars !== undefined) patch.maxBatchChars = maxBatchChars;

  if (record['scope'] !== undefined) {
    const scope = record['scope'];
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('scope 必须是对象');
    const scopeRecord = scope as Record<string, unknown>;
    for (const key of Object.keys(scopeRecord)) {
      if (key !== 'c2c' && key !== 'group') throw new TypeError(`不支持的字段: scope.${key}`);
    }
    const nextScope: Partial<QqbotMergeConfig['scope']> = {};
    for (const key of ['c2c', 'group'] as const) {
      const value = scopeRecord[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') throw new TypeError(`scope.${key} 必须是布尔值`);
      nextScope[key] = value;
    }
    // 契约里 scope 是完整对象，但 patch 允许子字段可选（runtime 会与现值合并）
    patch.scope = nextScope as QqbotMergeConfig['scope'];
  }

  if (record['busyPolicy'] !== undefined) {
    const value = record['busyPolicy'];
    if (typeof value !== 'string' || !(QQBOT_MERGE_BUSY_POLICIES as readonly string[]).includes(value)) {
      throw new TypeError(`busyPolicy 只能是 ${QQBOT_MERGE_BUSY_POLICIES.join(' / ')}`);
    }
    patch.busyPolicy = value as QqbotMergeConfig['busyPolicy'];
  }
  if (record['replyMode'] !== undefined) {
    const value = record['replyMode'];
    if (typeof value !== 'string' || !(QQBOT_MERGE_REPLY_MODES as readonly string[]).includes(value)) {
      throw new TypeError(`replyMode 只能是 ${QQBOT_MERGE_REPLY_MODES.join(' / ')}`);
    }
    patch.replyMode = value as QqbotMergeConfig['replyMode'];
  }

  return patch;
}

// ── 路由处理 ──

/** 本路由只依赖 runtime 的这两个方法（QqbotMergeRuntime 结构兼容） */
export interface MergeRoutesRuntime {
  getStatus(): QqbotMergeStatus;
  setConfig(patch: Partial<QqbotMergeConfig>): Promise<QqbotMergeStatus>;
}

async function handleMerge(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: MergeRoutesRuntime,
  logger: Logger,
): Promise<void> {
  if (!trusted(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    sendJson(res, 200, { ok: true, status: runtime.getStatus() });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: `invalid request body: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' });
    return;
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'config') {
      sendJson(res, 400, { ok: false, error: `不支持的字段: ${key}` });
      return;
    }
  }

  let patch: Partial<QqbotMergeConfig>;
  try {
    patch = validateMergePatch(record['config']);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof TypeError ? err.message : String(err) });
    return;
  }

  try {
    // setConfig：运行期生效 + 持久化到本插件 row config + revision 递增
    const status = await runtime.setConfig(patch);
    sendJson(res, 200, { ok: true, status });
  } catch (err) {
    // 校验已通过，走到这里说明运行期自身出错（如持久化回调抛错）
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`qqbot-merge: 合并配置写入失败: ${message}`);
    sendJson(res, 500, { ok: false, error: message });
  }
}

/**
 * 注册合并设置路由（同源 GET/POST）。
 *
 * @param webServer - ctx.webServer
 * @param runtime - QqbotMergeRuntime（契约 qqbot-merge@v1）
 * @param logger - 日志
 * @returns 注销函数（与插件 fiber 生命周期绑定）
 */
export function registerMergeRoutes(
  webServer: WebServerLike,
  runtime: MergeRoutesRuntime,
  logger: Logger,
): () => void {
  const dispose = webServer.register({
    kind: 'exact',
    path: MERGE_CONFIG_PATH,
    handler: (req, res) => handleMerge(req, res, runtime, logger),
  });
  logger.info(`im-qqbot: 连续消息合并设置路由已就绪: ${MERGE_CONFIG_PATH}`);
  return dispose;
}

/**
 * 把合并设置路由挂到当前插件 fiber。
 *
 * 与绑定路由相同的可选注入方式：webServer 未就绪（CLI profile）时插件
 * 照常加载，服务就绪/替换时回调重跑（自动注销旧路由、注册新路由）。
 * **未绑定（扫码中）与已绑定两种 fiber 都必须调用**——扫码成功会触发
 * HMR 重载，漏掉任一条分支都会让设置页在某一阶段失去合并面板。
 */
export function attachMergeRoutes(ctx: Context, runtime: MergeRoutesRuntime, logger: Logger): void {
  const inject = (ctx as unknown as {
    inject?: (deps: readonly string[], callback: (scoped: Context) => void) => unknown;
  }).inject;
  if (typeof inject !== 'function') {
    logger.warn('im-qqbot: 当前 cordis 上下文没有 inject()，连续消息合并设置路由未注册');
    return;
  }

  void inject.call(ctx, ['webServer'], (scoped) => {
    const webServer = (scoped as unknown as { webServer?: WebServerLike }).webServer;
    if (webServer === undefined || typeof webServer.register !== 'function') return;
    const dispose = registerMergeRoutes(webServer, runtime, logger);
    // 回调作用域（服务卸载/替换、插件卸载）连带注销路由
    const effect = (scoped as unknown as {
      effect?: (fn: () => () => void, label?: string) => void;
    }).effect;
    if (typeof effect === 'function') {
      effect.call(scoped, () => dispose, 'im-qqbot.merge-routes');
    }
  });
}

/** 路由的局部投影（供测试/调用方复用，避免重复声明） */
export type { WebRoute, WebServerLike };
