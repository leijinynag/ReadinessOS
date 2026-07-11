import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const localEnvPath = resolve(import.meta.dirname, '../../.env.local');

if (existsSync(localEnvPath)) {
  // CI 已显式注入环境变量；本地测试才从被忽略的 .env.local 读取连接信息。
  process.loadEnvFile(localEnvPath);
}

export default defineConfig({
  test: {
    include: ['./test/**/*.test.ts'],
  },
});
