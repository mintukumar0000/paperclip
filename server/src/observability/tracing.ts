import { logger } from "../middleware/logger.js";

export interface Span {
  traceId: string;
  spanId: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  status: "ok" | "error" | "unset";
  events: Array<{ name: string; time: number; attributes?: Record<string, unknown> }>;
}

let spanCounter = 0;

function generateId(): string {
  const ts = Date.now().toString(36);
  const seq = (spanCounter++).toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}${seq}${rand}`;
}

/**
 * Lightweight OpenTelemetry-compatible tracing.
 * Logs spans as structured JSON via Pino for Loki/Grafana ingestion.
 */
export function startSpan(name: string, attributes: Record<string, string | number | boolean> = {}): Span {
  return {
    traceId: generateId(),
    spanId: generateId(),
    name,
    startTime: performance.now(),
    attributes,
    status: "unset",
    events: [],
  };
}

export function addSpanEvent(span: Span, eventName: string, attributes?: Record<string, unknown>): void {
  span.events.push({ name: eventName, time: performance.now(), attributes });
}

export function endSpan(span: Span, status: "ok" | "error" = "ok"): void {
  span.endTime = performance.now();
  span.status = status;
  const durationMs = span.endTime - span.startTime;

  logger.info({
    trace: {
      traceId: span.traceId,
      spanId: span.spanId,
      name: span.name,
      durationMs: Math.round(durationMs * 100) / 100,
      status: span.status,
      attributes: span.attributes,
      events: span.events.length > 0 ? span.events : undefined,
    },
  }, `span:${span.name} ${durationMs.toFixed(1)}ms [${span.status}]`);
}

/**
 * Convenience: trace an async function.
 */
export async function traced<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = startSpan(name, attributes);
  try {
    const result = await fn(span);
    endSpan(span, "ok");
    return result;
  } catch (err) {
    addSpanEvent(span, "exception", {
      message: err instanceof Error ? err.message : String(err),
    });
    endSpan(span, "error");
    throw err;
  }
}
