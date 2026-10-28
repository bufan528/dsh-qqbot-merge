/**
 * 共享的媒体文件发送 — 按扩展名分发到 SDK 的四类发送器
 *
 * 单一事实源：qqbot_send_file 工具与交付物投递（present 声明的文件）共用
 * 同一套扩展名分类与路径白名单，行为不会漂移。
 */
import { stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import type { ReplyTarget } from '../types.ts';
import type { SendFileConfig } from '../config.ts';
import { MEDIA_ROOT } from './media-cleaner.ts';

/** 发送器最小接口（QQBot 实例满足） */
export interface MediaSendResult {
  upload: { file_uuid: string };
  message?: { id?: string };
}

export interface MediaSenderLike {
  sendImage(target: ReplyTarget, source: { localPath?: string }): Promise<MediaSendResult>;
  sendVideo(target: ReplyTarget, source: { localPath?: string }): Promise<MediaSendResult>;
  sendVoice(target: ReplyTarget, source: { localPath?: string }): Promise<MediaSendResult>;
  sendFile(target: ReplyTarget, source: { localPath?: string }, opts?: { fileName?: string }): Promise<MediaSendResult>;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const VOICE_EXTS = new Set(['.mp3', '.wav', '.ogg', '.aac', '.silk', '.amr']);

/** 判断 filePath 是否位于 root 目录内（含 root 本身） */
export function isWithinRoot(filePath: string, root: string): boolean {
  const rel = relative(resolve(root), filePath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 路径白名单校验：restrictPaths 关闭时放行任意路径，否则限定 media + cwd + extraRoots */
export function isPathAllowed(filePath: string, config: SendFileConfig, cwd: string): boolean {
  if (!config.restrictPaths) return true;
  const roots = [MEDIA_ROOT, cwd, ...config.extraRoots];
  return roots.some((root) => isWithinRoot(filePath, root));
}

/** sendMediaFile 的结果：成功附带元数据；缺失不抛错；失败携带原因供日志与错误信息透出 */
export type SendMediaResult =
  | { outcome: 'sent'; size: number; fileUuid?: string; messageId?: string }
  | { outcome: 'missing' }
  | { outcome: 'failed'; error: string };

/**
 * 按扩展名分类发送一个本地文件
 *
 * 文件不存在、不是普通文件时返回 missing（不抛错，调用方决定降级文案）；
 * 平台发送失败返回 failed。文件名透传给通用文件通道。
 */
export async function sendMediaFile(
  bot: MediaSenderLike,
  target: ReplyTarget,
  filePath: string,
  opts: { fileName?: string } = {},
): Promise<SendMediaResult> {
  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { outcome: 'missing' };
    size = info.size;
  } catch {
    return { outcome: 'missing' };
  }

  const fileName = opts.fileName ?? basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const source = { localPath: filePath };

  try {
    const result = ext === '.gif' || IMAGE_EXTS.has(ext)
      ? await bot.sendImage(target, source)
      : VIDEO_EXTS.has(ext)
        ? await bot.sendVideo(target, source)
        : VOICE_EXTS.has(ext)
          ? await bot.sendVoice(target, source)
          : await bot.sendFile(target, source, { fileName });
    return {
      outcome: 'sent',
      size,
      ...(result.upload.file_uuid !== undefined ? { fileUuid: result.upload.file_uuid } : {}),
      ...(result.message?.id !== undefined ? { messageId: result.message.id } : {}),
    };
  } catch (err) {
    return { outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
