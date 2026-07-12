import { resolve } from 'node:path';
import type { NextConfig } from 'next';
import { withWorkflow } from 'workflow/next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
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

export default withWorkflow(nextConfig);
