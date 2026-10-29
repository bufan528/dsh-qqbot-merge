/**
 * 连续消息智能合并设置面板 — 设置页「连续消息智能合并」栏目
 *
 * 数据流（与宿主 merge/routes.ts 同源）：
 *   GET  /qqbot/im-qqbot/merge            → { ok, status }（status = runtime.getStatus()）
 *   POST /qqbot/im-qqbot/merge { config } → 校验后 runtime.setConfig，返回同样的 status
 *
 * 面板内容：合并开关、静默窗口 / 单批条数上限 / 单批字符上限、私聊/群聊
 * 开关、运行中策略（steer / queue）、回复模式（single-message / per-step）、
 * 保存按钮，以及运行期诊断（steer 支持情况、计数 8 项、最近一批）。
 *
 * 降级策略：路由 404（插件尚未绑定 / 旧版本 / webServer 未就绪）时显示
 * 「尚未就绪」而不是抛错；保存后宿主会因写入 profile 触发 HMR 重载，
 * 重载后 revision 归零属正常，面板提示可点「刷新」查看最新状态。
 *
 * 样式沿用 config-panel.ts 的 DSW 设置行风格（设置列、0.5px 分隔、
 * Switch / SegmentedControl 原语、反色主按钮），类名走独立的 imqbm-*
 * 命名空间，避免与绑定页 / 基础配置面板的样式互相覆盖；颜色取
 * --dsw-alias-* 主题变量，缺省值兜底。运行时仅依赖 react。
 */
import {
  createElement,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  QqbotMergeConfig,
  QqbotMergeCounters,
  QqbotMergeLastBatch,
  QqbotMergeStatus,
} from '../merge/contract.ts';
import { MERGE_CONFIG_PATH, type MergeStatusResponse } from '../shared/merge-protocol.ts';

// ── 类型 ──

/** 面板相位：加载中 / 可编辑 / 路由未注册（优雅降级）/ 加载失败 */
type Phase = 'loading' | 'ready' | 'unavailable' | 'error';

/** 表单草稿：数值字段用字符串保存，允许用户清空后重新输入 */
interface Draft {
  enabled: boolean;
  windowMs: string;
  maxBatchMessages: string;
  maxBatchChars: string;
  scopeC2c: boolean;
  scopeGroup: boolean;
  busyPolicy: QqbotMergeConfig['busyPolicy'];
  replyMode: QqbotMergeConfig['replyMode'];
}

/** 数值字段的合法区间（与宿主 HTTP 校验、契约归一化区间一致） */
const LIMITS = {
  windowMs: { min: 100, max: 10000, label: '静默窗口' },
  maxBatchMessages: { min: 1, max: 50, label: '单批条数上限' },
  maxBatchChars: { min: 200, max: 20000, label: '单批字符上限' },
} as const;

const BUSY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'steer', label: '并入当前轮' },
  { value: 'queue', label: '排队下一轮' },
];

const REPLY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'single-message', label: '同一条修订' },
  { value: 'per-step', label: '逐条发送' },
];

/** 计数项（顺序与面板展示一致） */
const COUNTER_ITEMS: ReadonlyArray<{ key: keyof QqbotMergeCounters; label: string }> = [
  { key: 'batchesMerged', label: '合并批次' },
  { key: 'messagesSteered', label: '并入当前轮' },
  { key: 'messagesFollowedUp', label: '空闲提交' },
  { key: 'messagesOverflowed', label: '超限溢出' },
  { key: 'steerFallbacks', label: 'steer 降级' },
  { key: 'replyRewrites', label: '单条修订' },
  { key: 'repliesCompleted', label: '单条完成' },
  { key: 'batchesAborted', label: '批次中止' },
];

const PAD_STYLE: CSSProperties = { padding: '12px 0' };

// ── 样式（幂等注入：设置页各栏目独立挂载，不移除全局样式） ──

const STYLE_ID = 'im-qqbot-merge-panel-styles';

function installMergePanelStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.imqbm-form { display: flex; flex-direction: column; width: 100%; }
.imqbm-group-title {
  padding: 14px 0 2px; font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #8a8f99); text-transform: uppercase; letter-spacing: .04em;
}
.imqbm-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.imqbm-field + .imqbm-field { border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25)); }
.imqbm-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.imqbm-label {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.imqbm-help { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #5c6370); }
.imqbm-hint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-tertiary, #8a8f99); }
/* Switch（aria-checked 驱动，视觉态与无障碍态同源） */
.imqbm-switch {
  box-sizing: border-box; position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.45)); cursor: pointer; font: inherit;
}
.imqbm-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary, var(--dsw-alias-brand, #4d6bfe)); }
.imqbm-switch:disabled { cursor: default; opacity: 0.5; }
.imqbm-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand, #4d6bfe));
  outline-offset: 2px;
}
.imqbm-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #ffffff);
  transition: transform 120ms ease;
}
.imqbm-switch[aria-checked='true'] .imqbm-switch-thumb {
  background: var(--dsw-alias-label-primary-foreground, #ffffff);
  transform: translateX(16px);
}
/* 数字输入（与官方 fields.input 同高，右对齐便于比较数值） */
.imqbm-input {
  box-sizing: border-box; flex: 0 0 auto; width: 96px; height: 34px; padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4)));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.08));
  font: inherit; font-size: 13px; line-height: 1.5; text-align: right;
  color: var(--dsw-alias-label-primary, #1f2329); outline: none;
  font-variant-numeric: tabular-nums;
}
.imqbm-input:focus { border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand, #4d6bfe)); }
.imqbm-input:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand, #4d6bfe));
  outline-offset: -1px;
}
/* 分段控件（官方 SegmentedControl 复刻：指示器按段数/索引定位） */
.imqbm-seg {
  position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
}
.imqbm-seg-indicator {
  position: absolute; top: 4px; left: 4px;
  width: calc((100% - 8px - 2px * (var(--imqbm-seg-count) - 1)) / var(--imqbm-seg-count));
  height: calc(100% - 8px);
  border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.9));
  box-shadow: var(--dsw-elevation-soft, 0 1px 3px rgba(0, 0, 0, .08));
  transform: translateX(calc(var(--imqbm-seg-index) * (100% + 2px)));
  transition: transform 160ms ease;
  pointer-events: none;
}
.imqbm-seg-tab {
  box-sizing: border-box; position: relative; z-index: 1; height: 28px; padding: 0 14px;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent;
  color: var(--dsw-alias-label-secondary, #5c6370); font: inherit; font-size: 13px; line-height: 20px;
  font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 120ms ease;
}
.imqbm-seg-tab:hover, .imqbm-seg-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary, #1f2329); }
.imqbm-seg-tab:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand, #4d6bfe));
  outline-offset: -2px;
}
/* 底栏：提示 + 刷新 + 保存 */
.imqbm-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; flex-wrap: wrap; }
.imqbm-note { flex: 1; min-width: 200px; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.imqbm-note--error { color: var(--dsw-alias-state-error-primary, #d93025); }
.imqbm-note--ok { color: var(--dsw-alias-label-secondary, #5c6370); }
.imqbm-save {
  appearance: none; flex: none; border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px); padding: 5px 14px;
  font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: var(--dsw-alias-label-primary, #1f2329); color: var(--dsw-alias-bg-layer-3, #ffffff);
}
.imqbm-save:disabled { opacity: 0.4; cursor: default; }
.imqbm-save:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand, #4d6bfe));
  outline-offset: 1px;
}
.imqbm-btn {
  appearance: none; flex: none; padding: 5px 14px; border-radius: var(--dsw-radius-md, 8px);
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4));
  background: transparent; color: inherit; font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  transition: background-color .15s ease, opacity .15s ease;
}
.imqbm-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.imqbm-btn:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand, #4d6bfe));
  outline-offset: 1px;
}
.imqbm-row { display: flex; gap: 8px; flex-wrap: wrap; }
/* 降级 / 失败提示 */
.imqbm-notice { display: flex; flex-direction: column; gap: 8px; padding: 20px 0; font-size: 13px; line-height: 1.7; }
.imqbm-notice-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2329); }
/* 运行期诊断 */
.imqbm-meta {
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.08));
}
.imqbm-meta-row { display: flex; gap: 8px; font-size: 12px; line-height: 1.6; }
.imqbm-meta-key { flex: 0 0 82px; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.imqbm-meta-value { flex: 1; min-width: 0; color: var(--dsw-alias-label-secondary, #5c6370); word-break: break-word; }
.imqbm-badge {
  display: inline-block; padding: 0 8px; border-radius: 999px; border: 0.5px solid currentColor;
  font-size: 12px; line-height: 18px; background: transparent;
}
.imqbm-badge--ok { color: var(--dsw-alias-state-success-primary, #2ba471); }
.imqbm-badge--warn { color: var(--dsw-alias-state-warning-primary, #d97706); }
/* 计数网格 */
.imqbm-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 8px; padding: 8px 0 4px; }
.imqbm-stat {
  display: flex; flex-direction: column; gap: 2px; padding: 10px 12px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.08));
}
.imqbm-stat-label { font-size: 12px; line-height: 1.4; color: var(--dsw-alias-label-tertiary, #8a8f99); }
.imqbm-stat-value {
  font-size: 16px; font-weight: 600; line-height: 1.4; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #1f2329);
}
/* 最近一批 */
.imqbm-batch {
  display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 10px 12px; margin-top: 8px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.08));
  font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #5c6370);
}
.imqbm-batch-error { color: var(--dsw-alias-state-error-primary, #d93025); }
    `;
  document.head.appendChild(style);
}

function useMergePanelStyles(): void {
  useEffect(() => { installMergePanelStyles(); }, []);
}

// ── 表单 <-> 配置 ──

function toDraft(config: QqbotMergeConfig): Draft {
  return {
    enabled: config.enabled,
    windowMs: String(config.windowMs),
    maxBatchMessages: String(config.maxBatchMessages),
    maxBatchChars: String(config.maxBatchChars),
    scopeC2c: config.scope.c2c,
    scopeGroup: config.scope.group,
    busyPolicy: config.busyPolicy,
    replyMode: config.replyMode,
  };
}

interface ParsedInt { value: number }
interface ParseError { error: string }

function parseIntInRange(raw: string, min: number, max: number, label: string): ParsedInt | ParseError {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { error: `${label}不能为空` };
  if (!/^\d+$/.test(trimmed)) return { error: `${label}必须是整数` };
  const value = Number(trimmed);
  if (value < min || value > max) return { error: `${label}需在 ${min}–${max} 之间` };
  return { value };
}

/**
 * 构造 POST 的 patch：只提交与当前生效配置不同的字段，
 * 数值非法时返回可展示的错误（不请求宿主）。
 */
function buildPatch(draft: Draft, current: QqbotMergeConfig): { patch: Partial<QqbotMergeConfig>; error?: string } {
  const patch: Partial<QqbotMergeConfig> = {};
  if (draft.enabled !== current.enabled) patch.enabled = draft.enabled;

  const windowMs = parseIntInRange(draft.windowMs, LIMITS.windowMs.min, LIMITS.windowMs.max, LIMITS.windowMs.label);
  if ('error' in windowMs) return { patch, error: windowMs.error };
  if (windowMs.value !== current.windowMs) patch.windowMs = windowMs.value;

  const maxBatchMessages = parseIntInRange(
    draft.maxBatchMessages, LIMITS.maxBatchMessages.min, LIMITS.maxBatchMessages.max, LIMITS.maxBatchMessages.label,
  );
  if ('error' in maxBatchMessages) return { patch, error: maxBatchMessages.error };
  if (maxBatchMessages.value !== current.maxBatchMessages) patch.maxBatchMessages = maxBatchMessages.value;

  const maxBatchChars = parseIntInRange(
    draft.maxBatchChars, LIMITS.maxBatchChars.min, LIMITS.maxBatchChars.max, LIMITS.maxBatchChars.label,
  );
  if ('error' in maxBatchChars) return { patch, error: maxBatchChars.error };
  if (maxBatchChars.value !== current.maxBatchChars) patch.maxBatchChars = maxBatchChars.value;

  if (draft.scopeC2c !== current.scope.c2c || draft.scopeGroup !== current.scope.group) {
    patch.scope = { c2c: draft.scopeC2c, group: draft.scopeGroup };
  }
  if (draft.busyPolicy !== current.busyPolicy) patch.busyPolicy = draft.busyPolicy;
  if (draft.replyMode !== current.replyMode) patch.replyMode = draft.replyMode;

  return { patch };
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

// ── 原语 ──

/** 开关（官方 Switch 原语结构：aria-checked 驱动视觉态） */
function Switch({ checked, label, onChange }: {
  checked: boolean; label: string; onChange: (next: boolean) => void;
}): ReactNode {
  return createElement('button', {
    type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
    className: 'imqbm-switch',
    onClick: () => { onChange(!checked); },
  }, createElement('span', { className: 'imqbm-switch-thumb' }));
}

/** 分段选择（官方 SegmentedControl 结构：CSS 变量定位滑动指示器） */
function Segmented({ value, options, onChange, label }: {
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (next: string) => void;
  label: string;
}): ReactNode {
  const index = Math.max(0, options.findIndex((option) => option.value === value));
  const trackStyle = {
    '--imqbm-seg-count': options.length,
    '--imqbm-seg-index': index,
  } as CSSProperties;
  return createElement('div', { className: 'imqbm-seg', role: 'tablist', 'aria-label': label, style: trackStyle },
    createElement('span', { className: 'imqbm-seg-indicator' }),
    options.map((option) => createElement('button', {
      key: option.value, type: 'button', role: 'tab', 'aria-selected': option.value === value,
      className: 'imqbm-seg-tab', onClick: () => { onChange(option.value); },
    }, option.label)),
  );
}

/** 开关行（label 左 + Switch 右 + 可选 help） */
function SwitchRow({ label, help, checked, onChange }: {
  label: string; help?: string; checked: boolean; onChange: (next: boolean) => void;
}): ReactNode {
  return createElement('div', { className: 'imqbm-field' },
    createElement('div', { className: 'imqbm-head' },
      createElement('span', { className: 'imqbm-label' }, label),
      createElement(Switch, { checked, label, onChange }),
    ),
    help === undefined ? null : createElement('p', { className: 'imqbm-help' }, help),
  );
}

/** 数字行（label 左 + 数字输入右 + 可选 help） */
function NumberRow({ label, help, value, min, max, onChange }: {
  label: string; help?: string; value: string; min: number; max: number;
  onChange: (next: string) => void;
}): ReactNode {
  return createElement('div', { className: 'imqbm-field' },
    createElement('div', { className: 'imqbm-head' },
      createElement('span', { className: 'imqbm-label' }, label),
      createElement('input', {
        className: 'imqbm-input', type: 'number', inputMode: 'numeric',
        min, max, step: 1, value,
        onChange: (event: ChangeEvent<HTMLInputElement>) => { onChange(event.currentTarget.value); },
      }),
    ),
    help === undefined ? null : createElement('p', { className: 'imqbm-hint' }, help),
  );
}

/** 分段选择行（label 左 + Segmented 右 + 可选 help） */
function SegmentedRow({ label, help, value, options, onChange }: {
  label: string; help?: string; value: string;
  options: ReadonlyArray<{ value: string; label: string }>; onChange: (next: string) => void;
}): ReactNode {
  return createElement('div', { className: 'imqbm-field' },
    createElement('div', { className: 'imqbm-head' },
      createElement('span', { className: 'imqbm-label' }, label),
      createElement(Segmented, { value, options, onChange, label }),
    ),
    help === undefined ? null : createElement('p', { className: 'imqbm-hint' }, help),
  );
}

/** 诊断行（左键右值） */
function MetaRow({ label, value }: { label: string; value: ReactNode }): ReactNode {
  return createElement('div', { className: 'imqbm-meta-row' },
    createElement('span', { className: 'imqbm-meta-key' }, label),
    createElement('span', { className: 'imqbm-meta-value' }, value),
  );
}

/** 状态徽标 */
function Badge({ ok, text }: { ok: boolean; text: string }): ReactNode {
  return createElement('span', { className: `imqbm-badge imqbm-badge--${ok ? 'ok' : 'warn'}` }, text);
}

/** 最近一批的详情行 */
function LastBatchRow({ batch }: { batch: QqbotMergeLastBatch | null }): ReactNode {
  if (batch === null) {
    return createElement('p', { className: 'imqbm-hint' }, '本次进程尚未合并任何批次');
  }
  return createElement('div', { className: 'imqbm-batch' },
    createElement('span', null, formatTime(batch.at)),
    createElement('span', null, `会话 ${batch.sessionKey}`),
    createElement('span', null, `${batch.count} 条 / ${batch.chars} 字符`),
    createElement('span', null, batch.mode === 'steer' ? '并入当前轮' : '空闲提交'),
    batch.ok
      ? createElement('span', null, '✅ 成功')
      : createElement('span', { className: 'imqbm-batch-error' }, `⚠️ 失败：${batch.error ?? '未知原因'}`),
  );
}

// ── 面板主体 ──

export function MergePanel(): ReactNode {
  useMergePanelStyles();
  const [phase, setPhase] = useState<Phase>('loading');
  const [status, setStatus] = useState<QqbotMergeStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const adopt = useCallback((next: QqbotMergeStatus): void => {
    setStatus(next);
    setDraft(toDraft(next.config));
    setPhase('ready');
    setLoadError(null);
  }, []);

  const load = useCallback((): void => {
    setPhase('loading');
    setLoadError(null);
    void fetch(MERGE_CONFIG_PATH, { cache: 'no-store' })
      .then(async (res) => {
        // 404：未绑定 / 旧版本 / webServer 未就绪 —— 优雅降级，不抛错
        if (res.status === 404) {
          setPhase('unavailable');
          return;
        }
        const body = (await res.json().catch(() => ({}))) as Partial<MergeStatusResponse> & { error?: string };
        if (!res.ok || body.ok !== true || body.status === undefined) {
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        adopt(body.status);
      })
      .catch((err: unknown) => {
        setPhase('error');
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }, [adopt]);

  useEffect(() => { load(); }, [load]);

  const update = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((current) => (current === null ? current : { ...current, [key]: value }));
    setNote(null);
  }, []);

  const save = useCallback((event: FormEvent): void => {
    event.preventDefault();
    if (busy || draft === null || status === null) return;
    const built = buildPatch(draft, status.config);
    if (built.error !== undefined) {
      setNote({ ok: false, message: built.error });
      return;
    }
    // 草稿与生效值只有格式差异（如多写了空格/前导零）时无需请求宿主
    if (Object.keys(built.patch).length === 0) {
      setNote({ ok: true, message: '没有需要保存的变更' });
      return;
    }

    setBusy(true);
    void fetch(MERGE_CONFIG_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: built.patch }),
    })
      .then(async (res) => {
        if (res.status === 404) {
          setPhase('unavailable');
          return;
        }
        const body = (await res.json().catch(() => ({}))) as Partial<MergeStatusResponse> & { error?: string };
        if (!res.ok || body.ok !== true || body.status === undefined) {
          setNote({ ok: false, message: body.error ?? `保存失败（HTTP ${res.status}）` });
          return;
        }
        adopt(body.status);
        setNote({
          ok: true,
          message: `已保存并生效（revision ${body.status.applied.revision}）。写入 profile 会触发插件重载，重载后 revision 归零属正常。`,
        });
      })
      .catch((err: unknown) => {
        setNote({ ok: false, message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { setBusy(false); });
  }, [adopt, busy, draft, status]);

  // ── 相位渲染 ──

  if (phase === 'loading') {
    return createElement('p', { className: 'imqbm-hint', style: PAD_STYLE }, '正在加载合并设置…');
  }

  if (phase === 'unavailable') {
    return createElement('div', { className: 'imqbm-notice' },
      createElement('p', { className: 'imqbm-notice-title' }, '尚未就绪'),
      createElement('p', { className: 'imqbm-hint' },
        '当前插件尚未完成 QQ 绑定，或运行的是不支持端内合并设置的版本（路由未注册）。完成扫码绑定后重新打开设置页即可配置。'),
      createElement('div', { className: 'imqbm-row' },
        createElement('button', { type: 'button', className: 'imqbm-btn', onClick: load }, '重试'),
      ),
    );
  }

  if (phase === 'error' || status === null || draft === null) {
    return createElement('div', { className: 'imqbm-notice' },
      createElement('p', { className: 'imqbm-notice-title' }, '合并设置加载失败'),
      createElement('p', { className: 'imqbm-hint' }, loadError ?? '未知错误'),
      createElement('div', { className: 'imqbm-row' },
        createElement('button', { type: 'button', className: 'imqbm-btn', onClick: load }, '重试'),
      ),
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(status.config));
  const runtime = status.runtime;

  return createElement('form', { className: 'imqbm-form', onSubmit: save },
    createElement('div', { className: 'imqbm-group-title' }, '合并开关'),
    createElement(SwitchRow, {
      label: '启用连续消息智能合并', checked: draft.enabled,
      help: '关闭时行为与官方 QQ 插件一致；开启后窗口内的连续消息会并入同一轮处理',
      onChange: (next) => { update('enabled', next); },
    }),

    createElement('div', { className: 'imqbm-group-title' }, '合并窗口与上限'),
    createElement(NumberRow, {
      label: '静默窗口（毫秒）', value: draft.windowMs, min: LIMITS.windowMs.min, max: LIMITS.windowMs.max,
      help: `100–${LIMITS.windowMs.max} 毫秒，默认 800；静默超过该时长视为一批结束`,
      onChange: (next) => { update('windowMs', next); },
    }),
    createElement(NumberRow, {
      label: '单批条数上限', value: draft.maxBatchMessages,
      min: LIMITS.maxBatchMessages.min, max: LIMITS.maxBatchMessages.max,
      help: `1–${LIMITS.maxBatchMessages.max} 条，默认 8；超出部分会提示并排队为下一批`,
      onChange: (next) => { update('maxBatchMessages', next); },
    }),
    createElement(NumberRow, {
      label: '单批字符上限', value: draft.maxBatchChars,
      min: LIMITS.maxBatchChars.min, max: LIMITS.maxBatchChars.max,
      help: `200–${LIMITS.maxBatchChars.max} 字符，默认 4000`,
      onChange: (next) => { update('maxBatchChars', next); },
    }),

    createElement('div', { className: 'imqbm-group-title' }, '分场景开关'),
    createElement(SwitchRow, {
      label: '私聊合并', checked: draft.scopeC2c,
      help: '一对一聊天中启用合并',
      onChange: (next) => { update('scopeC2c', next); },
    }),
    createElement(SwitchRow, {
      label: '群聊合并', checked: draft.scopeGroup,
      help: '群聊按发送者分组，仅同一发送者的连续消息会合并',
      onChange: (next) => { update('scopeGroup', next); },
    }),

    createElement('div', { className: 'imqbm-group-title' }, '运行中与回复'),
    createElement(SegmentedRow, {
      label: '运行中策略', value: draft.busyPolicy, options: BUSY_OPTIONS,
      help: '并入当前轮：agent.steer() 非打断式续航，不取消正在进行的模型调用或工具；排队下一轮：官方 0.5.3 旧行为',
      onChange: (next) => { update('busyPolicy', next as QqbotMergeConfig['busyPolicy']); },
    }),
    createElement(SegmentedRow, {
      label: '回复模式', value: draft.replyMode, options: REPLY_OPTIONS,
      help: '同一条修订：一轮多 step 的输出持续改写同一条 QQ 消息；逐条发送：每个 step 各发一条（旧行为）',
      onChange: (next) => { update('replyMode', next as QqbotMergeConfig['replyMode']); },
    }),

    createElement('div', { className: 'imqbm-footer' },
      note !== null
        ? createElement('p', { className: `imqbm-note${note.ok ? ' imqbm-note--ok' : ' imqbm-note--error'}` },
            (note.ok ? '' : '⚠️ ') + note.message)
        : dirty
          ? createElement('p', { className: 'imqbm-note' }, '保存后立即生效并写入本插件配置；宿主会因此重载插件，进行中的机器人会话将重置')
          : createElement('p', { className: 'imqbm-note' }),
      createElement('button', { type: 'button', className: 'imqbm-btn', onClick: load, disabled: busy }, '刷新'),
      createElement('button', { type: 'submit', className: 'imqbm-save', disabled: busy || !dirty },
        busy ? '正在保存…' : '保存'),
    ),

    createElement('div', { className: 'imqbm-group-title' }, '运行状态'),
    createElement('p', { className: 'imqbm-hint' },
      `契约 ${status.contract.name}@v${status.contract.version} · 生效 revision ${status.applied.revision}`
      + ` · ${formatTime(status.applied.appliedAt)}`
      + ` · 活跃批次 ${status.applied.activeBatches} · 待处理消息 ${status.applied.pendingMessages}`),
    createElement('div', { className: 'imqbm-meta', style: { marginTop: '8px' } },
      createElement(MetaRow, {
        label: 'steer 支持',
        value: createElement(Badge, {
          ok: runtime.steerSupported,
          text: runtime.steerSupported ? '可用' : '不可用（降级排队）',
        }),
      }),
      createElement(MetaRow, { label: 'steer 机制', value: runtime.steerMechanism }),
      createElement(MetaRow, { label: '集成方式', value: runtime.integration }),
      createElement(MetaRow, {
        label: '单条修订',
        value: runtime.streamingRevision ? '流式可用' : '流式不可用（降级为轮末单条发送）',
      }),
      createElement(MetaRow, { label: '说明', value: runtime.note }),
    ),

    createElement('div', { className: 'imqbm-group-title' }, '运行计数（本次进程）'),
    createElement('div', { className: 'imqbm-stats' },
      COUNTER_ITEMS.map((item) => createElement('div', { className: 'imqbm-stat', key: item.key },
        createElement('span', { className: 'imqbm-stat-label' }, item.label),
        createElement('span', { className: 'imqbm-stat-value' }, String(status.counters[item.key])),
      )),
    ),

    createElement('div', { className: 'imqbm-group-title' }, '最近一批'),
    createElement(LastBatchRow, { batch: status.lastBatch }),
  );
}
