import { LiveWorkspaceClient } from './live-workspace-client';
import type { LiveWorkspaceProps } from './live-types';

export type { LiveParticipant } from './live-types';

/**
 * 保留服务端页面作为授权后的首屏入口；具体的 SSE、事件补拉和命令队列
 * 都由客户端工作台处理，避免服务端组件承担浏览器运行时状态。
 */
export function LiveWorkspace(props: LiveWorkspaceProps) {
  return <LiveWorkspaceClient {...props} />;
}
