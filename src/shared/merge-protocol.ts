/**
 * 连续消息智能合并设置协议 —— 宿主路由与客户端面板的共享契约
 *
 * 类型与路径常量的唯一事实源：宿主（merge/routes.ts）与浏览器
 * （client/merge-panel.ts）各自 import，杜绝两端协议漂移。
 * 本模块必须保持纯类型 + 纯常量（零 node 依赖、零副作用）：
 * 客户端 tsdown 构建会将其内联进 bundle。
 *
 * 数据形状直接复用 merge/contract.ts 的 QqbotMergeStatus（契约
 * `qqbot-merge@v1`），因此 HTTP 响应与 cordis 服务的 getStatus() 完全一致。
 */
import type { QqbotMergeStatus } from '../merge/contract.ts';

/** 合并配置读写（设置页「连续消息智能合并」面板） */
export const MERGE_CONFIG_PATH = '/qqbot/im-qqbot/merge';

/** GET / POST 成功响应：status 即 runtime.getStatus() */
export interface MergeStatusResponse {
  ok: true;
  status: QqbotMergeStatus;
}

/** 失败响应（400 / 403 / 405 / 500） */
export interface MergeErrorResponse {
  ok: false;
  error: string;
}

/** 线上响应联合类型 */
export type MergeResponse = MergeStatusResponse | MergeErrorResponse;
