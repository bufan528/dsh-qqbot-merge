import { defineConfig } from 'vitest/config'

// 本包独立维护，不能继承宿主仓库（D:\dsh-memory-vault）的 vitest 配置：
// 宿主配置把 include 限定为 tests 目录下的测试文件，会让本包 src 下的
// 测试全部"No test files found"（实测）。这里显式声明自己的范围。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Windows 上测试会共享临时目录；串行执行更稳定
    fileParallelism: false,
    reporters: ['default'],
  },
})
