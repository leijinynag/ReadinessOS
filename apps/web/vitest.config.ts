import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const localEnvPath = resolve(import.meta.dirname, '../../.env.local');

if (existsSync(localEnvPath)) {
  // CI 通过环境变量注入连接串；本地测试复用 Git 忽略的开发数据库配置。
  process.loadEnvFile(localEnvPath);
}

export default defineConfig({
  oxc: {
    // Next 为生产编译保留 JSX；Vitest 的 Vite 运行时必须将测试组件转换为可执行代码。
    jsx: {
      runtime: 'automatic',
    },
  },
  resolve: {
    // Vite 不读取 Next 的路径别名约定，测试时需显式保持与应用代码一致。
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['./**/*.test.{ts,tsx}'],
    // Eve 开发运行时会保存源码快照；这些快照不属于当前工作区测试输入。
    exclude: ['**/node_modules/**', '**/.eve/**'],
  },
});
