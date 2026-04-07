// ---------------------------------------------------------------------------
// Pricing Engine — Dynamic pricing for inter-company services
// ---------------------------------------------------------------------------

import { publishEvent } from "../../events/eventPublisher.js";
import {
  getService,
  updateServiceLoad,
  type ServiceListing,
  type ServiceCategory,
} from "./serviceRegistry.js";
import pino from "pino";

const logger = pino({ name: "pricing-engine" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PricingFactors {
  baseCostCents: number;
  demandMultiplier: number; // > 1.0 = high demand
  supplyMultiplier: number; // < 1.0 = scarce supply
  performanceMultiplier: number; // high perf → premium price
  loadMultiplier: number; // high load → higher price
}

export interface PriceCalculation {
  serviceId: string;
  basePriceCents: number;
  adjustedPriceCents: number;
  factors: PricingFactors;
  calculatedAt: string;
}

export interface PricingHistory {
  serviceId: string;
  entries: PriceCalculation[];
}

export type PricingStrategy = "dynamic" | "fixed" | "auction" | "cost_plus";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEMAND_CEILING = 3.0; // max demand multiplier
const SUPPLY_FLOOR = 0.5; // min supply multiplier
const PERFORMANCE_BONUS_FACTOR = 0.3; // high perf → up to 30% premium
const LOAD_SURGE_FACTOR = 0.5; // high load → up to 50% surcharge
const MIN_PRICE_CENTS = 1; // minimum 1 cent per request
const MAX_PRICE_CENTS = 500; // max 500 cents ($5) per request

// ---------------------------------------------------------------------------
// In-memory pricing and demand data
// ---------------------------------------------------------------------------

const demandTracker = new Map<string, number>(); // serviceId → request count
const pricingHistoryStore = new Map<string, PriceCalculation[]>();

// ---------------------------------------------------------------------------
// Pricing calculations
// ---------------------------------------------------------------------------

/** Record demand for a service */
export function recordDemand(serviceId: string, count = 1): void {
  const current = demandTracker.get(serviceId) ?? 0;
  demandTracker.set(serviceId, current + count);
}

/** Get demand level for a service */
export function getDemandLevel(serviceId: string): number {
  return demandTracker.get(serviceId) ?? 0;
}

/** Calculate demand multiplier */
function calculateDemandMultiplier(serviceId: string): number {
  const demand = demandTracker.get(serviceId) ?? 0;
  // Every 10 requests increases multiplier by 0.1, capped at DEMAND_CEILING
  return Math.min(1 + demand * 0.01, DEMAND_CEILING);
}

/** Calculate supply multiplier (based on number of services in same category) */
function calculateSupplyMultiplier(service: ServiceListing, totalInCategory: number): number {
  if (totalInCategory <= 1) return SUPPLY_FLOOR; // scarce → expensive
  if (totalInCategory >= 5) return 1.2; // abundant → cheaper
  return 1.0; // moderate
}

/** Calculate performance multiplier */
function calculatePerformanceMultiplier(performanceScore: number): number {
  // High performance gets premium pricing: score 1.0 → 1.3x, score 0.5 → 1.0x
  return 1 + (performanceScore - 0.5) * PERFORMANCE_BONUS_FACTOR * 2;
}

/** Calculate load multiplier (surge pricing) */
function calculateLoadMultiplier(currentLoad: number): number {
  // High load → higher prices to manage demand
  return 1 + currentLoad * LOAD_SURGE_FACTOR;
}

/** Calculate dynamic price for a service */
export function calculatePrice(
  service: ServiceListing,
  totalInCategory: number,
): PriceCalculation {
  const baseCostCents = service.pricePerRequestCents;
  const demandMultiplier = calculateDemandMultiplier(service.id);
  const supplyMultiplier = calculateSupplyMultiplier(service, totalInCategory);
  const performanceMultiplier = calculatePerformanceMultiplier(service.performanceScore);
  const loadMultiplier = calculateLoadMultiplier(service.currentLoad);

  const factors: PricingFactors = {
    baseCostCents,
    demandMultiplier: Math.round(demandMultiplier * 100) / 100,
    supplyMultiplier: Math.round(supplyMultiplier * 100) / 100,
    performanceMultiplier: Math.round(performanceMultiplier * 100) / 100,
    loadMultiplier: Math.round(loadMultiplier * 100) / 100,
  };

  // Dynamic price = base × demand / supply × performance × load
  let adjustedPrice = baseCostCents * demandMultiplier / supplyMultiplier * performanceMultiplier * loadMultiplier;

  // Clamp to bounds
  adjustedPrice = Math.max(MIN_PRICE_CENTS, Math.min(MAX_PRICE_CENTS, Math.round(adjustedPrice)));

  const calculation: PriceCalculation = {
    serviceId: service.id,
    basePriceCents: baseCostCents,
    adjustedPriceCents: adjustedPrice,
    factors,
    calculatedAt: new Date().toISOString(),
  };

  // Store history
  const history = pricingHistoryStore.get(service.id) ?? [];
  history.push(calculation);
  pricingHistoryStore.set(service.id, history);

  return calculation;
}

/** Calculate dynamic price by service ID */
export function calculatePriceById(
  serviceId: string,
  totalInCategory: number,
): PriceCalculation | null {
  const service = getService(serviceId);
  if (!service) return null;
  return calculatePrice(service, totalInCategory);
}

/** Get pricing history for a service */
export function getPricingHistory(serviceId: string): PriceCalculation[] {
  return pricingHistoryStore.get(serviceId) ?? [];
}

/** Batch calculate prices for all active services in a category */
export function calculateCategoryPrices(
  services: ServiceListing[],
): PriceCalculation[] {
  return services.map((svc) => calculatePrice(svc, services.length));
}

/** Get average price for a category */
export function getCategoryAveragePrice(
  services: ServiceListing[],
): number {
  if (services.length === 0) return 0;

  const prices = calculateCategoryPrices(services);
  const total = prices.reduce((sum, p) => sum + p.adjustedPriceCents, 0);
  return Math.round(total / prices.length);
}

/** Reset demand tracker (for testing or periodic reset) */
export function resetDemand(): void {
  demandTracker.clear();
}

/** Clear all pricing data (for testing) */
export function clearPricingData(): void {
  demandTracker.clear();
  pricingHistoryStore.clear();
}
