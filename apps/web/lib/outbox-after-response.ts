import { after } from 'next/server';
import { drainRuntimeOutbox } from '@/lib/run-runtime';

/**
 * Kernel 命令已经完成后才触发 Outbox。使用 Next 的 after 生命周期让 HTTP
 * 响应不依赖 Eve 网络调用；失败由 Outbox 退避重试与活动审计承接。
 */
export function drainOutboxAfterResponse(): void {
  const drain = async () => {
    try {
      await drainRuntimeOutbox();
    } catch (error) {
      // Outbox 的单条失败会写回重试状态；这里只记录极少数初始化级异常，
      // 不应再抛回已成功提交领域命令的请求。
      console.error('Failed to drain runtime Outbox after response.', error);
    }
  };

  try {
    after(drain);
  } catch {
    // Route Handler 单测会脱离 Next 请求上下文直接调用函数，此时 after 会抛错。
    // 降级为不 await 的后台 drain，生产请求仍走上面的 after 生命周期。
    void drain();
  }
}
