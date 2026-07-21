import { ApplicationError } from '@readinessos/domain-events';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logError } from './observability';

export function apiError(error: unknown): NextResponse {
  if (error instanceof ApplicationError) {
    const status =
      error.code === 'UNAUTHENTICATED'
        ? 401
        : error.code === 'FORBIDDEN'
          ? 403
          : error.code === 'NOT_FOUND'
            ? 404
            : error.code === 'RUN_VERSION_CONFLICT'
              ? 409
              : 400;
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status },
    );
  }

  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request payload is invalid.',
          details: { issues: error.issues },
        },
      },
      { status: 400 },
    );
  }

  logError('Unhandled API error', error);
  return NextResponse.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    },
    { status: 500 },
  );
}

export function parseExpectedRunVersion(request: Request): number {
  const value = request.headers.get('if-match');
  if (!value) {
    throw new ApplicationError('VALIDATION_ERROR', 'If-Match run version is required.');
  }

  const normalized = value.replaceAll('"', '').trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ApplicationError('VALIDATION_ERROR', 'If-Match must contain an integer run version.');
  }
  return Number(normalized);
}

export function requiredIdempotencyKey(request: Request): string {
  const value = request.headers.get('idempotency-key')?.trim();
  if (!value) {
    throw new ApplicationError('VALIDATION_ERROR', 'Idempotency-Key is required.');
  }
  if (value.length > 256) {
    throw new ApplicationError(
      'VALIDATION_ERROR',
      'Idempotency-Key must be at most 256 characters.',
    );
  }
  return value;
}

export function responseWithRunVersion<T>(body: T, version: number, status = 200): NextResponse<T> {
  return NextResponse.json(body, {
    status,
    headers: {
      ETag: `"${version}"`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Kernel 会把一部分业务拒绝作为可审计的结果返回，例如动作权限不足时仍会
 * 写入 `action.rejected`。HTTP 层必须把它转换为非 2xx 响应，否则客户端会
 * 把“已被 Kernel 拒绝”错误显示为“已接受”。
 */
export function responseForCommandResult<T extends {
  status: 'accepted' | 'rejected' | 'duplicate';
  rejection?: { code: string; message: string };
}>(
  body: { result: T },
  version: number,
): NextResponse {
  if (body.result.status !== 'rejected' || !body.result.rejection) {
    return responseWithRunVersion(body, version);
  }

  const { code, message } = body.result.rejection;
  const status = code === 'RUN_VERSION_CONFLICT' || code === 'APPROVAL_STALE' ? 409 : 400;
  return NextResponse.json(
    {
      error: { code, message },
      result: body.result,
    },
    {
      status,
      headers: {
        ETag: `"${version}"`,
        'Cache-Control': 'no-store',
      },
    },
  );
}
