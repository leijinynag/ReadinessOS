import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('readinessos-web');

const sensitiveKeyPattern =
  /(authorization|cookie|password|secret|token|api[-_]?key|credential|email|guest[-_]?token)/i;

type LogContext = Record<string, unknown>;

/**
 * 日志上下文仅保留可排障的结构化字段。请求体、Cookie、凭证和访客 token
 * 会在进入控制台或外部采集器前统一替换，避免错误路径成为数据泄漏通道。
 */
export function logError(message: string, error: unknown, context: LogContext = {}): void {
  const sanitizedContext = sanitizeForLog(context);
  console.error(
    JSON.stringify({
      level: 'error',
      message,
      ...(isRecord(sanitizedContext) ? sanitizedContext : {}),
      error: serializeError(error),
    }),
  );
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  operation: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }

    try {
      return await operation();
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}

export function sanitizeForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForLog);
  if (value instanceof Error) return serializeError(value);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      sensitiveKeyPattern.test(key) ? '[REDACTED]' : sanitizeForLog(nestedValue),
    ]),
  );
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { value: sanitizeForLog(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
