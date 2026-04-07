// ---------------------------------------------------------------------------
// Marketplace — Matches service providers with consumers across companies
// ---------------------------------------------------------------------------

import type { Db } from "@paperclipai/db";
import { publishEvent } from "../../events/eventPublisher.js";
import {
  listActiveServices,
  findServicesByCategory,
  getService,
  type ServiceListing,
  type ServiceCategory,
} from "./serviceRegistry.js";
import { checkRateLimit } from "../governance/systemRateLimiter.js";
import { getAutonomyLimits } from "../governance/autonomyLimits.js";
import pino from "pino";

const logger = pino({ name: "marketplace" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceRequest {
  id: string;
  requestingCompanyId: string;
  requiredCategory: ServiceCategory;
  requiredCapabilities: string[];
  maxPriceCents: number;
  minPerformanceScore: number;
  description: string;
  createdAt: string;
}

export interface MatchResult {
  requestId: string;
  matches: ServiceMatch[];
  bestMatch: ServiceMatch | null;
  matchedAt: string;
}

export interface ServiceMatch {
  service: ServiceListing;
  relevanceScore: number; // 0.0 – 1.0
  priceScore: number; // 0.0 – 1.0
  performanceScore: number; // 0.0 – 1.0
  loadScore: number; // 0.0 – 1.0
  overallScore: number; // weighted composite
  capabilityOverlap: string[];
}

export interface MarketplaceStats {
  totalRequests: number;
  totalMatchesFound: number;
  averageMatchScore: number;
  topCategories: { category: string; requests: number }[];
}

// Match weights
const WEIGHT_RELEVANCE = 0.35;
const WEIGHT_PRICE = 0.25;
const WEIGHT_PERFORMANCE = 0.25;
const WEIGHT_LOAD = 0.15;

// ---------------------------------------------------------------------------
// In-memory request store
// ---------------------------------------------------------------------------

const requestStore = new Map<string, ServiceRequest>();
const matchHistory: MatchResult[] = [];
let nextRequestId = 1;

// ---------------------------------------------------------------------------
// Marketplace operations
// ---------------------------------------------------------------------------

/** Create a service request from a consumer company */
export function createServiceRequest(
  requestingCompanyId: string,
  category: ServiceCategory,
  opts?: {
    requiredCapabilities?: string[];
    maxPriceCents?: number;
    minPerformanceScore?: number;
    description?: string;
  },
): ServiceRequest | { error: string } {
  // Rate limit service requests to prevent unbounded marketplace activity
  const rl = checkRateLimit("service_request", requestingCompanyId);
  if (!rl.allowed) {
    logger.warn({ requestingCompanyId, category }, `Service request rate-limited: ${rl.reason}`);
    return { error: rl.reason ?? "Service request rate limit exceeded" };
  }

  // Enforce max transaction value
  const limits = getAutonomyLimits();
  const maxPrice = opts?.maxPriceCents ?? 100;
  if (maxPrice > limits.maxTransactionValueCents) {
    logger.warn({ requestingCompanyId, maxPrice, limit: limits.maxTransactionValueCents }, "Service request exceeds max transaction value");
    return { error: `Max price ($${(maxPrice / 100).toFixed(2)}) exceeds transaction limit ($${(limits.maxTransactionValueCents / 100).toFixed(2)})` };
  }

  const request: ServiceRequest = {
    id: `req_${nextRequestId++}`,
    requestingCompanyId,
    requiredCategory: category,
    requiredCapabilities: opts?.requiredCapabilities ?? [],
    maxPriceCents: maxPrice,
    minPerformanceScore: opts?.minPerformanceScore ?? 0.5,
    description: opts?.description ?? `Need ${category.replace(/_/g, " ")} service`,
    createdAt: new Date().toISOString(),
  };

  requestStore.set(request.id, request);
  return request;
}

/** Score how well a service matches a request */
function scoreMatch(service: ServiceListing, request: ServiceRequest): ServiceMatch | null {
  // Exclude self — can't buy from yourself
  if (service.companyId === request.requestingCompanyId) return null;

  // Category must match
  if (service.category !== request.requiredCategory) return null;

  // Filter by price cap
  if (service.pricePerRequestCents > request.maxPriceCents) return null;

  // Filter by minimum performance
  if (service.performanceScore < request.minPerformanceScore) return null;

  // Relevance: capability overlap
  const capOverlap = request.requiredCapabilities.length > 0
    ? request.requiredCapabilities.filter((c) => service.capabilities.includes(c))
    : service.capabilities;

  const relevanceScore = request.requiredCapabilities.length > 0
    ? capOverlap.length / request.requiredCapabilities.length
    : 1.0;

  // Price score: cheaper → better (inverted)
  const priceScore = request.maxPriceCents > 0
    ? 1 - (service.pricePerRequestCents / request.maxPriceCents)
    : 0.5;

  // Performance score: direct pass-through
  const performanceScore = service.performanceScore;

  // Load score: lower load → better
  const loadScore = 1 - service.currentLoad;

  const overallScore =
    WEIGHT_RELEVANCE * relevanceScore +
    WEIGHT_PRICE * priceScore +
    WEIGHT_PERFORMANCE * performanceScore +
    WEIGHT_LOAD * loadScore;

  return {
    service,
    relevanceScore: Math.round(relevanceScore * 100) / 100,
    priceScore: Math.round(priceScore * 100) / 100,
    performanceScore: Math.round(performanceScore * 100) / 100,
    loadScore: Math.round(loadScore * 100) / 100,
    overallScore: Math.round(overallScore * 100) / 100,
    capabilityOverlap: capOverlap,
  };
}

/** Find matching services for a request */
export async function findMatches(
  request: ServiceRequest,
): Promise<MatchResult> {
  const allServices = listActiveServices();
  const matches: ServiceMatch[] = [];

  for (const service of allServices) {
    const match = scoreMatch(service, request);
    if (match) {
      matches.push(match);
    }
  }

  // Sort by overall score descending
  matches.sort((a, b) => b.overallScore - a.overallScore);

  const result: MatchResult = {
    requestId: request.id,
    matches,
    bestMatch: matches[0] ?? null,
    matchedAt: new Date().toISOString(),
  };

  matchHistory.push(result);

  logger.info({ requestId: request.id, matchCount: matches.length }, "Marketplace match completed");

  await publishEvent("ai.economy.marketplace.matched", {
    requestId: request.id,
    requestingCompanyId: request.requestingCompanyId,
    category: request.requiredCategory,
    matchCount: matches.length,
    bestMatchServiceId: result.bestMatch?.service.id ?? null,
    bestMatchScore: result.bestMatch?.overallScore ?? 0,
  });

  return result;
}

/** Full marketplace flow: request → match → return best */
export async function findBestProvider(
  requestingCompanyId: string,
  category: ServiceCategory,
  opts?: {
    requiredCapabilities?: string[];
    maxPriceCents?: number;
    minPerformanceScore?: number;
  },
): Promise<{ request: ServiceRequest; match: MatchResult }> {
  const requestOrError = createServiceRequest(requestingCompanyId, category, opts);
  if ("error" in requestOrError) {
    throw new Error(requestOrError.error);
  }
  const match = await findMatches(requestOrError);
  return { request: requestOrError, match };
}

/** Get marketplace statistics */
export function getMarketplaceStats(): MarketplaceStats {
  const categoryCount: Record<string, number> = {};
  let totalMatches = 0;
  let scoreSum = 0;

  for (const result of matchHistory) {
    const req = requestStore.get(result.requestId);
    if (req) {
      categoryCount[req.requiredCategory] = (categoryCount[req.requiredCategory] ?? 0) + 1;
    }
    totalMatches += result.matches.length;
    if (result.bestMatch) {
      scoreSum += result.bestMatch.overallScore;
    }
  }

  const topCategories = Object.entries(categoryCount)
    .map(([category, requests]) => ({ category, requests }))
    .sort((a, b) => b.requests - a.requests);

  return {
    totalRequests: matchHistory.length,
    totalMatchesFound: totalMatches,
    averageMatchScore: matchHistory.length > 0
      ? Math.round((scoreSum / matchHistory.length) * 100) / 100
      : 0,
    topCategories,
  };
}

/** List pending requests */
export function listRequests(): ServiceRequest[] {
  return Array.from(requestStore.values());
}

/** Get match history */
export function getMatchHistory(): MatchResult[] {
  return [...matchHistory];
}

/** Clear marketplace data (for testing) */
export function clearMarketplace(): void {
  requestStore.clear();
  matchHistory.length = 0;
  nextRequestId = 1;
}
