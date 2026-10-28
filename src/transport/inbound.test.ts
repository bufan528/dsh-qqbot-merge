import { describe, it, expect, vi } from 'vitest'
import { handleInbound } from './inbound.ts'
import type { MergeInboundRouter, MergeMessageMeta } from '../merge/coordinator.ts'
import type { SessionManager, SessionRecord } from '../session/index.ts'
import type { ImQQBotConfig } from '../config.ts'
import type { Logger } from '../types.ts'

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function createConfig(): ImQQBotConfig {
  return {
    appId: 'app-1',
    appSecret: 'secret',
    requireMention: true,
    historyLimit: 10,
    textChunkLimit: 4500,
  } as unknown as ImQQBotConfig
}

function createRecord() {
  const agent = {
    followup: vi.fn(),
    whenIdle: vi.fn(async () => undefined),
    steer: vi.fn(),
    status: 'running' as const,
  }
  const record = {
    sessionKey: 'qqbot:app-1:c2c:u1',
    sessionId: 'sess-1',
    scope: 'c2c',
    peerId: 'u1',
    senderId: 'u1',
    agent,
    replyTarget: { scope: 'c2c', targetId: 'u1', msgId: 'm1' },
    handle: {},
    lastActivity: 0,
  } as unknown as SessionRecord
  return { record, agent }
}

function createContext(message: Record<string, unknown>) {
  const bot = { sendMarkdown: vi.fn(async () => undefined), openStream: vi.fn() }
  return {
    ctx: {
      message,
      state: {},
      bot,
    } as never,
    bot,
  }
}

const baseMessage = {
  rawEventType: 'C2C_MESSAGE_CREATE',
  kind: 'c2c',
  senderId: 'u1',
  content: '帮我改一下报告',
  messageId: 'm1',
  timestamp: '2026-10-27T14:00:00.000Z',
}

describe('handleInbound：合并启用时交给协调器且不阻塞', () => {
  it('调用 coordinator.submit，不调用 followup / whenIdle', async () => {
    const { record, agent } = createRecord()
    const manager = { getOrCreate: vi.fn(async () => record) } as unknown as SessionManager
    const { ctx } = createContext({ ...baseMessage })
    const submitted: Array<{ record: SessionRecord; meta: MergeMessageMeta }> = []
    const merge: MergeInboundRouter = {
      enabledFor: vi.fn(() => true),
      submit: vi.fn((r: SessionRecord, meta: MergeMessageMeta) => {
        submitted.push({ record: r, meta })
        return true
      }),
    }

    await handleInbound(ctx, manager, createConfig(), createLogger(), merge)

    expect(merge.enabledFor).toHaveBeenCalledWith('c2c', 'u1')
    expect(merge.submit).toHaveBeenCalledTimes(1)
    expect(submitted[0]!.meta.body).toContain('帮我改一下报告')
    expect(submitted[0]!.meta.senderId).toBe('u1')
    expect(submitted[0]!.meta.messageId).toBe('m1')
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.whenIdle).not.toHaveBeenCalled()
  })

  it('submit 返回 false（不在范围）→ 回落到官方 followup + whenIdle', async () => {
    const { record, agent } = createRecord()
    const manager = { getOrCreate: vi.fn(async () => record) } as unknown as SessionManager
    const { ctx } = createContext({ ...baseMessage })
    const merge: MergeInboundRouter = {
      enabledFor: vi.fn(() => true),
      submit: vi.fn(() => false),
    }

    await handleInbound(ctx, manager, createConfig(), createLogger(), merge)

    expect(merge.submit).toHaveBeenCalledTimes(1)
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.whenIdle).toHaveBeenCalledTimes(1)
  })

  it('未提供协调器（官方行为）→ followup + 阻塞 whenIdle', async () => {
    const { record, agent } = createRecord()
    const manager = { getOrCreate: vi.fn(async () => record) } as unknown as SessionManager
    const { ctx } = createContext({ ...baseMessage })

    await handleInbound(ctx, manager, createConfig(), createLogger())

    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.whenIdle).toHaveBeenCalledTimes(1)
  })

  it('协调器对该会话未启用 → followup + whenIdle（旧行为）', async () => {
    const { record, agent } = createRecord()
    const manager = { getOrCreate: vi.fn(async () => record) } as unknown as SessionManager
    const { ctx } = createContext({ ...baseMessage })
    const merge: MergeInboundRouter = {
      enabledFor: vi.fn(() => false),
      submit: vi.fn(() => true),
    }

    await handleInbound(ctx, manager, createConfig(), createLogger(), merge)

    expect(merge.submit).not.toHaveBeenCalled()
    expect(agent.followup).toHaveBeenCalledTimes(1)
    expect(agent.whenIdle).toHaveBeenCalledTimes(1)
  })
})
