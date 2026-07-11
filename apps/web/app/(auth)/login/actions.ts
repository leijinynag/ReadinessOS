'use server';

import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '@/auth';

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
