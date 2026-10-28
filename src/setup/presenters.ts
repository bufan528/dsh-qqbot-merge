/**
 * 扫码呈现策略（QrPresenter）
 *
 * 绑定协议（qqbot-connector 轮询）与呈现解耦：BindingService 只依赖
 * 本接口，具体实现由宿主形态决定——终端宿主打印 ASCII 二维码与可点击
 * 链接；Desktop 宿主无可见终端，改由端内绑定页（bind-routes）承载。
 */
import { spawn } from 'node:child_process';
import type { Logger } from '../types.ts';

/** 呈现策略接口：二维码事件的通知接收方 */
export interface QrPresenter {
  /** 实现标识（诊断用） */
  readonly id: string;
  /** 是否让 connector 在控制台打印 ASCII 二维码（仅终端可见的宿主开启） */
  readonly printQrToConsole: boolean;
  /** 二维码 URL 就绪（首次与过期刷新均会触发） */
  onQrDisplayed(url: string): void;
  /** 二维码过期，即将刷新 */
  onQrExpired?(): void;
}

/**
 * 是否运行在 DSH Desktop 宿主中。
 *
 * Desktop 的 Host 以 ELECTRON_RUN_AS_NODE=1 的 Electron 子进程运行
 * （Desktop 宿主的启动约定），stdout 对用户不可见，终端呈现无意义。
 */
export function isDesktopHost(): boolean {
  return process.env.ELECTRON_RUN_AS_NODE === '1' && typeof process.versions?.electron === 'string';
}

/** 终端可点击的 OSC 8 超链接（不支持 OSC 8 的终端会忽略控制序列，退化为纯 URL 文本） */
export function clickableLink(url: string): string {
  return `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`;
}

/**
 * 终端呈现（CLI / `dsh web` 运营者通道）
 *
 * ASCII 二维码由 connector 打印（printQrToConsole=true），
 * 本呈现只补打可点击链接与过期提示。
 *
 * 绑定引导是用户直接交互内容，必须用普通 console.log 输出：
 * 不带时间戳/级别前缀（避免打断二维码块），不受日志级别配置影响。
 */
export function createTerminalPresenter(): QrPresenter {
  return {
    id: 'terminal',
    printQrToConsole: true,
    onQrDisplayed(url: string): void {
      console.log('二维码显示异常？点击下方链接，用浏览器打开即可完成扫码:');
      console.log(`  ${clickableLink(url)}\n`);
    },
    onQrExpired(): void {
      console.log('二维码已过期，正在刷新…\n');
    },
  };
}

/**
 * 系统浏览器呈现（降级通道）
 *
 * Desktop 端内绑定页不可用时的自救入口：每次绑定会话只自动拉起一次
 * 浏览器（二维码过期刷新不重复弹窗）。默认关闭，通过环境变量
 * QQBOT_BIND_OPEN_BROWSER=1 显式启用。
 */
export function createBrowserPresenter(logger: Logger): QrPresenter {
  let opened = false;
  return {
    id: 'browser',
    printQrToConsole: false,
    onQrDisplayed(url: string): void {
      console.log(`扫码绑定链接: ${url}`);
      if (opened) return;
      opened = true;
      openInBrowser(url, logger);
    },
    onQrExpired(): void {
      console.log('二维码已过期，正在刷新…（如浏览器中页面失效，请点击「刷新二维码」）');
    },
  };
}

/** 跨平台拉起系统浏览器打开 URL（失败静默降级为日志输出） */
function openInBrowser(url: string, logger: Logger): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (err: Error) => {
      logger.warn(`拉起浏览器失败: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    logger.warn(`拉起浏览器失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
