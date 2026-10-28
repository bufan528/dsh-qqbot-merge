/**
 * 「连续消息智能合并」跨插件契约（Memory Vault 侧）。
 *
 * 真相来源：独立的 QQ Bot 扩展包 `dsh-qqbot-merge`（官方 @tencent-connect/dsh-qqbot
 * 0.5.3 的维护分支）里的 `src/merge/contract.ts`。Memory Vault 不复制实现，只
 * **消费**它通过 cordis 服务 `qqbotMerge` 暴露的契约；两边用同一个 `version` 号
 * 互相校验，版本不匹配时页面如实显示「契约不兼容」而不是假装生效。
 *
 * 为什么必须是服务而不是配置文件：官方 QQ Bot 插件 0.5.3 不 provide 任何服务、也没有
 * 第三方扩展点，只在 Vault 设置里写一个值无法让运行中的 QQ 运行时读到它。所以：
 *
 * - 有 `qqbotMerge` 服务 = 运行中的 QQ 插件确实是支持合并的扩展 → 页面可以编辑，
 *   并且能读到真实计数/批次/诊断；
 * - 没有该服务 = 当前运行的是官方 0.5.3（只有排队合并）→ 页面显示 BLOCKED，
 *   不提供任何「看起来已启用」的开关。
 *
 * @module dsh-longterm-memory/shared/qqbot-merge-contract
 */

/** 契约标识；`qqbotMerge` 服务必须声明同一对 name/version。 */
export const QQBOT_MERGE_CONTRACT = { name: 'qqbot-merge', version: 1 } as const

/** 正在执行任务时收到新消息的处理策略。 */
export const QQBOT_MERGE_BUSY_POLICIES = ['steer', 'queue'] as const

export type QqbotMergeBusyPolicy = (typeof QQBOT_MERGE_BUSY_POLICIES)[number]

/** 回复模式：同一条 QQ 消息持续修订，或按步骤逐条发送（旧行为）。 */
export const QQBOT_MERGE_REPLY_MODES = ['single-message', 'per-step'] as const

export type QqbotMergeReplyMode = (typeof QQBOT_MERGE_REPLY_MODES)[number]

/** 合并策略配置（由扩展持久化，Memory Vault 只是编辑入口）。 */
export interface QqbotMergeConfig {
  /** 是否启用连续消息智能合并。关闭时行为与官方 0.5.3 一致。 */
  enabled: boolean
  /** 静默合并窗口（毫秒）。800 是默认值，可调，不是最优值承诺。 */
  windowMs: number
  /** 单批最多合并多少条消息。 */
  maxBatchMessages: number
  /** 单批最多合并多少字符。 */
  maxBatchChars: number
  /** 分场景开关：私聊 / 群聊。群聊默认关闭跨发送者合并。 */
  scope: { c2c: boolean; group: boolean }
  /** 当前 Agent 正在执行时的策略：`steer` = 非打断式续航并入；`queue` = 排队到下一轮（旧行为）。 */
  busyPolicy: QqbotMergeBusyPolicy
  /** 当前任务的回复模式。 */
  replyMode: QqbotMergeReplyMode
}

export const DEFAULT_QQBOT_MERGE_CONFIG: QqbotMergeConfig = {
  enabled: false,
  windowMs: 800,
  maxBatchMessages: 8,
  maxBatchChars: 4000,
  scope: { c2c: true, group: false },
  busyPolicy: 'steer',
  replyMode: 'single-message',
}

/** 最近一批合并的结果，用于诊断区展示真实发生的事。 */
export interface QqbotMergeLastBatch {
  /** ISO 时间。 */
  at: string
  sessionKey: string
  /** 本批消息条数（含第一条主动消息之后的补充消息）。 */
  count: number
  chars: number
  /** `steer` = 并入运行中的任务；`followup` = 任务空闲时的正常提交。 */
  mode: 'steer' | 'followup'
  ok: boolean
  /** 失败原因（`ok: false` 时）。 */
  error?: string
}

/** 运行期计数（进程内，重启归零）。 */
export interface QqbotMergeCounters {
  batchesMerged: number
  messagesSteered: number
  messagesFollowedUp: number
  messagesOverflowed: number
  steerFallbacks: number
  replyRewrites: number
  repliesCompleted: number
  /** 被用户明确 `/stop` 或异常结束中止的批次数。 */
  batchesAborted: number
}

/** 扩展上报的完整状态。 */
export interface QqbotMergeStatus {
  /** 扩展自报的契约标识（必须与 {@link QQBOT_MERGE_CONTRACT} 完全一致）。 */
  contract: { name: string; version: number }
  config: QqbotMergeConfig
  /** 配置是否已被运行期真正应用：revision 递增 + appliedAt 时间戳。 */
  applied: { revision: number; appliedAt: string; activeBatches: number; pendingMessages: number }
  /** 运行期能力与机制说明（如实描述 steer 的实际支持情况）。 */
  runtime: {
    steerSupported: boolean
    /** 例如 "agent.steer() (DSH 0.2.1-rc.3 public API)"。 */
    steerMechanism: string
    /** 例如 "dsh-qqbot 0.5.3 fork + urgentPredicate bypass"。 */
    integration: string
    /** 流式单条消息修订是否可用（私聊）。 */
    streamingRevision: boolean
    note: string
  }
  counters: QqbotMergeCounters
  lastBatch: QqbotMergeLastBatch | null
}

/** cordis 服务 `qqbotMerge` 的最小形状（Memory Vault 只依赖这些）。 */
export interface QqbotMergeService {
  contract: { name: string; version: number }
  getStatus: () => QqbotMergeStatus
  getConfig: () => QqbotMergeConfig
  setConfig: (patch: Partial<QqbotMergeConfig>) => Promise<QqbotMergeStatus>
}

/** Memory Vault 侧报告的联合类型：要么没有扩展，要么有完整状态。 */
export type QqbotMergeReport =
  | {
      available: false
      /** 为什么不可用（如实说明，供页面显示 BLOCKED）。 */
      reason: string
      /** 检测到的官方 QQ 插件版本（若可知）。 */
      officialVersion: string | null
    }
  | {
      available: true
      status: QqbotMergeStatus
      /** 契约版本是否与 Memory Vault 期望的一致。 */
      compatible: boolean
      /** 契约不兼容时的期望/实际版本说明。 */
      compatibilityNote: string | null
    }

/** 归一化窗口值：限制在 100–10000 ms，非法值回落默认。 */
export function normalizeMergeWindow(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_QQBOT_MERGE_CONFIG.windowMs
  const rounded = Math.round(value)
  return Math.min(10000, Math.max(100, rounded))
}

/** 归一化上限值：1–50 条。 */
export function normalizeMaxBatchMessages(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_QQBOT_MERGE_CONFIG.maxBatchMessages
  return Math.min(50, Math.max(1, Math.round(value)))
}

/** 归一化字符上限：200–20000。 */
export function normalizeMaxBatchChars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_QQBOT_MERGE_CONFIG.maxBatchChars
  return Math.min(20000, Math.max(200, Math.round(value)))
}

/**
 * 把来自扩展/HTTP 的未知配置归一化成安全的配置对象。
 *
 * 运行期（扩展侧）自己也会校验；这一层是 Memory Vault 的边界防御，避免把非法值
 * 渲染进表单或再写回去。
 */
export function normalizeMergeConfig(input: unknown): QqbotMergeConfig {
  const record = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const scope = record['scope'] !== null && typeof record['scope'] === 'object' ? (record['scope'] as Record<string, unknown>) : {}
  const busyRaw = record['busyPolicy']
  const replyRaw = record['replyMode']
  return {
    enabled: record['enabled'] === true,
    windowMs: normalizeMergeWindow(record['windowMs']),
    maxBatchMessages: normalizeMaxBatchMessages(record['maxBatchMessages']),
    maxBatchChars: normalizeMaxBatchChars(record['maxBatchChars']),
    scope: { c2c: scope['c2c'] !== false, group: scope['group'] === true },
    busyPolicy: (QQBOT_MERGE_BUSY_POLICIES as readonly string[]).includes(busyRaw as string)
      ? (busyRaw as QqbotMergeBusyPolicy)
      : DEFAULT_QQBOT_MERGE_CONFIG.busyPolicy,
    replyMode: (QQBOT_MERGE_REPLY_MODES as readonly string[]).includes(replyRaw as string)
      ? (replyRaw as QqbotMergeReplyMode)
      : DEFAULT_QQBOT_MERGE_CONFIG.replyMode,
  }
}

/** 校验扩展自报契约是否与本地期望一致。 */
export function isMergeContractCompatible(contract: unknown): { compatible: boolean; note: string | null } {
  if (contract === null || typeof contract !== 'object') {
    return { compatible: false, note: '扩展没有声明契约标识（qqbotMerge.contract 缺失）' }
  }
  const record = contract as Record<string, unknown>
  const name = record['name']
  const version = record['version']
  if (name !== QQBOT_MERGE_CONTRACT.name || version !== QQBOT_MERGE_CONTRACT.version) {
    return {
      compatible: false,
      note: `契约不匹配：期望 ${QQBOT_MERGE_CONTRACT.name}@v${String(QQBOT_MERGE_CONTRACT.version)}，实际 ${String(name)}@v${String(version)}`,
    }
  }
  return { compatible: true, note: null }
}
