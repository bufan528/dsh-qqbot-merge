/**
 * 连续消息合并协调器（MergeCoordinator）
 *
 * 目标：用户在 agent 执行任务期间连续发来的消息，不再由官方 0.5.3 的
 * `concurrencyGuard(strategy='merge')` 缓冲后排队到下一轮，而是：
 *
 * - 按 QQ 会话隔离（`c2c:<openid>` / `group:<openid>`）；
 * - 以静默窗口（默认 800ms，可配）做 debounce：本批第一条补充消息到达后
 *   静默 `windowMs` 再 flush，期间新消息续期；
 * - flush 时**重新检查** `agent.status`：
 *   * `running` → 把本批消息合成**一条**结构化补充 user message，交给
 *     `agent.steer(...)`（DSH 公开 API，inbox next-step：不取消当前轮、
 *     不打断工具执行，在下一个 step 边界并入）；
 *   * `idle` → `agent.followup(...)` 一条，不逐条请求；
 * - steer 抛错（轮次已结束 / agent 已释放等竞态）→ 降级 followup 并计数；
 * - 上限（maxBatchMessages / maxBatchChars）溢出消息不静默丢弃：用本扩展
 *   自己的 `bot.sendMarkdown` 告知「第 N 条起已转入后续处理」，并作为下一批
 *   （强制 followup）继续投递；
 * - 群聊默认不启用跨发送者合并；启用时按发送者分组，同一发送者才合并。
 *
 * 明确不做的事：
 * - 绝不调用 `agent.cancel` / `ctx.abort` / `AbortController.abort`；
 * - 不把普通消息当 `/stop`。
 *
 * @module dsh-qqbot-merge/merge/coordinator
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { QQBotSender } from '../transport/outbound-buffer.ts'
import type { ChatScope, Logger, ReplyTarget } from '../types.ts'
import {
  DEFAULT_QQBOT_MERGE_CONFIG,
  normalizeMergeConfig,
  type QqbotMergeConfig,
  type QqbotMergeCounters,
  type QqbotMergeLastBatch,
} from './contract.ts'

/** 合并协调器需要 agent 的最小接口（与 DSH 公开 Agent API 对齐）。 */
export interface MergeAgentLike {
  /** 真实字段名：DSH 0.2.1-rc.3 `ReactLoopAgent#status` getter，'idle' | 'running'。 */
  readonly status: 'idle' | 'running'
  /** 非打断式续航：inbox next-step，当前轮不取消。 */
  steer(input: unknown): void
  /** 正常下一轮提交。 */
  followup(input: unknown): void
}

/** 合并协调器需要会话记录的最小接口（SessionRecord 结构上满足）。 */
export interface MergeRecordLike {
  sessionKey: string
  sessionId: string
  scope: ChatScope
  peerId: string
  senderId: string
  agent: MergeAgentLike
  replyTarget: ReplyTarget
}

/** 单条补充消息的元数据（原始序号 / 时间 / 发送者都保留）。 */
export interface MergeMessageMeta {
  /** 这条消息原本会作为 user message 交给 agent 的完整文本（含 history/quote/媒体上下文）。 */
  body: string
  senderId: string
  senderName?: string
  /** 到达时刻（ISO 8601）。 */
  timestamp: string
  messageId?: string
}

/** inbound 侧使用的最小接口（便于单测注入）。 */
export interface MergeInboundRouter {
  enabledFor(scope: ChatScope, senderId?: string): boolean
  submit(record: MergeRecordLike, meta: MergeMessageMeta): boolean
}

export interface MergeCoordinatorDeps {
  logger: Logger
  /** 初始配置（缺省用契约默认值：enabled=false）。 */
  config?: Partial<QqbotMergeConfig>
  /** 注入时钟/定时器便于单测；缺省用全局。 */
  now?: () => Date
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

interface PendingBatch {
  /** 批次键：私聊 `c2c:<peerId>`；群聊（已启用）`group:<peerId>#<senderId>`。 */
  key: string
  /** 诊断用会话键（按 spec：`c2c:<openid>` / `group:<openid>`）。 */
  sessionKey: string
  record: MergeRecordLike
  messages: MergeMessageMeta[]
  /** 溢出批次强制 followup（即使 flush 时 agent 仍在运行）。 */
  forceFollowup: boolean
  timer: unknown
  createdAt: number
}

const EMPTY_COUNTERS: QqbotMergeCounters = {
  batchesMerged: 0,
  messagesSteered: 0,
  messagesFollowedUp: 0,
  messagesOverflowed: 0,
  steerFallbacks: 0,
  replyRewrites: 0,
  repliesCompleted: 0,
  batchesAborted: 0,
}

/** 结构化补充消息抬头。 */
const MERGE_HEADER = '[连续补充消息 · 当前任务执行期间收到]'

/**
 * 结构化补充消息文案。
 *
 * 保留每条消息原始序号 / 时间 / 发送者，并明确要求「结合原目标继续、不要当新任务、
 * 不要取消、不要重复副作用、完成后统一答复」。
 */
export function buildMergedBody(messages: readonly MergeMessageMeta[], scope: ChatScope): string {
  const lines: string[] = []
  lines.push(MERGE_HEADER)
  lines.push(`以下是当前任务执行期间收到的用户补充消息，按时间顺序排列（共 ${messages.length} 条）：`)
  messages.forEach((message, index) => {
    const sender = scope === 'group' ? ` · 发送者 ${message.senderName ?? message.senderId}` : ''
    const messageId = message.messageId === undefined ? '' : ` · msgId=${message.messageId}`
    lines.push('')
    lines.push(`--- 第 ${index + 1} 条${sender} · ${message.timestamp}${messageId}`)
    lines.push(message.body)
  })
  lines.push('')
  lines.push(
    '请结合最初目标、已完成操作、真实工具结果与未完成工作继续；除非明确要求，否则不要把这些补充消息当作独立新任务；不要取消当前任务，不要重复已完成的副作用操作；完成后给出统一答复。',
  )
  return lines.join('\n')
}

/**
 * 按上限切分一批消息。
 *
 * 规则：第一条永远进入本批（避免单条超长消息被整体推出）；之后按条数/字符上限截断。
 * 返回的 accepted 一定是 messages 的前缀（保持到达顺序）。
 */
export function partitionMessages(
  messages: readonly MergeMessageMeta[],
  maxBatchMessages: number,
  maxBatchChars: number,
): MergeMessageMeta[] {
  const accepted: MergeMessageMeta[] = []
  let chars = 0
  for (const message of messages) {
    if (accepted.length >= maxBatchMessages) break
    if (accepted.length > 0 && chars + message.body.length > maxBatchChars) break
    accepted.push(message)
    chars += message.body.length
  }
  return accepted
}

function cloneConfig(config: QqbotMergeConfig): QqbotMergeConfig {
  return { ...config, scope: { ...config.scope } }
}

function cloneCounters(counters: QqbotMergeCounters): QqbotMergeCounters {
  return { ...counters }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class MergeCoordinator implements MergeInboundRouter {
  private readonly deps: MergeCoordinatorDeps
  private config: QqbotMergeConfig
  private readonly batches = new Map<string, PendingBatch>()
  private counters: QqbotMergeCounters = { ...EMPTY_COUNTERS }
  private lastBatch: QqbotMergeLastBatch | null = null
  private bot: QQBotSender | undefined
  private overflowSeq = 0
  /** 本 turn 内已被 steer 过、尚未收到 turn/end 的会话（用于 batchesAborted 计数）。 */
  private readonly steeredSessions = new Set<string>()
  private readonly scheduleFn: (fn: () => void, ms: number) => unknown
  private readonly cancelFn: (handle: unknown) => void

  public constructor(deps: MergeCoordinatorDeps) {
    this.deps = deps
    this.config = normalizeMergeConfig(deps.config ?? {})
    this.scheduleFn = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancelFn = deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  // ── 配置 / 观测 ──

  public setConfig(config: Partial<QqbotMergeConfig>): void {
    this.config = normalizeMergeConfig({ ...this.config, ...config, scope: { ...this.config.scope, ...(config.scope ?? {}) } })
  }

  public getConfig(): QqbotMergeConfig {
    return cloneConfig(this.config)
  }

  public getCounters(): QqbotMergeCounters {
    return cloneCounters(this.counters)
  }

  public getLastBatch(): QqbotMergeLastBatch | null {
    return this.lastBatch === null ? null : { ...this.lastBatch }
  }

  /** 运行期快照：状态页展示用。 */
  public snapshot(): { activeBatches: number; pendingMessages: number } {
    let pendingMessages = 0
    for (const batch of this.batches.values()) pendingMessages += batch.messages.length
    return { activeBatches: this.batches.size, pendingMessages }
  }

  /** 注入发送器（用于上限溢出提示）。未安装前 overflow 提示降级为日志。 */
  public attachBot(bot: QQBotSender): void {
    this.bot = bot
  }

  /** 计数：同一轮单条回复的中间重写次数。 */
  public noteReplyRewrite(): void {
    this.counters.replyRewrites += 1
  }

  /** 计数：同一轮单条回复完成次数。 */
  public noteReplyComplete(): void {
    this.counters.repliesCompleted += 1
  }

  /**
   * 记录 turn 结束：本轮若被 steer 注入后以 aborted 结束，计一次 batchesAborted。
   * （用户 `/stop` 或异常中止；不是我们主动取消。）
   */
  public noteTurnEnd(sessionKey: string, aborted: boolean): void {
    if (aborted && this.steeredSessions.has(sessionKey)) this.counters.batchesAborted += 1
    this.steeredSessions.delete(sessionKey)
  }

  // ── 作用域判定 ──

  /** 该会话是否在合并范围内（配置启用 + 该场景开关打开）。 */
  public enabledFor(scope: ChatScope, _senderId?: string): boolean {
    if (!this.config.enabled) return false
    return scope === 'group' ? this.config.scope.group === true : this.config.scope.c2c === true
  }

  /**
   * concurrencyGuard 的 urgentPredicate：命中时消息跳过 SDK 的 merge 缓冲，
   * 直接沿剩余链执行，由本协调器接管。仅当合并启用且该会话在范围内返回 true。
   */
  public shouldBypass(ctx: unknown): boolean {
    const message = (ctx as { message?: { replyTarget?: { scope?: unknown }; senderId?: unknown } } | null)?.message
    if (message === undefined) return false
    const scope = message.replyTarget?.scope
    if (scope !== 'c2c' && scope !== 'group') return false
    const senderId = typeof message.senderId === 'string' ? message.senderId : undefined
    return this.enabledFor(scope, senderId)
  }

  // ── 提交 / 合并 ──

  /**
   * inbound 入口：把一条补充消息放进它的合并窗口。
   *
   * @returns 是否已被合并协调器接管（false = 调用方应保持官方 0.5.3 行为）。
   */
  public submit(record: MergeRecordLike, meta: MergeMessageMeta): boolean {
    if (!this.enabledFor(record.scope, meta.senderId)) return false

    const sessionKey = sessionKeyOf(record)
    // 群聊：启用合并时按发送者分组，同一发送者才合并；私聊只有单一发送者。
    const key = record.scope === 'group' ? `${sessionKey}#${meta.senderId}` : sessionKey
    let batch = this.batches.get(key)
    if (batch === undefined) {
      batch = {
        key,
        sessionKey,
        record,
        messages: [],
        forceFollowup: false,
        timer: null,
        createdAt: this.nowMs(),
      }
      this.batches.set(key, batch)
    }
    batch.record = record
    batch.messages.push(meta)
    this.schedule(batch)
    return true
  }

  /** 取消所有待 flush 的批次（fiber 卸载 / 插件停用）。 */
  public dispose(): void {
    for (const batch of this.batches.values()) {
      if (batch.timer !== null) this.cancelFn(batch.timer)
      batch.timer = null
    }
    this.batches.clear()
    this.steeredSessions.clear()
  }

  /**
   * 某个 session 的 turn 即将结束（`agent/turn-stopping`，serial 派发）时，
   * 立即 flush 该会话所有**未到期**的合并窗口（溢出批次除外）。
   *
   * 为什么在 turn-stopping 里做：这是官方「让轮次继续」的正式机制——监听器里
   * `agent.steer(...)` 之后机器会重读 inbox，`next-step` 非空就继续同一 turn。
   * 这消除了「消息恰好在你窗口到期时到达、轮次已收尾」的常见缝隙：与其留到
   * 下一轮，不如并入当前轮的下一个 step。
   *
   * 注意：本方法在监听器调用栈内**同步**走到 `agent.steer(...)`（flush →
   * deliver 在第一个 await 之前完成 steer），因此 serial 派发返回后机器能读到
   * 新排队的 next-step。
   */
  public flushSession(record: MergeRecordLike): void {
    const sessionKey = sessionKeyOf(record)
    for (const batch of [...this.batches.values()]) {
      if (batch.sessionKey !== sessionKey || batch.forceFollowup) continue
      if (batch.timer !== null) {
        this.cancelFn(batch.timer)
        batch.timer = null
      }
      void this.flush(batch.key)
    }
  }

  // ── 内部 ──

  private nowMs(): number {
    return this.deps.now?.().getTime() ?? Date.now()
  }

  private nowIso(): string {
    return this.deps.now?.().toISOString() ?? new Date().toISOString()
  }

  private schedule(batch: PendingBatch): void {
    if (batch.timer !== null) this.cancelFn(batch.timer)
    const windowMs = this.config.windowMs
    batch.timer = this.scheduleFn(() => {
      batch.timer = null
      void this.flush(batch.key)
    }, windowMs)
  }

  private async flush(batchKey: string): Promise<void> {
    const batch = this.batches.get(batchKey)
    if (batch === undefined) return
    this.batches.delete(batchKey)
    if (batch.timer !== null) {
      this.cancelFn(batch.timer)
      batch.timer = null
    }
    if (batch.messages.length === 0) return

    const accepted = partitionMessages(batch.messages, this.config.maxBatchMessages, this.config.maxBatchChars)
    const overflow = batch.messages.slice(accepted.length)
    const chars = accepted.reduce((sum, message) => sum + message.body.length, 0)
    const body = buildMergedBody(accepted, batch.record.scope)
    const message = createUserMessage({
      content: [{ type: 'text' as const, text: body }],
      source: { kind: 'user' as const },
    })

    const result = await this.deliver(batch, message, accepted.length)

    this.counters.batchesMerged += result.ok ? 1 : 0
    this.lastBatch = {
      at: this.nowIso(),
      sessionKey: batch.sessionKey,
      count: accepted.length,
      chars,
      mode: result.mode,
      ok: result.ok,
      ...(result.error === undefined ? {} : { error: result.error }),
    }

    if (overflow.length > 0) {
      if (!batch.forceFollowup) {
        // 只有用户原始批次里的溢出才是「第一次被推出」：计数一次、通知一次。
        // 溢出批次自身再溢出（极端上限）不再重复计数/重复提示。
        this.counters.messagesOverflowed += overflow.length
        await this.notifyOverflow(batch, accepted.length + 1, overflow.length)
      }
      // 溢出消息不能丢：作为下一批（强制 followup）继续投递。
      this.enqueueOverflow(batch, overflow)
    }
  }

  /** 按「忙碌 → steer / 空闲 → followup」把一批消息交给 agent，并处理降级。 */
  private async deliver(
    batch: PendingBatch,
    message: unknown,
    count: number,
  ): Promise<{ mode: 'steer' | 'followup'; ok: boolean; error?: string }> {
    const record = batch.record
    // flush 前重新检查（窗口期内状态可能已变化）
    const busy = record.agent.status === 'running'
    const wantSteer = busy && !batch.forceFollowup && this.config.busyPolicy === 'steer'

    if (wantSteer) {
      try {
        record.agent.steer(message)
        this.counters.messagesSteered += count
        this.steeredSessions.add(batch.sessionKey)
        return { mode: 'steer', ok: true }
      } catch (error) {
        // 竞态：轮次已结束 / agent 已释放 → 降级 followup，并计入 steerFallbacks
        this.counters.steerFallbacks += 1
        this.deps.logger.warn(
          `qqbot-merge: steer 失败，降级 followup: session=${batch.sessionKey} err=${describeError(error)}`,
        )
      }
    }

    try {
      record.agent.followup(message)
      this.counters.messagesFollowedUp += count
      return { mode: 'followup', ok: true }
    } catch (error) {
      const reason = describeError(error)
      this.deps.logger.error(`qqbot-merge: followup 失败: session=${batch.sessionKey} err=${reason}`)
      // 连 followup 都失败 = 消息没有送达，必须告知用户而不是静默丢弃
      await this.notify(batch.record, `⚠️ 有 ${count} 条补充消息未能送达 agent：${reason}`)
      return { mode: 'followup', ok: false, error: reason }
    }
  }

  private enqueueOverflow(batch: PendingBatch, messages: MergeMessageMeta[]): void {
    this.overflowSeq += 1
    const key = `${batch.key}~overflow-${this.overflowSeq}`
    const overflowBatch: PendingBatch = {
      key,
      sessionKey: batch.sessionKey,
      record: batch.record,
      messages: [...messages],
      forceFollowup: true,
      timer: null,
      createdAt: this.nowMs(),
    }
    this.batches.set(key, overflowBatch)
    this.schedule(overflowBatch)
  }

  private async notifyOverflow(batch: PendingBatch, firstOverflowIndex: number, count: number): Promise<void> {
    await this.notify(
      batch.record,
      `⚠️ 合并窗口已达上限：本批第 ${firstOverflowIndex} 条起共 ${count} 条消息已转入后续处理（不会丢失）。`,
    )
  }

  private async notify(record: MergeRecordLike, text: string): Promise<void> {
    if (this.bot === undefined) {
      this.deps.logger.warn(`qqbot-merge: 通知无法发送（bot 未就绪）：session=${sessionKeyOf(record)} text=${text}`)
      return
    }
    try {
      await this.bot.sendMarkdown(record.replyTarget, text)
    } catch (error) {
      this.deps.logger.warn(`qqbot-merge: 通知发送失败: ${describeError(error)}`)
    }
  }
}

/** 诊断用会话键：`c2c:<openid>` / `group:<openid>`。 */
export function sessionKeyOf(record: Pick<MergeRecordLike, 'scope' | 'peerId'>): string {
  return `${record.scope}:${record.peerId}`
}

/** 契约默认值再导出（服务/单测使用）。 */
export { DEFAULT_QQBOT_MERGE_CONFIG }

