import { resolve } from 'node:path';
import { withEve } from 'eve/next';
import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 本地开发既可能通过 localhost 打开，也可能被浏览器自动化以 127.0.0.1 访问。
  // Next 16 会保护 HMR 与客户端资源的跨源请求；未列入白名单时页面无法 hydration。
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  outputFileTracingRoot: resolve(process.cwd(), '../..'),
  transpilePackages: [
    '@readinessos/application',
    '@readinessos/database',
    '@readinessos/domain-events',
    '@readinessos/scenario-sdk',
    '@readinessos/simulation-kernel',
    '@readinessos/scenario-pack-saas-incident',
  ],
};

export default withEve(withWorkflow(nextConfig));
