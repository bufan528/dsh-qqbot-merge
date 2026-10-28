import { describe, it, expect, vi } from 'vitest'
import {
  MergeCoordinator,
  buildMergedBody,
  partitionMessages,
  sessionKeyOf,
  type MergeAgentLike,
  type MergeMessageMeta,
} from './coordinator.ts'
import { DEFAULT_QQBOT_MERGE_CONFIG, type QqbotMergeConfig } from './contract.ts'
import type { SessionRecord } from '../session/index.ts'
import type { QQBotSender } from '../transport/outbound-buffer.ts'
import type { ChatScope, Logger, ReplyTarget } from '../types.ts'

// ─────────────────────────────── fakes ───────────────────────────────

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

interface FakeAgent extends MergeAgentLike {
  status: 'idle' | 'running'
  steer: ReturnType<typeof vi.fn>
  followup: ReturnType<typeof vi.fn>
  steerThrows: boolean
  followupThrows: boolean
}

function makeAgent(status: 'idle' | 'running' = 'idle'): FakeAgent {
  const agent = {
    status,
    steerThrows: false,
    followupThrows: false,
    steer: vi.fn(),
    followup: vi.fn(),
  } as unknown as FakeAgent
  agent.steer.mockImplementation(() => {
    if (agent.steerThrows) throw new Error('turn already ended')
  })
  agent.followup.mockImplementation(() => {
    if (agent.followupThrows) throw new Error('agent disposed')
  })
  return agent
}

function makeRecord(scope: ChatScope, agent: FakeAgent, peerId?: string): SessionRecord {
  const id = peerId ?? (scope === 'c2c' ? 'user-openid-1' : 'group-openid-1')
  const replyTarget: ReplyTarget = { scope, targetId: id, msgId: 'msg-1' }
  return {
    sessionKey: `qqbot:app:${scope}:${id}`,
    sessionId: `sess-${scope}`,
    scope,
    peerId: id,
    senderId: id,
    agent,
    replyTarget,
    handle: {},
    lastActivity: 0,
  } as unknown as SessionRecord
}

/** 可手动推进的定时器，避免依赖 vitest fake timers 的微任务时序。 */
class Timers {
  private handles: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []

  public readonly schedule = (fn: () => void, ms: number): unknown => {
    const handle = { fn, ms, cancelled: false }
    this.handles.push(handle)
    return handle
  }

  public readonly cancel = (handle: unknown): void => {
    ;(handle as { cancelled: boolean }).cancelled = true
  }

  public get pending(): Array<{ fn: () => void; ms: number }> {
    return this.handles.filter((handle) => !handle.cancelled)
  }

  public wasCancelled(handle: unknown): boolean {
    return (handle as { cancelled: boolean }).cancelled
  }

  /** 触发当前所有未取消的定时器（模拟窗口到期），并冲刷 flush 的微任务链。 */
  public async runAll(): Promise<void> {
    const pending = this.pending
    this.handles = []
    for (const handle of pending) handle.fn()
    await flushMicrotasks()
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve()
}

function mergeConfig(overrides?: Partial<QqbotMergeConfig>): QqbotMergeConfig {
  return {
    ...DEFAULT_QQBOT_MERGE_CONFIG,
    enabled: true,
    ...overrides,
    scope: { ...DEFAULT_QQBOT_MERGE_CONFIG.scope, ...(overrides?.scope ?? {}) },
  }
}

function makeMeta(text: string, senderId = 'user-openid-1', senderName?: string): MergeMessageMeta {
  return {
    body: text,
    senderId,
    timestamp: '2026-10-27T14:00:00.000Z',
    ...(senderName === undefined ? {} : { senderName }),
  }
}

function setup(options?: {
  config?: Partial<QqbotMergeConfig>
  bot?: QQBotSender
}) {
  const logger = createLogger()
  const timers = new Timers()
  const coordinator = new MergeCoordinator({
    logger,
    config: options?.config === undefined ? mergeConfig() : mergeConfig(options.config),
    schedule: timers.schedule,
    cancel: timers.cancel,
    now: () => new Date('2026-10-27T14:00:00.000Z'),
  })
  if (options?.bot !== undefined) coordinator.attachBot(options.bot)
  return { coordinator, timers, logger }
}

function fakeBot(): QQBotSender & { sendMarkdown: ReturnType<typeof vi.fn> } {
  return {
    sendMarkdown: vi.fn(async () => undefined),
    openStream: vi.fn(),
  } as unknown as QQBotSender & { sendMarkdown: ReturnType<typeof vi.fn> }
}

// ─────────────────────────────── 纯函数 ───────────────────────────────

describe('buildMergedBody', () => {
  it('保留每条消息的原始序号/时间/发送者，并包含继续执行的约束文案', () => {
    const body = buildMergedBody(
      [
        { body: '先别改 A，改成 B', senderId: 'u1', timestamp: '2026-10-27T14:00:01.000Z' },
        { body: '顺便把报告发我', senderId: 'u1', senderName: '小明', timestamp: '2026-10-27T14:00:02.000Z' },
      ],
      'c2c',
    )
    expect(body).toContain('连续补充消息')
    expect(body).toContain('共 2 条')
    expect(body.indexOf('先别改 A')).toBeLessThan(body.indexOf('顺便把报告发我'))
    expect(body).toContain('2026-10-27T14:00:01.000Z')
    expect(body).toContain('2026-10-27T14:00:02.000Z')
    expect(body).toContain('第 2 条')
    expect(body).toContain('不要取消当前任务')
    expect(body).toContain('不要重复已完成的副作用操作')
    expect(body).toContain('完成后给出统一答复')
    expect(body).toContain('不要把这些补充消息当作独立新任务')
  })

  it('群聊保留发送者标识，私聊不追加发送者段', () => {
    const group = buildMergedBody([{ body: 'x', senderId: 's1', senderName: '甲', timestamp: 't' }], 'group')
    expect(group).toContain('发送者 甲')
    const c2c = buildMergedBody([{ body: 'x', senderId: 's1', senderName: '甲', timestamp: 't' }], 'c2c')
    expect(c2c).not.toContain('发送者 甲')
  })
})

describe('partitionMessages', () => {
  const meta = (length: number, index: number): MergeMessageMeta => ({
    body: 'x'.repeat(length),
    senderId: `u${index}`,
    timestamp: 't',
  })

  it('条数上限：保留前缀，其余作为溢出', () => {
    const accepted = partitionMessages([meta(1, 1), meta(1, 2), meta(1, 3)], 2, 1000)
    expect(accepted).toHaveLength(2)
    expect(accepted[0]!.senderId).toBe('u1')
    expect(accepted[1]!.senderId).toBe('u2')
  })

  it('字符上限：首条永远进入本批（避免单条超长消息被整体推出）', () => {
    const accepted = partitionMessages([meta(80, 1), meta(30, 2)], 8, 50)
    expect(accepted).toHaveLength(1)
    expect(accepted[0]!.senderId).toBe('u1')
  })

  it('字符上限：累计超限即截断', () => {
    const accepted = partitionMessages([meta(30, 1), meta(30, 2)], 8, 50)
    expect(accepted).toHaveLength(1)
  })
})

// ─────────────────────────────── 窗口合并 ───────────────────────────────

describe('MergeCoordinator：窗口合并与顺序', () => {
  it('窗口内多条消息合并为一次提交，保持到达顺序且只提交一条消息', async () => {
    const { coordinator, timers } = setup()
    const agent = makeAgent('idle')
    const record = makeRecord('c2c', agent)

    expect(coordinator.submit(record, makeMeta('第一条'))).toBe(true)
    expect(coordinator.submit(record, makeMeta('第二条'))).toBe(true)
    expect(coordinator.submit(record, makeMeta('第三条'))).toBe(true)
    expect(coordinator.snapshot()).toEqual({ activeBatches: 1, pendingMessages: 3 })

    await timers.runAll()

    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.steer).not.toHaveBeenCalled()
    const input = agent.followup.mock.calls[0]![0] as { content: Array<{ text?: string }> }
    const text = input.content[0]!.text ?? ''
    expect(text.indexOf('第一条')).toBeLessThan(text.indexOf('第二条'))
    expect(text.indexOf('第二条')).toBeLessThan(text.indexOf('第三条'))
    expect(text).toContain('共 3 条')

    const counters = coordinator.getCounters()
    expect(counters.batchesMerged).toBe(1)
    expect(counters.messagesFollowedUp).toBe(3)
    expect(counters.messagesSteered).toBe(0)
    expect(coordinator.getLastBatch()).toMatchObject({
      sessionKey: sessionKeyOf(record),
      count: 3,
      mode: 'followup',
      ok: true,
    })
    expect(coordinator.snapshot()).toEqual({ activeBatches: 0, pendingMessages: 0 })
  })

  it('窗口续期：新消息到达后旧定时器取消，只按最后一个窗口 flush', async () => {
    const { coordinator, timers } = setup()
    const agent = makeAgent('idle')
    const record = makeRecord('c2c', agent)

    coordinator.submit(record, makeMeta('一'))
    const [first] = timers.pending
    coordinator.submit(record, makeMeta('二'))
    expect(timers.wasCancelled(first)).toBe(true)
    expect(timers.pending).toHaveLength(1)

    await timers.runAll()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const text = (agent.followup.mock.calls[0]![0] as { content: Array<{ text?: string }> }).content[0]!.text ?? ''
    expect(text).toContain('一')
    expect(text).toContain('二')
  })

  it('不同 QQ 会话互相隔离：各自独立窗口与提交', async () => {
    const { coordinator, timers } = setup()
    const a1 = makeAgent('idle')
    const a2 = makeAgent('idle')
    const record1 = makeRecord('c2c', a1, 'user-a')
    const record2 = makeRecord('c2c', a2, 'user-b')

    coordinator.submit(record1, makeMeta('给 A', 'user-a'))
    coordinator.submit(record2, makeMeta('给 B', 'user-b'))
    expect(coordinator.snapshot().activeBatches).toBe(2)

    await timers.runAll()
    expect(a1.followup).toHaveBeenCalledTimes(1)
    expect(a2.followup).toHaveBeenCalledTimes(1)
    const textA = (a1.followup.mock.calls[0]![0] as { content: Array<{ text?: string }> }).content[0]!.text ?? ''
    expect(textA).toContain('给 A')
    expect(textA).not.toContain('给 B')
  })
})

// ─────────────────────────────── 忙碌 steer vs 空闲 followup ───────────────────────────────

describe('MergeCoordinator：忙碌 steer / 空闲 followup', () => {
  it('agent running → 一条结构化消息 steer（不 followup、不 cancel）', async () => {
    const { coordinator, timers } = setup()
    const agent = makeAgent('running')
    const record = makeRecord('c2c', agent)

    coordinator.submit(record, makeMeta('补充 1'))
    coordinator.submit(record, makeMeta('补充 2'))
    await timers.runAll()

    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.status).toBe('running')
    const counters = coordinator.getCounters()
    expect(counters.messagesSteered).toBe(2)
    expect(counters.messagesFollowedUp).toBe(0)
    expect(counters.steerFallbacks).toBe(0)
    expect(coordinator.getLastBatch()?.mode).toBe('steer')
  })

  it('flush 时重新检查 status：提交时 busy、窗口到期前已 idle → followup', async () => {
    const { coordinator, timers } = setup()
    const agent = makeAgent('running')
    const record = makeRecord('c2c', agent)

    coordinator.submit(record, makeMeta('补充'))
    agent.status = 'idle'
    await timers.runAll()

    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })

  it('busyPolicy=queue 时即使忙碌也 followup（旧排队语义）', async () => {
    const { coordinator, timers } = setup({ config: { busyPolicy: 'queue' } })
    const agent = makeAgent('running')
    const record = makeRecord('c2c', agent)

    coordinator.submit(record, makeMeta('补充'))
    await timers.runAll()

    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(coordinator.getLastBatch()?.mode).toBe('followup')
  })

  it('steer 抛错（竞态）→ 降级 followup 并计入 steerFallbacks', async () => {
    const { coordinator, timers } = setup()
    const agent = makeAgent('running')
    agent.steerThrows = true
    const record = makeRecord('c2c', agent)

    coordinator.submit(record, makeMeta('竞态消息'))
    await timers.runAll()

    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const counters = coordinator.getCounters()
    expect(counters.steerFallbacks).toBe(1)
    expect(counters.messagesFollowedUp).toBe(1)
    expect(coordinator.getLastBatch()).toMatchObject({ mode: 'followup', ok: true })
  })

  it('followup 也失败 → lastBatch ok=false 并通过扩展自己的 bot 告知用户（不静默丢弃）', async () => {
    const bot = fakeBot()
    const { coordinator, timers } = setup({ bot })
    const agent = makeAgent('idle')
    agent.followupThrows = true
    const record = makeRecord('c2c', agent)

    coordinator.submit(record, makeMeta('送不出去的消息'))
    await timers.runAll()

    const last = coordinator.getLastBatch()
    expect(last?.ok).toBe(false)
    expect(last?.error).toContain('agent disposed')
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1)
    const notice = bot.sendMarkdown.mock.calls[0]![1] as string
    expect(notice).toContain('未能送达')
  })
})

// ─────────────────────────────── 上限 / 溢出 ───────────────────────────────

describe('MergeCoordinator：批次上限与溢出兜底', () => {
  it('超过 maxBatchMessages 的消息不会丢：通知用户 + 作为下一批 followup', async () => {
    const bot = fakeBot()
    const { coordinator, timers } = setup({ bot, config: { maxBatchMessages: 2 } })
    const agent = makeAgent('running')
    const record = makeRecord('c2c', agent)

    for (let i = 1; i <= 5; i += 1) coordinator.submit(record, makeMeta(`消息${i}`))
    await timers.runAll()

    // 第一批 2 条 steer
    expect(agent.steer).toHaveBeenCalledTimes(1)
    const firstText = (agent.steer.mock.calls[0]![0] as { content: Array<{ text?: string }> }).content[0]!.text ?? ''
    expect(firstText).toContain('消息1')
    expect(firstText).toContain('消息2')
    expect(firstText).not.toContain('消息3')
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1)
    expect(bot.sendMarkdown.mock.calls[0]![1] as string).toContain('第 3 条起共 3 条')
    expect(coordinator.getCounters().messagesOverflowed).toBe(3)
    expect(coordinator.snapshot()).toEqual({ activeBatches: 1, pendingMessages: 3 })

    // 第二批：强制 followup（即使 agent 仍 running），内容为剩余消息
    await timers.runAll()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    const secondText = (agent.followup.mock.calls[0]![0] as { content: Array<{ text?: string }> }).content[0]!.text ?? ''
    expect(secondText).toContain('消息3')
    expect(secondText).toContain('消息4')
    expect(secondText).not.toContain('消息5')
    // 溢出批次自身再溢出不重复计数（5 条里只有第一次推出的 3 条计入）
    expect(coordinator.getCounters().messagesOverflowed).toBe(3)

    // 第三批：最后 1 条
    await timers.runAll()
    expect(agent.followup).toHaveBeenCalledTimes(2)
    const thirdText = (agent.followup.mock.calls[1]![0] as { content: Array<{ text?: string }> }).content[0]!.text ?? ''
    expect(thirdText).toContain('消息5')
    expect(coordinator.getCounters().messagesFollowedUp).toBe(3)
  })

  it('超过 maxBatchChars 时按字符截断并溢出到下一批', async () => {
    const bot = fakeBot()
    // 契约归一化把字符上限夹到 200–20000，这里用 200 作上限
    const { coordinator, timers } = setup({ bot, config: { maxBatchChars: 200 } })
    const agent = makeAgent('idle')
    const record = makeRecord('c2c', agent)

    await timers.runAll()
    coordinator.submit(record, makeMeta('a'.repeat(150)))
    coordinator.submit(record, makeMeta('b'.repeat(150)))
    await timers.runAll()

    expect(agent.followup).toHaveBeenCalledTimes(1)
    const text = (agent.followup.mock.calls[0]![0] as { content: Array<{ text?: string }> }).content[0]!.text ?? ''
    expect(text).toContain('a'.repeat(150))
    expect(text).not.toContain('b'.repeat(150))
    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1)
    expect(coordinator.getCounters().messagesOverflowed).toBe(1)
    await timers.runAll()
    expect(agent.followup).toHaveBeenCalledTimes(2)
  })
})

// ─────────────────────────────── 群聊作用域 ───────────────────────────────

describe('MergeCoordinator：群聊默认不合并 / 启用后按发送者分组', () => {
  it('默认配置下群聊不接管（submit=false，不排窗口）', () => {
    const { coordinator, timers } = setup()
    const agent = makeAgent('idle')
    const record = makeRecord('group', agent)

    expect(coordinator.enabledFor('group')).toBe(false)
    expect(coordinator.submit(record, makeMeta('群消息', 'member-1'))).toBe(false)
    expect(timers.pending).toHaveLength(0)
  })

  it('启用群聊合并后：不同发送者各自成批，只合并同一发送者的消息', async () => {
    const { coordinator, timers } = setup({ config: { scope: { c2c: true, group: true } } })
    const agent = makeAgent('idle')
    const record = makeRecord('group', agent)

    coordinator.submit(record, makeMeta('甲 1', 'member-a', '甲'))
    coordinator.submit(record, makeMeta('乙 1', 'member-b', '乙'))
    coordinator.submit(record, makeMeta('甲 2', 'member-a', '甲'))
    expect(coordinator.snapshot()).toEqual({ activeBatches: 2, pendingMessages: 3 })

    await timers.runAll()
    expect(agent.followup).toHaveBeenCalledTimes(2)
    const texts = agent.followup.mock.calls.map(
      (call) => ((call[0] as { content: Array<{ text?: string }> }).content[0]!.text ?? ''),
    )
    const forA = texts.find((text) => text.includes('甲 1'))
    const forB = texts.find((text) => text.includes('乙 1'))
    expect(forA).toBeDefined()
    expect(forB).toBeDefined()
    expect(forA).toContain('甲 2')
    expect(forA).not.toContain('乙 1')
    expect(forB).not.toContain('甲 2')
  })

  it('私聊关闭 scope.c2c 时不接管', () => {
    const { coordinator } = setup({ config: { scope: { c2c: false, group: true } } })
    const record = makeRecord('c2c', makeAgent('idle'))
    expect(coordinator.enabledFor('c2c')).toBe(false)
    expect(coordinator.submit(record, makeMeta('x'))).toBe(false)
  })

  it('合并总开关关闭时一切保持官方 0.5.3 行为', () => {
    const { coordinator } = setup({ config: { enabled: false } })
    const record = makeRecord('c2c', makeAgent('running'))
    expect(coordinator.enabledFor('c2c')).toBe(false)
    expect(coordinator.submit(record, makeMeta('x'))).toBe(false)
    expect(coordinator.shouldBypass({ message: { replyTarget: { scope: 'c2c' }, senderId: 'u1' } })).toBe(false)
  })
})

// ─────────────────────────────── urgentPredicate ───────────────────────────────

describe('MergeCoordinator.shouldBypass（concurrencyGuard urgentPredicate）', () => {
  it('合并启用且私聊在范围内 → true', () => {
    const { coordinator } = setup()
    expect(coordinator.shouldBypass({ message: { replyTarget: { scope: 'c2c' }, senderId: 'u1' } })).toBe(true)
  })

  it('群聊默认关闭 → false；启用后 → true', () => {
    const off = setup()
    expect(off.coordinator.shouldBypass({ message: { replyTarget: { scope: 'group' } } })).toBe(false)
    const on = setup({ config: { scope: { c2c: true, group: true } } })
    expect(on.coordinator.shouldBypass({ message: { replyTarget: { scope: 'group' } } })).toBe(true)
  })

  it('非法上下文/非 QQ 作用域 → false（不影响其他通道）', () => {
    const { coordinator } = setup()
    expect(coordinator.shouldBypass(undefined)).toBe(false)
    expect(coordinator.shouldBypass({})).toBe(false)
    expect(coordinator.shouldBypass({ message: { replyTarget: { scope: 'web' } } })).toBe(false)
  })
})

// ─────────────────────────────── 计数 / 清理 ───────────────────────────────

describe('MergeCoordinator：turn 结束与资源清理', () => {
  it('steer 后的 turn 以 aborted 结束 → batchesAborted+1；completed 不计数', async () => {
    const { coordinator, timers } = setup()
    const agent = makeAgent('running')
    const record = makeRecord('c2c', agent)
    const key = sessionKeyOf(record)

    coordinator.submit(record, makeMeta('补充'))
    await timers.runAll()
    expect(agent.steer).toHaveBeenCalledTimes(1)

    coordinator.noteTurnEnd(key, true)
    expect(coordinator.getCounters().batchesAborted).toBe(1)
    // 同一 turn 的重复/后续结束事件不重复计数
    coordinator.noteTurnEnd(key, true)
    expect(coordinator.getCounters().batchesAborted).toBe(1)

    coordinator.submit(record, makeMeta('补充2'))
    await timers.runAll()
    coordinator.noteTurnEnd(key, false)
    expect(coordinator.getCounters().batchesAborted).toBe(1)
  })

  it('dispose 清空待 flush 批次：之后不再提交、不再有定时器', async () => {
    const { coordinator, timers } = setup()
    const agent = makeAgent('idle')
    const record = makeRecord('c2c', agent)
    coordinator.submit(record, makeMeta('x'))
    expect(timers.pending).toHaveLength(1)

    coordinator.dispose()
    expect(coordinator.snapshot()).toEqual({ activeBatches: 0, pendingMessages: 0 })
    await timers.runAll()
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('配置归一化：windowMs / 上限越界被夹到契约范围', () => {
    const coordinator = new MergeCoordinator({
      logger: createLogger(),
      config: { enabled: true, windowMs: 50, maxBatchMessages: 999, maxBatchChars: 999999 },
    })
    const config = coordinator.getConfig()
    expect(config.windowMs).toBe(100)
    expect(config.maxBatchMessages).toBe(50)
    expect(config.maxBatchChars).toBe(20000)
  })
})

// ─────────────────────────────── turn-stopping 并入当前轮 ───────────────────────────────

describe('MergeCoordinator.flushSession（agent/turn-stopping）', () => {
  it('立即同步 steer：不等窗口到期，消息并入当前轮而不是留到下一轮', async () => {
    const { coordinator, timers } = setup()
    const agent = makeAgent('running')
    const record = makeRecord('c2c', agent)

    coordinator.submit(record, makeMeta('收尾时到达 1'))
    coordinator.submit(record, makeMeta('收尾时到达 2'))
    expect(agent.steer).not.toHaveBeenCalled() // 窗口尚未到期
    expect(timers.pending).toHaveLength(1)

    coordinator.flushSession(record)
    // steer 在监听器调用栈内同步发生（turn-stopping 是 serial 派发，机器随后重读 inbox）
    expect(agent.steer).toHaveBeenCalledTimes(1)
    expect(timers.pending).toHaveLength(0)

    await flushMicrotasks()
    expect(agent.steer).toHaveBeenCalledTimes(1)
    const text = (agent.steer.mock.calls[0]![0] as { content: Array<{ text?: string }> }).content[0]!.text ?? ''
    expect(text).toContain('收尾时到达 1')
    expect(text).toContain('收尾时到达 2')
    expect(coordinator.getCounters().messagesSteered).toBe(2)
  })

  it('只 flush 该会话的普通批次：其他会话与溢出批次不受影响', async () => {
    const bot = fakeBot()
    const { coordinator, timers } = setup({ bot })
    const agentA = makeAgent('running')
    const agentB = makeAgent('running')
    const recordA = makeRecord('c2c', agentA, 'user-a')
    const recordB = makeRecord('c2c', agentB, 'user-b')

    coordinator.submit(recordA, makeMeta('A 的消息', 'user-a'))
    coordinator.submit(recordB, makeMeta('B 的消息', 'user-b'))
    expect(coordinator.snapshot().activeBatches).toBe(2)

    coordinator.flushSession(recordA)
    await flushMicrotasks()
    expect(agentA.steer).toHaveBeenCalledTimes(1)
    expect(agentB.steer).not.toHaveBeenCalled()
    expect(coordinator.snapshot().activeBatches).toBe(1)
    await timers.runAll()
    expect(agentB.steer).toHaveBeenCalledTimes(1)
  })

  it('没有待处理批次时是安全的空操作', () => {
    const { coordinator } = setup()
    const record = makeRecord('c2c', makeAgent('running'))
    expect(() => coordinator.flushSession(record)).not.toThrow()
    expect(coordinator.snapshot()).toEqual({ activeBatches: 0, pendingMessages: 0 })
  })
})
