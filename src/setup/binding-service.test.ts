/**
 * BindingService 状态机测试
 *
 * 用可控的假 connector 驱动，覆盖：
 * waiting 相位与呈现通知、refresh 重建任务、扫码成功收敛为凭据、
 * 失败终结、dispose 静默退出、陈旧 generation 丢弃。
 */
import { describe, expect, it, vi } from 'vitest';
import type { QrConnectCallbacks, QrConnectOptions } from '@tencent-connect/qqbot-connector';
import { BindingService } from './binding-service.ts';
import type { QrPresenter } from './presenters.ts';

/** 测试用假 connector：捕获每次连接的回调与 signal，允许手动驱动 */
class FakeConnect {
  readonly sessions: Array<{
    callbacks: QrConnectCallbacks;
    options: QrConnectOptions | undefined;
    abort: () => void;
  }> = [];

  readonly connect = (callbacks: QrConnectCallbacks, options?: QrConnectOptions): (() => void) => {
    const controller = new AbortController();
    // 模拟真实 connector：signal abort 后触发 onFailure('已取消')
    options?.signal?.addEventListener('abort', () => {
      callbacks.onFailure(new Error('已取消'));
    }, { once: true });
    this.sessions.push({ callbacks, options, abort: () => controller.abort() });
    return () => controller.abort();
  };

  get latest(): { callbacks: QrConnectCallbacks; options: QrConnectOptions | undefined; abort: () => void } {
    const session = this.sessions.at(-1);
    if (session === undefined) throw new Error('no connect session');
    return session;
  }
}

function createService(fake: FakeConnect) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const service = new BindingService({
    source: 'test',
    logger,
    connect: fake.connect as unknown as typeof import('@tencent-connect/qqbot-connector').startQrConnect,
    renderQr: async () => 'data:image/svg+xml;base64,TEST',
  });
  return { service, logger };
}

function flush(microtasks = 3): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < microtasks; i++) chain = chain.then(() => new Promise((r) => { setTimeout(r, 0); }));
  return chain;
}

describe('BindingService', () => {
  it('二维码就绪后进入 waiting 相位并通知呈现策略', async () => {
    const fake = new FakeConnect();
    const { service } = createService(fake);
    const presenter: QrPresenter = {
      id: 'test',
      printQrToConsole: true,
      onQrDisplayed: vi.fn(),
      onQrExpired: vi.fn(),
    };
    service.attach(presenter);
    void service.start();
    await flush();

    fake.latest.callbacks.onQrDisplayed?.('https://q.qq.com/connect?task_id=t1');
    await flush();

    expect(service.wireState()).toEqual({
      phase: 'waiting',
      url: 'https://q.qq.com/connect?task_id=t1',
      qrSvg: 'data:image/svg+xml;base64,TEST',
      issuedAt: expect.any(Number),
    });
    expect(fake.latest.options?.displayQrCodeToConsole).toBe(true);
    expect(presenter.onQrDisplayed).toHaveBeenCalledWith('https://q.qq.com/connect?task_id=t1');
    service.dispose();
  });

  it('无终端呈现时不在控制台打印二维码', async () => {
    const fake = new FakeConnect();
    const { service } = createService(fake);
    void service.start();
    await flush();
    expect(fake.latest.options?.displayQrCodeToConsole).toBe(false);
    service.dispose();
  });

  it('扫码成功：start() 解析凭据并进入 saving 相位', async () => {
    const fake = new FakeConnect();
    const { service } = createService(fake);
    const promise = service.start();
    await flush();

    fake.latest.callbacks.onSuccess([{ appId: 'app-1', appSecret: 'secret-1' }]);
    await expect(promise).resolves.toEqual({ appId: 'app-1', appSecret: 'secret-1' });
    expect(service.wireState()).toEqual({ phase: 'saving' });
  });

  it('refresh：abort 当前任务并重建（新二维码 URL）', async () => {
    const fake = new FakeConnect();
    const { service } = createService(fake);
    void service.start();
    await flush();
    fake.latest.callbacks.onQrDisplayed?.('https://q.qq.com/t1');
    await flush();
    expect(fake.sessions.length).toBe(1);

    service.refresh();
    await flush();
    // 旧任务 abort 后 onFailure('已取消') → 循环重建
    expect(fake.sessions.length).toBe(2);

    fake.latest.callbacks.onQrDisplayed?.('https://q.qq.com/t2');
    await flush();
    expect(service.wireState()).toMatchObject({ phase: 'waiting', url: 'https://q.qq.com/t2' });
    service.dispose();
  });

  it('连接失败：进入 failed 相位且 start() 解析 null', async () => {
    const fake = new FakeConnect();
    const { service } = createService(fake);
    const promise = service.start();
    await flush();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fake.latest.callbacks.onFailure(new Error('获取绑定任务失败'));
    await expect(promise).resolves.toBeNull();
    expect(service.wireState()).toEqual({ phase: 'failed', reason: '获取绑定任务失败' });
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it('空凭据：软失败终结（不进入无限 refresh 循环）', async () => {
    const fake = new FakeConnect();
    const { service } = createService(fake);
    const promise = service.start();
    await flush();

    fake.latest.callbacks.onSuccess([]);
    await expect(promise).resolves.toBeNull();
    expect(service.wireState()).toEqual({ phase: 'failed', reason: '扫码未返回有效凭据' });
  });

  it('dispose：静默退出，start() 解析 null 且不再重建任务', async () => {
    const fake = new FakeConnect();
    const { service } = createService(fake);
    const promise = service.start();
    await flush();

    service.dispose();
    fake.latest.callbacks.onFailure(new Error('已取消'));
    await expect(promise).resolves.toBeNull();

    const sessionCount = fake.sessions.length;
    await flush();
    expect(fake.sessions.length).toBe(sessionCount);
  });

  it('陈旧 generation 的二维码事件被丢弃（refresh 竞态防护）', async () => {
    const fake = new FakeConnect();
    const { service } = createService(fake);
    void service.start();
    await flush();

    const stale = fake.latest.callbacks;
    service.refresh();
    await flush();
    expect(fake.sessions.length).toBe(2);

    // 旧任务的 onQrDisplayed 迟到，不得覆盖新任务状态
    stale.onQrDisplayed?.('https://q.qq.com/stale');
    await flush();
    expect(service.wireState()).toEqual({ phase: 'starting' });

    fake.latest.callbacks.onQrDisplayed?.('https://q.qq.com/fresh');
    await flush();
    expect(service.wireState()).toMatchObject({ phase: 'waiting', url: 'https://q.qq.com/fresh' });
    service.dispose();
  });
});
