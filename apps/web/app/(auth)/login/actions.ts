'use server';

import { AuthError } from 'next-auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { signIn } from '@/auth';
import { createGuestDemo } from '@/lib/guest-demo';

export async function loginAction(formData: FormData) {
  try {
    await signIn('credentials', {
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      redirectTo: '/scenarios',
    });
  } catch (error) {
    if (error instanceof AuthError) {
      redirect('/login?error=credentials');
    }

    throw error;
  }
}

export async function guestDemoAction() {
  const requestHeaders = await headers();
  const forwardedFor = requestHeaders.get('x-forwarded-for');
  const ip =
    process.env.VERCEL === '1'
      ? forwardedFor?.split(',')[0]?.trim()
      : requestHeaders.get('x-real-ip')?.trim();
  const demo = await createGuestDemo({
    ip,
    userAgent: requestHeaders.get('user-agent') ?? undefined,
  });

  // token 只在当前 Server Action 传给 NextAuth，不会写入 URL、数据库明文或日志。
  await signIn('guest', { token: demo.token, redirectTo: '/scenarios' });
}
