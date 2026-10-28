/**
 * getProfileDir 推导策略测试
 *
 * 覆盖三种 profile 布局：
 * 1. Desktop pnpm workspace 嵌套布局（标志文件探测，旧启发式会返回错误目录）
 * 2. CLI 浅层 npm 布局（标志文件或 node_modules 启发式）
 * 3. 开发模式源码目录（无命中返回 null）
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { getProfileDir } from './utils.ts';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qqbot-profile-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('getProfileDir', () => {
  it('Desktop pnpm 嵌套布局：按 profile 标志文件命中 profile 根', () => {
    const root = tempDir();
    const profile = join(root, 'profiles', 'desktop');
    const plugin = join(
      profile, 'dependencies', 'node_modules', '.pnpm', 'dsh-qqbot@1.0.0',
      'node_modules', '@tencent-connect', 'dsh-qqbot',
    );
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');
    writeFileSync(join(profile, 'dependencies', 'pnpm-workspace.yaml'), 'packages:\n  - .\n');

    // 旧启发式会返回 .../dsh-qqbot@1.0.0（内层 node_modules 的父目录），标志文件策略返回 profile 根
    expect(getProfileDir(plugin)).toBe(profile);
  });

  it('CLI 浅层布局：cordis.patch.yml 命中 profile 根', () => {
    const root = tempDir();
    const profile = join(root, 'profiles', 'qqbot');
    const plugin = join(profile, 'node_modules', '@tencent-connect', 'dsh-qqbot');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(profile, 'cordis.patch.yml'), '# patch\n');

    expect(getProfileDir(plugin)).toBe(profile);
  });

  it('全新 profile（尚无标志文件）：回退 node_modules 启发式', () => {
    const root = tempDir();
    const profile = join(root, 'profiles', 'qqbot');
    const plugin = join(profile, 'node_modules', '@tencent-connect', 'dsh-qqbot');
    mkdirSync(plugin, { recursive: true });

    expect(getProfileDir(plugin)).toBe(profile);
  });

  it('pnpm-workspace.yaml 单独存在时也命中', () => {
    const root = tempDir();
    const profile = join(root, 'profile');
    const plugin = join(profile, 'deps', 'node_modules', 'dsh-qqbot');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n');

    expect(getProfileDir(plugin)).toBe(profile);
  });

  it('dev 源码 checkout（根目录自带 cordis.patch.yml 仓库文件）：返回 null', () => {
    const root = tempDir();
    const checkout = join(root, 'dsh-qqbot');
    const src = join(checkout, 'src');
    mkdirSync(src, { recursive: true });
    // checkout 根有 bundle patch 仓库文件，但它不是 profile——不得命中
    writeFileSync(join(checkout, 'cordis.patch.yml'), '# bundle patch\n');
    writeFileSync(join(checkout, 'pnpm-workspace.yaml'), 'packages:\n');

    expect(getProfileDir(src)).toBeNull();
  });

  it('npm 安装：插件包内自带 bundle patch 不得命中，profile 根才有效', () => {
    const root = tempDir();
    const profile = join(root, 'profiles', 'desktop');
    const plugin = join(profile, 'node_modules', '@tencent-connect', 'dsh-qqbot');
    mkdirSync(plugin, { recursive: true });
    // 插件包内自带 dsh.bundle.patch 分发物——它是插件自己的，不是 profile 标志
    writeFileSync(join(plugin, 'cordis.patch.yml'), '# bundle patch\n');
    writeFileSync(join(profile, 'cordis.patch.yml'), '# profile patch\n');

    expect(getProfileDir(plugin)).toBe(profile);
  });

  it('开发模式源码目录：无命中返回 null', () => {
    const root = tempDir();
    const source = join(root, 'workspace', 'dsh-qqbot', 'src');
    mkdirSync(source, { recursive: true });

    expect(getProfileDir(source)).toBeNull();
  });
});
