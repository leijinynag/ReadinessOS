import { eveChannel } from 'eve/channels/eve';
import { localDev, vercelOidc } from 'eve/channels/auth';

// 生产只接受 Vercel OIDC；本地开发仅开放 localhost，不提供匿名兜底。
export default eveChannel({ auth: [vercelOidc(), localDev()] });
