import { defaultBackend, defineSandbox } from 'eve/sandbox';

/**
 * Agent 的文件工具始终运行在隔离 Sandbox 中。生产和可用的本地容器/微虚拟机
 * 均拒绝所有网络出口；just-bash 仅用于开发回退，不能视为真实网络隔离。
 */
export default defineSandbox({
  backend: defaultBackend({
    vercel: { networkPolicy: 'deny-all' },
    docker: { networkPolicy: 'deny-all' },
    microsandbox: { networkPolicy: 'deny-all' },
  }),
});
