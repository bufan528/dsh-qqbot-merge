import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOutboundHandler } from './outbound.ts'
import type { QQBotSender, StreamSessionLike } from './outbound-buffer.ts'
import type { ReplyRevisionHooks } from './reply-revision.ts'
import type { SessionManager, SessionRecord } from '../session/index.ts'
import type { ImQQBotConfig } from '../config.ts'
import type { Logger, ReplyTarget } from '../types.ts'

// ─────────────────────────────── fakes ───────────────────────────────

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function createSession(): StreamSessionLike & {
  update: ReturnType<typeof vi.fn>
  complete: ReturnType<typeof vi.fn>
} {
  return {
    update: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
  } as unknown as StreamSessionLike & {
    update: ReturnType<typeof vi.fn>
    complete: ReturnType<typeof vi.fn>
  }
}

const c2cTarget: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' }
const groupTarget: ReplyTarget = { scope: 'group', targetId: 'group1', msgId: 'msg1' }

function createRecord(target: ReplyTarget, sessionId = 'sess-qq'): SessionRecord {
  return {
    sessionKey: 'k',
    sessionId,
    replyTarget: target,
    agent: {},
    handle: {},
    lastActivity: 0,
  } as unknown as SessionRecord
}

function createConfig(overrides?: Partial<ImQQBotConfig>): ImQQBotConfig {
  return {
    streaming: true,
    textChunkLimit: 4500,
    showToolResults: false,
    ...overrides,
  } as unknown as ImQQBotConfig
}

interface TestHooks extends ReplyRevisionHooks {
  onRewrite: ReturnType<typeof vi.fn>
  onComplete: ReturnType<typeof vi.fn>
  onTurnEnd: ReturnType<typeof vi.fn>
}

function createHooks(enabled = true): TestHooks {
  return {
    enabledFor: vi.fn(() => enabled),
    onRewrite: vi.fn(),
    onComplete: vi.fn(),
    onTurnEnd: vi.fn(),
  } as unknown as TestHooks
}

function setup(options?: {
  record?: SessionRecord
  config?: ImQQBotConfig
  hooks?: TestHooks | undefined
  bot?: QQBotSender
  deliverer?: { deliver: ReturnType<typeof vi.fn> }
}) {
  const session = createSession()
  const bot =
    options?.bot ??
    ({
      sendMarkdown: vi.fn(async () => undefined),
      openStream: vi.fn(() => session),
    } as unknown as QQBotSender)
  const record = options?.record ?? createRecord(c2cTarget)
  const manager = {
    findBySessionId: vi.fn((id: string) => (id === record.sessionId ? record : undefined)),
  } as unknown as SessionManager
  const outbound = createOutboundHandler(
    manager,
    bot,
    options?.config ?? createConfig(),
    createLogger(),
    undefined,
    options?.deliverer,
    options?.hooks,
  )
  return { outbound, bot, session }
}

const start = (attemptId: string) => ({ kind: 'attempt-start' as const, attemptId })
const delta = (attemptId: string, text: string) => ({ kind: 'text-delta' as const, attemptId, text })
const sess = { header: { id: 'sess-qq' } }

function assistantMessage(text: string) {
  return {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  }
}

function turnEnd(reason: Record<string, unknown> = { kind: 'stop' }) {
  return { type: 'turn/end', data: { reason } }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

// ─────────────────────────────── 同一轮单条回复 ───────────────────────────────

describe('同一轮单条回复（replyMode=single-message）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('多 step 只打开一条流式消息：assistant/message 不 complete，turn/end 才 complete 一次', async () => {
    const hooks = createHooks()
    const { outbound, bot, session } = setup({ hooks })

    // step 1
    outbound.routeStreamFrame('sess-qq', start('a1'))
    outbound.routeStreamFrame('sess-qq', delta('a1', '第一段'))
    await vi.advanceTimersByTimeAsync(210)
    outbound.routeSessionEvent(sess, assistantMessage('第一段'))
    await flush()

    expect(session.complete).not.toHaveBeenCalled()
    expect(bot.sendMarkdown).not.toHaveBeenCalled()

    // step 2
    outbound.routeStreamFrame('sess-qq', start('a2'))
    outbound.routeStreamFrame('sess-qq', delta('a2', '第二段'))
    await vi.advanceTimersByTimeAsync(210)
    outbound.routeSessionEvent(sess, assistantMessage('第二段'))
    await flush()

    expect(session.complete).not.toHaveBeenCalled()
    expect(bot.sendMarkdown).not.toHaveBeenCalled()

    // 中间重写使用全量 update：最后一条 update 应同时包含两段文本
    const updates = session.update.mock.calls.map((call) => call[0] as string)
    const lastStepUpdate = updates[updates.length - 1] ?? ''
    expect(lastStepUpdate).toContain('第一段')
    expect(lastStepUpdate).toContain('第二段')

    // turn/end：finish/complete 一次
    outbound.routeSessionEvent(sess, turnEnd())
    await flush()

    expect(session.complete).toHaveBeenCalledTimes(1)
    expect(bot.sendMarkdown).not.toHaveBeenCalled()
    expect(hooks.onComplete).toHaveBeenCalledTimes(1)
    expect(hooks.onRewrite).toHaveBeenCalledTimes(2)
    const finalUpdate = session.update.mock.calls[session.update.mock.calls.length - 1]![0] as string
    expect(finalUpdate).toContain('第一段')
    expect(finalUpdate).toContain('第二段')
  })

  it('turn/end 重复到达时只 complete 一次', async () => {
    const hooks = createHooks()
    const { outbound, session } = setup({ hooks })

    outbound.routeStreamFrame('sess-qq', start('a1'))
    outbound.routeStreamFrame('sess-qq', delta('a1', 'hi'))
    outbound.routeSessionEvent(sess, assistantMessage('hi'))
    outbound.routeSessionEvent(sess, turnEnd())
    await flush()
    expect(session.complete).toHaveBeenCalledTimes(1)

    outbound.routeSessionEvent(sess, turnEnd())
    await flush()
    expect(session.complete).toHaveBeenCalledTimes(1)
    expect(hooks.onComplete).toHaveBeenCalledTimes(1)
  })

  it('流式不可用（openStream 失败）→ 中间不发送，turn/end 只静态发送一次', async () => {
    const hooks = createHooks()
    const bot = {
      sendMarkdown: vi.fn(async () => undefined),
      openStream: vi.fn(() => {
        throw new Error('stream not supported')
      }),
    } as unknown as QQBotSender
    const { outbound } = setup({ hooks, bot })

    outbound.routeStreamFrame('sess-qq', start('a1'))
    outbound.routeStreamFrame('sess-qq', delta('a1', '第一段'))
    await vi.advanceTimersByTimeAsync(210)
    outbound.routeSessionEvent(sess, assistantMessage('第一段'))

    outbound.routeStreamFrame('sess-qq', start('a2'))
    outbound.routeStreamFrame('sess-qq', delta('a2', '第二段'))
    await vi.advanceTimersByTimeAsync(210)
    outbound.routeSessionEvent(sess, assistantMessage('第二段'))
    await flush()

    expect(bot.sendMarkdown).not.toHaveBeenCalled()

    outbound.routeSessionEvent(sess, turnEnd())
    await flush()
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1)
    const text = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string
    expect(text).toContain('第一段')
    expect(text).toContain('第二段')
  })

  it('流式关闭（群聊）→ 文本缓存到内存，turn/end 只发送一次', async () => {
    const hooks = createHooks()
    const { outbound, bot } = setup({ hooks, record: createRecord(groupTarget) })

    outbound.routeSessionEvent(sess, assistantMessage('第一段'))
    outbound.routeSessionEvent(sess, assistantMessage('第二段'))
    await flush()
    expect(bot.sendMarkdown).not.toHaveBeenCalled()
    expect((bot.openStream as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()

    outbound.routeSessionEvent(sess, turnEnd())
    await flush()
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1)
    const text = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string
    expect(text).toContain('第一段')
    expect(text).toContain('第二段')
  })

  it('异常结束的轮次：先收尾回复文本，再发 turn 错误提示', async () => {
    const hooks = createHooks()
    const { outbound, bot } = setup({ hooks, record: createRecord(groupTarget) })

    outbound.routeSessionEvent(sess, assistantMessage('已完成的半段'))
    outbound.routeSessionEvent(sess, turnEnd({ kind: 'error', error: { code: 'E_BROKEN', message: 'boom' } }))
    await flush()

    expect(bot.sendMarkdown).toHaveBeenCalledTimes(2)
    const [first, second] = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls
    expect(first![1] as string).toContain('已完成的半段')
    expect(second![1] as string).toContain('E_BROKEN')
    expect(hooks.onTurnEnd).toHaveBeenCalledWith(expect.anything(), false)
  })

  it('中止（/stop 等 abort 路径）：partial 文本仍收尾并 complete，onTurnEnd 标记 aborted', async () => {
    const hooks = createHooks()
    const { outbound, session } = setup({ hooks })

    outbound.routeStreamFrame('sess-qq', start('a1'))
    outbound.routeStreamFrame('sess-qq', delta('a1', '半截输出'))
    await vi.advanceTimersByTimeAsync(210)

    outbound.routeSessionEvent(sess, turnEnd({ kind: 'aborted', reason: { kind: 'user' } }))
    await flush()

    expect(session.complete).toHaveBeenCalledTimes(1)
    const updates = session.update.mock.calls.map((call) => call[0] as string)
    expect(updates[updates.length - 1]).toContain('半截输出')
    expect(hooks.onTurnEnd).toHaveBeenCalledWith(expect.anything(), true)
  })

  it('工具错误仍作为独立消息即时发送，不阻塞单条回复', async () => {
    const hooks = createHooks()
    const { outbound, bot } = setup({ hooks, record: createRecord(groupTarget) })

    // tool/call → tool/result(error) 立即发送
    outbound.routeSessionEvent(sess, {
      type: 'tool/call',
      data: { callId: 'c1', name: 'bash', arguments: '{}' },
    })
    outbound.routeSessionEvent(sess, {
      type: 'tool/result',
      data: { message: { source: { callId: 'c1' } }, error: { name: 'E', code: 'E_TOOL' } },
    })
    await flush()

    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1) // 工具错误独立消息
    // 回复文本仍未发送
    expect((bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string).toContain('E_TOOL')

    outbound.routeSessionEvent(sess, assistantMessage('最终答复'))
    outbound.routeSessionEvent(sess, turnEnd())
    await flush()
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(2)
    expect((bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.calls[1]![1] as string).toContain('最终答复')
  })

  it('轮末交付文件仍在回复文本之后投递', async () => {
    const hooks = createHooks()
    const deliver = vi.fn(async () => undefined)
    const { outbound, bot } = setup({ hooks, record: createRecord(groupTarget), deliverer: { deliver } })

    outbound.routeSessionEvent(sess, {
      type: 'deliverables/presented',
      data: { turn: 1, callId: 'c1', files: [{ path: '/tmp/report.xlsx' }] },
    })
    outbound.routeSessionEvent(sess, assistantMessage('报告已生成'))
    outbound.routeSessionEvent(sess, turnEnd())
    await flush()

    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    const textOrder = (bot.sendMarkdown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!
    expect(textOrder).toBeLessThan((deliver.mock.invocationCallOrder[0] as number))
  })

  it('关闭 hooks（合并未启用/per-step 模式）→ 保持官方每步一条消息的行为', async () => {
    const hooks = createHooks(false)
    const { outbound, bot, session } = setup({ hooks })

    outbound.routeStreamFrame('sess-qq', start('a1'))
    outbound.routeStreamFrame('sess-qq', delta('a1', '第一段'))
    await vi.advanceTimersByTimeAsync(210)
    outbound.routeSessionEvent(sess, assistantMessage('第一段'))
    await flush()

    outbound.routeStreamFrame('sess-qq', start('a2'))
    outbound.routeStreamFrame('sess-qq', delta('a2', '第二段'))
    await vi.advanceTimersByTimeAsync(210)
    outbound.routeSessionEvent(sess, assistantMessage('第二段'))
    await flush()

    // per-step：每个 assistant/message 都 finish/complete 一条独立消息
    expect(session.complete).toHaveBeenCalledTimes(2)
    expect(bot.sendMarkdown).not.toHaveBeenCalled()
  })
})
