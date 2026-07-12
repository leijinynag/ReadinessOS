import { ApplicationError } from '@readinessos/domain-events';
import { NextResponse } from 'next/server';
import { z } from 'zod';

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

  console.error('Unhandled API error', error);
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
