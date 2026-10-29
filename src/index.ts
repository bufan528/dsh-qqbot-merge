/**
 * dsh-qqbot-merge — QQ Bot IM channel plugin for deepseek-harness
 *
 * 本文件是官方 `@tencent-connect/dsh-qqbot` 0.5.3（MIT）维护分支的 cordis 插件入口：
 * 在保留官方网关组装 / 绑定编排的前提下，新增
 *
 * 1. `MergeCoordinator`：连续消息智能合并（忙碌期间 steer、空闲 followup、静默窗口
 *    合并、上限溢出兜底（通知 + 下一批 followup）、按 QQ 会话隔离）；
 * 2. `QqbotMergeRuntime`：对外 provide cordis 服务 `qqbotMerge`（契约 version=1），
 *    并把「同一轮单条回复」的 hooks 交给出站层。
 *
 * 配置持久化只写本插件自己的 cordis row config（`qqbotMerge` 字段），不写其他插件
 * 的 profile，也不写 Memory Vault 的配置。
 */
import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema, type ImQQBotConfig } from './config.ts';
import { bootstrapGateway, type MergeGatewayBinding } from './gateway/index.ts';
import type { DshAgentRegistry } from './session/index.ts';
import { getProfileDir, resolveEnv } from './shared/index.ts';
import { ensureCredentials, persistCredentialsToProfile, registerBoundCredentialRoutes, updateProfileConfig } from './setup/index.ts';
import type { Logger } from './types.ts';
import { normalizeMergeConfig } from './merge/contract.ts';
import { MergeCoordinator } from './merge/coordinator.ts';
import { attachMergeRoutes } from './merge/routes.ts';
import { QqbotMergeRuntime } from './merge/service.ts';

// ── Cordis 插件元数据 ──
/** Cordis fiber 名。刻意与上游 `im-qqbot` 不同，避免与官方插件同时加载时混淆。 */
export const name = 'im-qqbot-merge';
export const inject = ['agents'];
export const Config = ConfigSchema;
/**
 * 本插件对外提供的服务名。
 *
 * 注意：cordis 4.x 并不把模块级 `provide` 数组当作注册机制（注册只有
 * `Service` 子类构造或 `ctx.provide()`）；这里保留导出只为声明意图，
 * 真正的注册在 {@link apply} 里调用 `ctx.provide('qqbotMerge', runtime)`。
 */
export const provide = ['qqbotMerge'];

export type { ImQQBotConfig } from './config.ts';

/** 入口用到的 cordis 能力（不硬依赖具体类型，缺失时降级并如实记录日志）。 */
interface ServicesContext {
  provide?: (name: string, value: unknown) => unknown;
  effect?: (execute: () => () => void, label?: string) => void;
}

// ── 插件主体 ──
export async function apply(ctx: Context, config: ImQQBotConfig): Promise<void> {
  const agents = (ctx as unknown as Record<string, unknown>).agents as DshAgentRegistry;
  const logger: Logger = ((ctx as unknown as Record<string, unknown>).logger as Logger) ?? console;

  // ── 合并协调器 + qqbotMerge 服务 ──
  // 先于凭据判断创建：即使尚未绑定（扫码流程中），服务也存在，Memory Vault 能读到
  // 真实配置与（零）计数，而不是被误判为「官方插件、无扩展点」。
  const mergeConfig = normalizeMergeConfig((config as unknown as { qqbotMerge?: unknown }).qqbotMerge);
  const coordinator = new MergeCoordinator({ logger });
  const mergeRuntime = new QqbotMergeRuntime(
    {
      coordinator,
      logger,
      streamingAvailable: () => config.streaming === true,
      persist: (patch) => updateProfileConfig(patch, getProfileDir() ?? undefined, logger),
    },
    mergeConfig,
  );
  const merge: MergeGatewayBinding = { coordinator, replyHooks: mergeRuntime };

  const services = ctx as unknown as ServicesContext;
  if (typeof services.provide === 'function') {
    try {
      services.provide('qqbotMerge', mergeRuntime);
      logger.info('qqbotMerge service provided (contract qqbot-merge@v1)');
    } catch (error) {
      // 不假装成功：服务没注册上就必须在日志里说清楚（Memory Vault 侧会显示 BLOCKED）
      logger.error(`qqbotMerge 服务注册失败（ctx.provide 抛错）: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    logger.error('qqbotMerge 服务未注册：当前 cordis 上下文没有 provide()，Memory Vault 将显示契约不可用');
  }

  if (typeof services.effect === 'function') {
    services.effect(() => () => {
      coordinator.dispose();
    }, 'qqbot-merge.timers');
  }

  let appId = resolveEnv(config.appId, 'QQBOT_APPID');
  let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');

  // ── 凭据缺失时唤起扫码绑定 ──
  if (!appId || !appSecret) {
    logger.info('凭据未配置，启动扫码绑定...');

    // 合并设置路由：未绑定（扫码中）fiber 也必须注册。扫码成功后写入
    // profile 会触发 HMR，新 fiber 走下面的已绑定分支再注册一次；
    // 两条分支都接上，设置页的「连续消息智能合并」面板才始终可用。
    attachMergeRoutes(ctx, mergeRuntime, logger);

    // 关键：不 await 扫码结果。boot 会等 Loader 树稳定（loader.await()），
    // 无限期等待用户扫码会阻塞 Host ready——Desktop 界面无法进入、
    // Web 的 URL 延迟输出。绑定编排（路由/呈现/生命周期）在
    // ensureCredentials 的同步阶段即完成，凭据就绪后由异步链接管。
    void ensureCredentials(ctx, { logger, config: { ...config } })
      .then((credentials): void => {
        if (!credentials) {
          // null 包括：扫码取消、手动提交（已另行持久化）、流程失败
          logger.info('扫码绑定流程结束（未获取凭据或已手动配置）');
          return;
        }

        // 持久化到 profile：成功则等待热更新重载，失败则用凭据直接启动。
        // 注意：不写入 process.env——resolveEnv 的 env 回退属于用户显式
        // export 的配置语义，运行时写入会与解绑清理不对齐（解绑后 HMR
        // 重载的新 fiber 仍从 env 读到旧凭据，状态停留 bound）
        const persisted = persistCredentialsToProfile(credentials, getProfileDir() ?? undefined, logger);
        if (persisted) {
          // 写入 cordis.patch.yml 会触发 dsh 热更新，自动重新加载本插件。
          logger.info('配置已保存，等待热更新重新加载...');
          return;
        }
        logger.warn('凭据未能持久化，本次进程将使用环境变量凭据启动（重启后需重新绑定）');
        // 本 fiber 已激活（ctx 有效），直接以凭据启动网关
        void bootstrapGateway(ctx, agents, {
          ...config,
          appId: credentials.appId,
          appSecret: credentials.appSecret,
        }, logger, merge).catch((err: unknown) => {
          logger.error(`网关启动失败: ${err instanceof Error ? err.message : String(err)}`);
        });
      })
      .catch((err: unknown) => {
        // 全兜：unhandled rejection 会被宿主 fail-loud 判致命
        logger.error(`扫码绑定流程异常: ${err instanceof Error ? err.message : String(err)}`);
      });

    // apply 立即完成，插件 fiber 进入 ACTIVE，Host ready 不再被阻塞
    return;
  }

  // 已绑定：注册常驻路由（状态回显 + 手动编辑/更换凭据 + 配置编辑）
  registerBoundCredentialRoutes(ctx, logger, appId, { ...config });

  // 合并设置路由：已绑定 fiber（与扫码分支互斥，同一 fiber 只会走一条）
  attachMergeRoutes(ctx, mergeRuntime, logger);

  const resolvedConfig: ImQQBotConfig = { ...config, appId, appSecret };

  await bootstrapGateway(ctx, agents, resolvedConfig, logger, merge);
}
