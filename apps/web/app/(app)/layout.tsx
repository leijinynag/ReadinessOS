import type { ReactNode } from 'react';
import Link from 'next/link';
import { LogOut, ShieldCheck } from 'lucide-react';
import { redirect } from 'next/navigation';
import { signOut } from '@/auth';
import { getAuthSession } from '@/lib/auth-session';

export default async function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await getAuthSession();

  if (!session) {
    redirect('/login');
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-content">
          <Link className="brand" href="/scenarios">
            <span className="brand-mark">
              <ShieldCheck size={17} aria-hidden="true" />
            </span>
            ReadinessOS
          </Link>
          <div className="topbar-actions">
            <span className="user-label">{session.email}</span>
            <form
              action={async () => {
                'use server';
                await signOut({ redirectTo: '/login' });
              }}
            >
              <button className="button button-secondary" type="submit" title="退出">
                <LogOut size={16} aria-hidden="true" />
              </button>
            </form>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
