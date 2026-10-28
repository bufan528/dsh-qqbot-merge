/**
 * ReplyRevision — 同一轮单条 QQ 回复的持续修订
 *
 * 官方 0.5.3 的出站行为：每个 `assistant/message` 都 flush → `StreamingWriter.finish()`
 * → `session.complete()` → 一条独立 QQ 消息（多 step 的轮次会刷出多条消息）。
 *
 * 本类实现「同一轮单条回复」：
 * - step 内流式增量只 update 同一条消息（全量替换）；
 * - `assistant/message` 到达时**不** finish/complete，只把该 step 的完整文本定稿为
 *   前缀（{@link StreamingWriter.setBaseText}），同一条消息被重写为「已完成 step + 当前流」；
 * - 只有 turn/end 才 {@link finalize}：finish 一次（complete 一次）；
 * - 流式不可用（群聊 / 无 msgId / 配置关闭 / openStream 失败）时，把文本缓存到内存，
 *   turn/end 才静态发送**一次**，中间候选不单独发送。
 *
 * 工具结果、轮末交付文件、turn 错误提示仍由 outbound 作为独立消息发送（保持不变）。
 *
 * @module dsh-qqbot-merge/transport/reply-revision
 */
import type { SessionRecord } from '../session/index.ts'
import type { Logger, ReplyTarget } from '../types.ts'
import { chunkMarkdownText } from './chunker.ts'
import type { QQBotSender } from './outbound-buffer.ts'
import { StreamingWriter } from './streaming-writer.ts'

/** 出站与合并服务之间的回调接口（transport 层不反向 import merge 实现）。 */
export interface ReplyRevisionHooks {
  /** 该会话是否使用「同一轮单条回复」。 */
  enabledFor(record: SessionRecord): boolean
  /** 一次中间重写（同一条消息被新内容全量替换）。 */
  onRewrite(): void
  /** 一次回复完成（complete 或降级静态发送成功）。 */
  onComplete(): void
  /** turn 结束（含异常 / 中止），供合并协调器做批次统计。 */
  onTurnEnd(record: SessionRecord, aborted: boolean): void
}

export interface ReplyRevisionDeps {
  bot: QQBotSender
  target: ReplyTarget
  /** 单条 QQ 消息字符上限（降级静态发送时切分用）。 */
  limit: number
  logger: Logger
  /** 是否具备流式修订能力（c2c + streaming 配置 + 有 msgId）。 */
  streaming: boolean
  hooks: ReplyRevisionHooks
}

export class ReplyRevision {
  private readonly deps: ReplyRevisionDeps
  private readonly writer: StreamingWriter | null
  /** 已定稿的步骤文本（按 step 顺序用空行拼接）。 */
  private committed = ''
  /** 当前 attempt（step 内 / 重试）尚未定稿的流式增量。 */
  private attempt = ''
  private closed = false

  public constructor(deps: ReplyRevisionDeps) {
    this.deps = deps
    this.writer = deps.streaming
      ? new StreamingWriter({ bot: deps.bot, target: deps.target, logger: deps.logger, throttleMs: STREAM_THROTTLE_MS })
      : null
  }

  /** 当前应展示的全量文本（已定稿前缀 + 当前 attempt）。 */
  public get text(): string {
    return this.committed + this.attempt
  }

  public get hasText(): boolean {
    return this.text.trim().length > 0
  }

  /** 流式增量（agent/assistant-stream / 旧 assistant/chunk 事件）。 */
  public appendDelta(text: string): void {
    if (this.closed || !text) return
    // 新 step 的流式文本与已定稿前缀之间补空行（与最终 commitStep 的拼接方式一致）
    if (this.attempt === '' && this.committed !== '') {
      this.attempt = '\n\n'
      this.writer?.append('\n\n')
    }
    this.attempt += text
    this.writer?.append(text)
  }

  /** 新 attempt（LLM 重试 / 下一个 step）：丢弃本 attempt 的增量，保留已定稿前缀与流式会话。 */
  public resetAttempt(): void {
    if (this.closed) return
    this.attempt = ''
    this.writer?.reset()
  }

  /**
   * 定稿一个 step 的完整文本（来自 durable `assistant/message`，是权威内容）。
   *
   * @returns 是否产生了可见的中间重写。
   */
  public commitStep(text: string): boolean {
    if (this.closed) return false
    const trimmed = text.trim()
    // durable 消息是权威文本：丢弃该 step 的流式增量，避免重复
    this.attempt = ''
    this.writer?.reset()
    if (!trimmed) return false
    const next = this.committed ? `${this.committed}\n\n${trimmed}` : trimmed
    if (next === this.committed) return false
    this.committed = next
    this.writer?.setBaseText(this.committed)
    this.deps.hooks.onRewrite()
    return true
  }

  /**
   * turn/end 收尾：有流式会话则 finish 一次（complete 一次），
   * 否则/降级时静态发送一次；随后报告完成。
   */
  public async finalize(): Promise<void> {
    if (this.closed) return
    this.closed = true

    const finalText = this.text.trim()
    if (!finalText) {
      this.writer?.abort()
      return
    }

    if (this.writer !== null) {
      await this.writer.finish()
      if (!this.writer.shouldFallback) {
        this.deps.hooks.onComplete()
        return
      }
      // 流式从未成功（openStream 失败等）→ 降级静态：整轮只发这一次
      this.deps.logger.debug('im-qqbot: reply revision falls back to static send at turn/end')
    }

    let sent = false
    for (const chunk of chunkMarkdownText(finalText, this.deps.limit)) {
      try {
        await this.deps.bot.sendMarkdown(this.deps.target, chunk)
        sent = true
      } catch (err) {
        this.deps.logger.error(
          `im-qqbot: reply revision static send failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (sent) this.deps.hooks.onComplete()
  }

  /** 取消（无可发送文本 / 异常丢弃）：关闭已打开的流式会话，避免悬挂。 */
  public cancel(): void {
    if (this.closed) return
    this.closed = true
    this.writer?.abort()
  }
}

/** 流式 update 节流间隔(ms)，与 per-step 流式保持一致。 */
const STREAM_THROTTLE_MS = 200
