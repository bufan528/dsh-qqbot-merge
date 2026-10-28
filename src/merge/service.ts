/**
 * qqbotMerge — 扩展对外的 cordis 服务
 *
 * Memory Vault 只消费这个服务（不复制实现）：服务在 → 页面可编辑配置、能读到
 * 运行期真实计数 / 最近批次 / 生效 revision；服务不在 → 页面显示 BLOCKED。
 *
 * 契约（`QQBOT_MERGE_CONTRACT`、状态/配置形状）在 `./contract.ts`，与 Memory Vault
 * 的 `src/shared/qqbot-merge-contract.ts` 逐字一致，version 必须同为 1。
 *
 * 注册方式：插件入口 `index.ts` 在 `apply()` 里调用真实的 cordis API
 * `ctx.provide('qqbotMerge', service)`（cordis 4.0.5 `ReflectService#provide`，
 * 见 docs/evidence/qqbot-merge-implementation.md 的证据段）。
 *
 * 配置持久化：写回插件自己的 cordis row config 的 `qqbotMerge` 字段
 * （profile 的 `cordis.patch.yml` 中本插件行），不写别人的 profile、不写
 * Memory Vault 的配置。写入会触发宿主 HMR 重载本插件（与官方插件保存配置的
 * 行为一致），页面看到的 revision/appliedAt 是**本次进程内**的生效证据。
 *
 * @module dsh-qqbot-merge/merge/service
 */
import type { SessionRecord } from '../session/index.ts'
import type { Logger } from '../types.ts'
import type { ReplyRevisionHooks } from '../transport/reply-revision.ts'
import {
  QQBOT_MERGE_BUSY_POLICIES,
  QQBOT_MERGE_CONTRACT,
  QQBOT_MERGE_REPLY_MODES,
  normalizeMaxBatchChars,
  normalizeMaxBatchMessages,
  normalizeMergeConfig,
  normalizeMergeWindow,
  type QqbotMergeConfig,
  type QqbotMergeService,
  type QqbotMergeStatus,
} from './contract.ts'
import { sessionKeyOf, type MergeCoordinator } from './coordinator.ts'

/** 持久化回调：把 `qqbotMerge` 字段写进本插件自己的 cordis row config。 */
export type QqbotMergePersist = (patch: Record<string, unknown>) => boolean

export interface QqbotMergeRuntimeDeps {
  coordinator: MergeCoordinator
  logger: Logger
  /** 该部署是否具备流式单条消息修订能力（c2c 私聊 + streaming 配置）。 */
  streamingAvailable: () => boolean
  /** 持久化到插件自己的 config；返回是否写入成功。 */
  persist: QqbotMergePersist
  now?: () => Date
}

function cloneConfig(config: QqbotMergeConfig): QqbotMergeConfig {
  return { ...config, scope: { ...config.scope } }
}

function fail(message: string): never {
  throw new TypeError(`qqbotMerge.setConfig: ${message}`)
}

/**
 * 校验并归一化一个配置 patch（不信任调用方：Memory Vault 也会校验，但服务端
 * 必须自己再挡一次，避免把半截/非法配置写进运行期与 profile）。
 */
export function applyMergeConfigPatch(
  current: QqbotMergeConfig,
  patch: Partial<QqbotMergeConfig>,
): QqbotMergeConfig {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) fail('patch 必须是对象')
  const record = patch as Record<string, unknown>
  const next: QqbotMergeConfig = { ...current, scope: { ...current.scope } }

  if (record['enabled'] !== undefined) {
    if (typeof record['enabled'] !== 'boolean') fail('enabled 必须是布尔值')
    next.enabled = record['enabled']
  }
  if (record['windowMs'] !== undefined) {
    if (typeof record['windowMs'] !== 'number' || !Number.isFinite(record['windowMs'])) fail('windowMs 必须是有限数字')
    next.windowMs = normalizeMergeWindow(record['windowMs'])
  }
  if (record['maxBatchMessages'] !== undefined) {
    if (typeof record['maxBatchMessages'] !== 'number' || !Number.isFinite(record['maxBatchMessages'])) fail('maxBatchMessages 必须是有限数字')
    next.maxBatchMessages = normalizeMaxBatchMessages(record['maxBatchMessages'])
  }
  if (record['maxBatchChars'] !== undefined) {
    if (typeof record['maxBatchChars'] !== 'number' || !Number.isFinite(record['maxBatchChars'])) fail('maxBatchChars 必须是有限数字')
    next.maxBatchChars = normalizeMaxBatchChars(record['maxBatchChars'])
  }
  if (record['busyPolicy'] !== undefined) {
    if (typeof record['busyPolicy'] !== 'string' || !(QQBOT_MERGE_BUSY_POLICIES as readonly string[]).includes(record['busyPolicy'])) {
      fail(`未知 busyPolicy：${String(record['busyPolicy'])}`)
    }
    next.busyPolicy = record['busyPolicy'] as QqbotMergeConfig['busyPolicy']
  }
  if (record['replyMode'] !== undefined) {
    if (typeof record['replyMode'] !== 'string' || !(QQBOT_MERGE_REPLY_MODES as readonly string[]).includes(record['replyMode'])) {
      fail(`未知 replyMode：${String(record['replyMode'])}`)
    }
    next.replyMode = record['replyMode'] as QqbotMergeConfig['replyMode']
  }
  if (record['scope'] !== undefined) {
    const scope = record['scope']
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) fail('scope 必须是对象')
    const scopeRecord = scope as Record<string, unknown>
    for (const key of ['c2c', 'group'] as const) {
      if (scopeRecord[key] === undefined) continue
      if (typeof scopeRecord[key] !== 'boolean') fail(`scope.${key} 必须是布尔值`)
      next.scope[key] = scopeRecord[key]
    }
  }
  return next
}

/** 运行期服务：实现契约里的 {@link QqbotMergeService}，同时作为出站回复修订 hooks。 */
export class QqbotMergeRuntime implements QqbotMergeService, ReplyRevisionHooks {
  public readonly contract: { name: string; version: number } = {
    name: QQBOT_MERGE_CONTRACT.name,
    version: QQBOT_MERGE_CONTRACT.version,
  }

  private readonly deps: QqbotMergeRuntimeDeps
  private config: QqbotMergeConfig
  private revision = 0
  private appliedAt: string

  public constructor(deps: QqbotMergeRuntimeDeps, initialConfig: QqbotMergeConfig) {
    this.deps = deps
    this.config = cloneConfig(initialConfig)
    this.deps.coordinator.setConfig(this.config)
    this.appliedAt = this.nowIso()
  }

  // ── QqbotMergeService ──

  public getConfig(): QqbotMergeConfig {
    return cloneConfig(this.config)
  }

  public getStatus(): QqbotMergeStatus {
    const snapshot = this.deps.coordinator.snapshot()
    return {
      contract: { ...this.contract },
      config: cloneConfig(this.config),
      applied: {
        revision: this.revision,
        appliedAt: this.appliedAt,
        activeBatches: snapshot.activeBatches,
        pendingMessages: snapshot.pendingMessages,
      },
      runtime: {
        steerSupported: true,
        steerMechanism: 'agent.steer(input)（DSH 0.2.1-rc.3 公开 Agent API：inbox next-step，不取消当前轮）',
        integration: 'dsh-qqbot 0.5.3 fork + concurrencyGuard urgentPredicate bypass + agent/turn-stopping 收尾并入',
        streamingRevision: this.deps.streamingAvailable(),
        note:
          '真实 QQ 端到端未验证（未替换用户正在运行的插件）。群聊 / 无 msgId / 流式失败时自动降级为轮末单条静态发送；' +
          'steer 遇到轮次已结束等竞态时自动降级 followup 并计数；用户 /stop 走官方 cancel（会清空 inbox，已并入但未被消费的批次会丢弃）。',
      },
      counters: this.deps.coordinator.getCounters(),
      lastBatch: this.deps.coordinator.getLastBatch(),
    }
  }

  /**
   * 写入配置：先归一化/校验，再应用到协调器与出站回复模式，最后持久化到
   * 插件自己的 cordis row config（`qqbotMerge` 字段）。
   */
  public async setConfig(patch: Partial<QqbotMergeConfig>): Promise<QqbotMergeStatus> {
    const next = applyMergeConfigPatch(this.config, patch)
    this.config = next
    this.deps.coordinator.setConfig(next)

    const persisted = this.deps.persist({ qqbotMerge: cloneConfig(next) })
    if (!persisted) {
      this.deps.logger.warn('qqbot-merge: 配置已在内存生效，但持久化失败（重启后会回落到 row config 的旧值）')
    }

    this.revision += 1
    this.appliedAt = this.nowIso()
    return this.getStatus()
  }

  // ── ReplyRevisionHooks（出站「同一轮单条回复」） ──

  /** 该会话是否使用单条回复：合并启用 + replyMode='single-message' + 场景开关打开。 */
  public enabledFor(record: SessionRecord): boolean {
    if (!this.config.enabled) return false
    if (this.config.replyMode !== 'single-message') return false
    return record.scope === 'group' ? this.config.scope.group === true : this.config.scope.c2c === true
  }

  public onRewrite(): void {
    this.deps.coordinator.noteReplyRewrite()
  }

  public onComplete(): void {
    this.deps.coordinator.noteReplyComplete()
  }

  public onTurnEnd(record: SessionRecord, aborted: boolean): void {
    this.deps.coordinator.noteTurnEnd(sessionKeyOf(record), aborted)
  }

  private nowIso(): string {
    return this.deps.now?.().toISOString() ?? new Date().toISOString()
  }
}

/** 用契约默认值 + row config 归一化初始配置（缺省 enabled=false，保持旧行为）。 */
export function resolveInitialMergeConfig(raw: unknown): QqbotMergeConfig {
  return normalizeMergeConfig(raw)
}
