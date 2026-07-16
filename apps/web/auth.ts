import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { prisma } from '@readinessos/database';
import { z } from 'zod';
import { env } from './lib/env';

const credentialsSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
const guestCredentialsSchema = z.object({
  token: z.string().min(32).max(256),
});

export const { auth, handlers, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      name: 'Demo access',
      credentials: {
        email: {
          label: '邮箱',
          type: 'email',
          placeholder: 'demo@readinessos.local',
        },
        password: {
          label: '密码',
          type: 'password',
        },
      },
      async authorize(rawCredentials) {
        if (env.DEMO_LOGIN_ENABLED !== 'true') {
          return null;
        }

        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) {
          return null;
        }

        if (
          parsed.data.email !== env.AUTH_DEMO_EMAIL ||
          parsed.data.password !== env.AUTH_DEMO_PASSWORD
        ) {
          return null;
        }

        // 登录身份必须复用数据库中的用户 ID，后续才能按 Member 关系完成组织级授权。
        const user = await prisma.user.findUnique({
          where: {
            email: env.AUTH_DEMO_EMAIL,
          },
        });

        if (!user) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name ?? 'Demo Operator',
        };
      },
    }),
    Credentials({
      id: 'guest',
      name: 'Guest demo',
      credentials: {
        token: { label: 'Guest token', type: 'password' },
      },
      async authorize(rawCredentials) {
        if (env.GUEST_DEMO_ENABLED !== 'true') {
          return null;
        }
        const parsed = guestCredentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) {
          return null;
        }
        const { hashGuestToken } = await import('./lib/guest-demo');
        const user = await prisma.user.findFirst({
          where: {
            isGuest: true,
            guestTokenHash: hashGuestToken(parsed.data.token),
            guestExpiresAt: { gt: new Date() },
          },
          select: { id: true, email: true, name: true },
        });
        if (!user) {
          return null;
        }
        return {
          id: user.id,
          email: user.email,
          name: user.name ?? 'Guest Operator',
        };
      },
    }),
  ],
  pages: {
    signIn: '/login',
  },
  callbacks: {
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? '';
      }

      return session;
    },
  },
});
