// ---------------------------------------------------------------------------
// System Rate Limiter — per-agent, per-company operational throttling
// ---------------------------------------------------------------------------
// This is NOT the HTTP rate limiter (that's in app.ts).
// This enforces temporal throttling on autonomous operations to prevent
// runaway expansion, over-generation of tasks, and resource exhaustion.
// ---------------------------------------------------------------------------

import pino from "pino";
import { eventBus } from "../../events/eventBus.js";
import { getAutonomyLimits } from "./autonomyLimits.js";
import type { EventName } from "../../events/eventTypes.js";

const logger = pino({ name: "system-rate-limiter" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RateLimitDomain =
  | "company_creation"
  | "agent_creation"
  | "task_execution"
  | "budget_spend"
  | "economic_transaction"
  | "ecosystem_expansion"
  | "deployment"
  | "service_request"
  | "opportunity_scanning";

export interface RateLimitConfig {
  /** Maximum events in the window */
  maxEvents: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Human-readable description */
  description: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  reason?: string;
}

interface RateLimitBucket {
  events: number[];  // timestamps of events
}

// ---------------------------------------------------------------------------
// Default rate limit configurations
// ---------------------------------------------------------------------------

function buildDefaultRateLimits(): Record<RateLimitDomain, RateLimitConfig> {
  const global = getAutonomyLimits();
  return {
    company_creation: {
      maxEvents: 1,
      windowMs: 7 * 24 * 60 * 60_000, // 1 per week
      description: "Max 1 new company per week",
    },
    agent_creation: {
      maxEvents: global.maxAgentCreationPerDay,
      windowMs: 24 * 60 * 60_000,
      description: `Max ${global.maxAgentCreationPerDay} new agents per day`,
    },
    task_execution: {
      maxEvents: 10,
      windowMs: 60 * 60_000, // 10 per hour per agent
      description: "Max 10 tasks per agent per hour",
    },
    budget_spend: {
      maxEvents: 50,
      windowMs: 60 * 60_000,
      description: "Max 50 budget operations per hour",
    },
    economic_transaction: {
      maxEvents: 20,
      windowMs: 60 * 60_000,
      description: "Max 20 economic transactions per hour",
    },
    ecosystem_expansion: {
      maxEvents: 5,
      windowMs: 24 * 60 * 60_000,
      description: "Max 5 ecosystem expansion operations per day",
    },
    deployment: {
      maxEvents: 2,
      windowMs: 24 * 60 * 60_000,
      description: "Max 2 deployments per day",
    },
    service_request: {
      maxEvents: global.maxServiceCallsPerDay,
      windowMs: 24 * 60 * 60_000,
      description: `Max ${global.maxServiceCallsPerDay} service requests per day`,
    },
    opportunity_scanning: {
      maxEvents: 3,
      windowMs: 24 * 60 * 60_000,
      description: "Max 3 opportunity scans per day",
    },
  };
}

let DEFAULT_RATE_LIMITS: Record<RateLimitDomain, RateLimitConfig> | null = null;

function getDefaultRateLimits(): Record<RateLimitDomain, RateLimitConfig> {
  if (!DEFAULT_RATE_LIMITS) {
    DEFAULT_RATE_LIMITS = buildDefaultRateLimits();
  }
  return DEFAULT_RATE_LIMITS;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Map of "domain:companyId[:agentId]" → bucket */
const buckets = new Map<string, RateLimitBucket>();

/** Custom overrides for rate limits */
const customLimits = new Map<RateLimitDomain, RateLimitConfig>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if an action is allowed under the rate limit.
 * If allowed, the event is recorded.
 */
export function checkRateLimit(
  domain: RateLimitDomain,
  companyId: string,
  agentId?: string,
): RateLimitResult {
  const config = customLimits.get(domain) ?? getDefaultRateLimits()[domain];
  if (!config) {
    return { allowed: true, remaining: Infinity, resetMs: 0 };
  }

  const key = agentId
    ? `${domain}:${companyId}:${agentId}`
    : `${domain}:${companyId}`;

  const bucket = getOrCreateBucket(key);
  const now = Date.now();

  // Purge expired events
  const cutoff = now - config.windowMs;
  bucket.events = bucket.events.filter((t) => t > cutoff);

  if (bucket.events.length >= config.maxEvents) {
    const oldestInWindow = bucket.events[0] ?? now;
    const resetMs = oldestInWindow + config.windowMs - now;

    logger.warn(
      { domain, companyId, agentId, count: bucket.events.length, max: config.maxEvents },
      `Rate limit exceeded: ${config.description}`,
    );

    eventBus.publish("governance.rate_limit.exceeded",
      { domain, companyId, agentId, count: bucket.events.length, max: config.maxEvents },
    );

    return {
      allowed: false,
      remaining: 0,
      resetMs: Math.max(0, resetMs),
      reason: `${config.description} — limit reached (${bucket.events.length}/${config.maxEvents}). Resets in ${Math.round(resetMs / 1000)}s`,
    };
  }

  // Record the event
  bucket.events.push(now);

  return {
    allowed: true,
    remaining: config.maxEvents - bucket.events.length,
    resetMs: bucket.events.length > 0
      ? (bucket.events[0]! + config.windowMs - now)
      : config.windowMs,
  };
}

/**
 * Query remaining capacity without consuming a slot.
 */
export function peekRateLimit(
  domain: RateLimitDomain,
  companyId: string,
  agentId?: string,
): { remaining: number; maxEvents: number; windowMs: number } {
  const config = customLimits.get(domain) ?? getDefaultRateLimits()[domain];
  if (!config) {
    return { remaining: Infinity, maxEvents: Infinity, windowMs: 0 };
  }

  const key = agentId
    ? `${domain}:${companyId}:${agentId}`
    : `${domain}:${companyId}`;

  const bucket = buckets.get(key);
  if (!bucket) {
    return { remaining: config.maxEvents, maxEvents: config.maxEvents, windowMs: config.windowMs };
  }

  const cutoff = Date.now() - config.windowMs;
  const activeEvents = bucket.events.filter((t) => t > cutoff).length;

  return {
    remaining: Math.max(0, config.maxEvents - activeEvents),
    maxEvents: config.maxEvents,
    windowMs: config.windowMs,
  };
}

/**
 * Override a default rate limit.
 */
export function setRateLimit(domain: RateLimitDomain, config: RateLimitConfig): void {
  customLimits.set(domain, config);
  logger.info({ domain, config }, "Rate limit updated");
}

/**
 * Get current configuration for a domain.
 */
export function getRateLimitConfig(domain: RateLimitDomain): RateLimitConfig {
  return customLimits.get(domain) ?? getDefaultRateLimits()[domain];
}

/**
 * Get all rate limit configurations.
 */
export function getAllRateLimits(): Record<RateLimitDomain, RateLimitConfig> {
  const result = { ...getDefaultRateLimits() };
  for (const [domain, config] of customLimits.entries()) {
    result[domain] = config;
  }
  return result;
}

/**
 * Get rate limit statistics.
 */
export function getRateLimitStats(): {
  domains: { domain: RateLimitDomain; activeBuckets: number; totalEvents: number; config: RateLimitConfig }[];
} {
  const domains: { domain: RateLimitDomain; activeBuckets: number; totalEvents: number; config: RateLimitConfig }[] = [];
  const now = Date.now();

  for (const domain of Object.keys(getDefaultRateLimits()) as RateLimitDomain[]) {
    const config = customLimits.get(domain) ?? getDefaultRateLimits()[domain];
    const cutoff = now - config.windowMs;
    let activeBuckets = 0;
    let totalEvents = 0;

    for (const [key, bucket] of buckets.entries()) {
      if (key.startsWith(`${domain}:`)) {
        const active = bucket.events.filter((t) => t > cutoff);
        if (active.length > 0) {
          activeBuckets++;
          totalEvents += active.length;
        }
      }
    }

    domains.push({ domain, activeBuckets, totalEvents, config });
  }

  return { domains };
}

/**
 * Clear all rate limit buckets (for testing).
 */
export function clearRateLimits(): void {
  buckets.clear();
  customLimits.clear();
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function getOrCreateBucket(key: string): RateLimitBucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { events: [] };
    buckets.set(key, bucket);
  }
  return bucket;
}
