import { ShieldCheck } from 'lucide-react';
import { auth } from '@/auth';
import { env } from '@/lib/env';
import { guestDemoAction, loginAction } from './actions';

type LoginPageProps = {
  searchParams: Promise<{
    error?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await auth();
  if (session?.user) {
    return null;
  }

  const { error } = await searchParams;

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <p className="eyebrow">
          <ShieldCheck size={15} aria-hidden="true" /> ReadinessOS
        </p>
        <h1 id="login-title">进入演练工作区</h1>
        <p className="page-lede">
          使用本地演示身份体验 SaaS 事故与关键客户升级场景。生产登录方式将在部署阶段接入。
        </p>
        {error ? <p className="form-error">邮箱或密码不正确。</p> : null}
        <form action={loginAction}>
          <div className="field">
            <label htmlFor="email">邮箱</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              defaultValue={env.AUTH_DEMO_EMAIL}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">密码</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <button className="button button-primary" type="submit">
            进入工作区
          </button>
        </form>
        {env.GUEST_DEMO_ENABLED === 'true' ? (
          <form action={guestDemoAction}>
            <button className="button button-secondary" type="submit">
              创建受限访客演示
            </button>
          </form>
        ) : null}
      </section>
    </main>
  );
}
