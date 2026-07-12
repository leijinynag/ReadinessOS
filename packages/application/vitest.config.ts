import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const localEnvPath = resolve(import.meta.dirname, '../../.env.local');

if (existsSync(localEnvPath)) {
  // CI 显式注入数据库连接；本地运行时沿用被 Git 忽略的开发环境配置。
  process.loadEnvFile(localEnvPath);
}

export default defineConfig({
  test: {
    include: ['./test/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
