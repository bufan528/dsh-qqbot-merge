import { describe, it, expect, vi } from 'vitest'
import { applyMergeConfigPatch, QqbotMergeRuntime } from './service.ts'
import { MergeCoordinator } from './coordinator.ts'
import type { QqbotMergeConfig } from './contract.ts'
import type { SessionRecord } from '../session/index.ts'
import type { Logger } from '../types.ts'

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function setup(options?: { initial?: Partial<QqbotMergeConfig>; persistOk?: boolean; streaming?: boolean }) {
  const logger = createLogger()
  const coordinator = new MergeCoordinator({ logger, config: { enabled: true, ...options?.initial } })
  const persist = vi.fn(() => options?.persistOk ?? true)
  const runtime = new QqbotMergeRuntime(
    {
      coordinator,
      logger,
      streamingAvailable: () => options?.streaming ?? true,
      persist,
      now: () => new Date('2026-10-27T14:00:00.000Z'),
    },
    coordinator.getConfig(),
  )
  return { runtime, coordinator, persist, logger }
}

function record(scope: 'c2c' | 'group'): SessionRecord {
  return {
    sessionKey: 'k',
    sessionId: 's',
    scope,
    peerId: 'p',
    senderId: 'p',
    agent: {},
    replyTarget: { scope, targetId: 'p' },
    handle: {},
    lastActivity: 0,
  } as unknown as SessionRecord
}

describe('QqbotMergeRuntime：契约与状态', () => {
  it('契约固定 qqbot-merge@v1（与 Memory Vault 镜像一致）', () => {
    const { runtime } = setup()
    expect(runtime.contract).toEqual({ name: 'qqbot-merge', version: 1 })
    const status = runtime.getStatus()
    expect(status.contract).toEqual({ name: 'qqbot-merge', version: 1 })
  })

  it('初始状态：revision=0、appliedAt 为 ISO、计数归零、无 lastBatch、如实描述 runtime 能力', () => {
    const { runtime } = setup()
    const status = runtime.getStatus()
    expect(status.applied.revision).toBe(0)
    expect(status.applied.appliedAt).toBe('2026-10-27T14:00:00.000Z')
    expect(status.applied).toMatchObject({ activeBatches: 0, pendingMessages: 0 })
    expect(status.runtime.steerSupported).toBe(true)
    expect(status.runtime.steerMechanism).toContain('agent.steer')
    expect(status.runtime.integration).toContain('urgentPredicate')
    expect(status.runtime.streamingRevision).toBe(true)
    expect(status.runtime.note).toContain('未验证')
    expect(status.counters).toMatchObject({
      batchesMerged: 0,
      messagesSteered: 0,
      messagesFollowedUp: 0,
      messagesOverflowed: 0,
      steerFallbacks: 0,
      replyRewrites: 0,
      repliesCompleted: 0,
      batchesAborted: 0,
    })
    expect(status.lastBatch).toBeNull()
  })

  it('getConfig 返回副本：调用方修改不会污染运行期配置', () => {
    const { runtime } = setup()
    const config = runtime.getConfig()
    config.enabled = false
    config.scope.c2c = false
    expect(runtime.getConfig().enabled).toBe(true)
    expect(runtime.getConfig().scope.c2c).toBe(true)
  })
})

describe('QqbotMergeRuntime.setConfig', () => {
  it('应用配置到协调器、递增 revision、写回插件自己的 qqbotMerge 字段', async () => {
    const { runtime, coordinator, persist } = setup()
    const status = await runtime.setConfig({ windowMs: 1200, busyPolicy: 'queue', enabled: false })

    expect(status.config.windowMs).toBe(1200)
    expect(status.config.busyPolicy).toBe('queue')
    expect(status.config.enabled).toBe(false)
    expect(status.applied.revision).toBe(1)
    expect(status.applied.appliedAt).toBe('2026-10-27T14:00:00.000Z')
    expect(coordinator.getConfig().windowMs).toBe(1200)
    expect(persist).toHaveBeenCalledTimes(1)
    const patch = persist.mock.calls[0]![0] as Record<string, unknown>
    expect(Object.keys(patch)).toEqual(['qqbotMerge'])
    expect((patch['qqbotMerge'] as QqbotMergeConfig).windowMs).toBe(1200)
  })

  it('非法值被拒绝（不写入、不递增 revision）', async () => {
    const { runtime, persist } = setup()
    await expect(runtime.setConfig({ windowMs: '800' as unknown as number })).rejects.toThrow(TypeError)
    await expect(runtime.setConfig({ busyPolicy: 'abort' as unknown as QqbotMergeConfig['busyPolicy'] })).rejects.toThrow(TypeError)
    await expect(runtime.setConfig({ replyMode: 'stream' as unknown as QqbotMergeConfig['replyMode'] })).rejects.toThrow(TypeError)
    await expect(runtime.setConfig({ scope: 'both' as unknown as QqbotMergeConfig['scope'] })).rejects.toThrow(TypeError)
    expect(persist).not.toHaveBeenCalled()
    expect(runtime.getStatus().applied.revision).toBe(0)
  })

  it('数值越界被夹到契约范围（windowMs 100–10000 / 条数 1–50 / 字符 200–20000）', async () => {
    const { runtime } = setup()
    const status = await runtime.setConfig({ windowMs: 1, maxBatchMessages: 0, maxBatchChars: 1 })
    expect(status.config.windowMs).toBe(100)
    expect(status.config.maxBatchMessages).toBe(1)
    expect(status.config.maxBatchChars).toBe(200)
  })

  it('持久化失败不假装成功：内存生效但 warn，revision 仍递增', async () => {
    const { runtime, logger } = setup({ persistOk: false })
    const status = await runtime.setConfig({ enabled: false })
    expect(status.config.enabled).toBe(false)
    expect(status.applied.revision).toBe(1)
    expect(logger.warn).toHaveBeenCalled()
  })
})

describe('QqbotMergeRuntime：回复模式与计数 hooks', () => {
  it('enabledFor：需要 enabled + single-message + 场景开关', async () => {
    const { runtime } = setup()
    expect(runtime.enabledFor(record('c2c'))).toBe(true)
    expect(runtime.enabledFor(record('group'))).toBe(false) // 群聊默认关闭

    await runtime.setConfig({ scope: { c2c: true, group: true } })
    expect(runtime.enabledFor(record('group'))).toBe(true)

    await runtime.setConfig({ replyMode: 'per-step' })
    expect(runtime.enabledFor(record('c2c'))).toBe(false)

    await runtime.setConfig({ replyMode: 'single-message', enabled: false })
    expect(runtime.enabledFor(record('c2c'))).toBe(false)
  })

  it('onRewrite / onComplete 计入 counters', () => {
    const { runtime, coordinator } = setup()
    runtime.onRewrite()
    runtime.onRewrite()
    runtime.onComplete()
    expect(coordinator.getCounters().replyRewrites).toBe(2)
    expect(coordinator.getCounters().repliesCompleted).toBe(1)
  })

  it('onTurnEnd 未经过 steer 时不计 batchesAborted', () => {
    const { runtime, coordinator } = setup()
    runtime.onTurnEnd(record('c2c'), true)
    expect(coordinator.getCounters().batchesAborted).toBe(0)
  })
})

describe('applyMergeConfigPatch', () => {
  const base: QqbotMergeConfig = {
    enabled: true,
    windowMs: 800,
    maxBatchMessages: 8,
    maxBatchChars: 4000,
    scope: { c2c: true, group: false },
    busyPolicy: 'steer',
    replyMode: 'single-message',
  }

  it('只改 patch 里出现的字段', () => {
    const next = applyMergeConfigPatch(base, { budget: undefined } as unknown as Partial<QqbotMergeConfig>)
    expect(next).toEqual(base)
    const changed = applyMergeConfigPatch(base, { busyPolicy: 'queue' })
    expect(changed.busyPolicy).toBe('queue')
    expect(changed.windowMs).toBe(800)
  })

  it('scope 是部分合并（只改显式给出的键）', () => {
    const next = applyMergeConfigPatch(base, { scope: { group: true } as QqbotMergeConfig['scope'] })
    expect(next.scope).toEqual({ c2c: true, group: true })
  })

  it('null / 数组 / 非对象 patch 被拒绝', () => {
    expect(() => applyMergeConfigPatch(base, null as unknown as Partial<QqbotMergeConfig>)).toThrow(TypeError)
    expect(() => applyMergeConfigPatch(base, [] as unknown as Partial<QqbotMergeConfig>)).toThrow(TypeError)
    expect(() => applyMergeConfigPatch(base, 'x' as unknown as Partial<QqbotMergeConfig>)).toThrow(TypeError)
  })
})
