import { registerOTel } from '@vercel/otel';

export function register() {
  // 仅注册基础请求 Trace；命令级 Span 将随 W3 的 Command Handler 一起补充。
  registerOTel({
    serviceName: 'readinessos-web',
  });
}
