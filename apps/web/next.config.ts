import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@readinessos/database', '@readinessos/domain-events'],
};

export default nextConfig;
