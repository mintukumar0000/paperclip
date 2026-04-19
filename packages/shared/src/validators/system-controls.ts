import { z } from "zod";
import {
  AUTONOMY_LEVELS,
  CYCLE_MODES,
  DECISION_MODES,
  TRAFFIC_CHANNELS,
  TRAFFIC_MODES,
} from "../constants.js";

export const updateSystemControlsSchema = z.object({
  systemActive: z.boolean().optional(),
  loopIntervalSeconds: z.number().int().min(30).max(900).optional(),
  trafficEnabled: z.boolean().optional(),
  redditEnabled: z.boolean().optional(),
  twitterEnabled: z.boolean().optional(),
  indieHackersEnabled: z.boolean().optional(),
  hackerNewsEnabled: z.boolean().optional(),
  maxMultiplier: z.number().int().min(1).max(20).optional(),
  postFrequency: z.number().int().min(1).max(24).optional(),
  subredditTargets: z.array(z.string().min(1).max(64)).max(20).optional(),
  pricingVariant: z.string().min(1).max(64).optional(),
  paywallTriggerCount: z.number().int().min(1).max(50).optional(),
  freeLimit: z.number().int().min(1).max(50).optional(),
  priceCents: z.number().int().min(100).max(100_000).optional(),
  pricingVariants: z.array(z.string().min(1).max(64)).max(10).optional(),
  cycleMode: z.enum(CYCLE_MODES).optional(),
  autonomyLevel: z.enum(AUTONOMY_LEVELS).optional(),
  trafficChannels: z.array(z.enum(TRAFFIC_CHANNELS)).max(4).optional(),
  trafficMultiplier: z.number().int().min(1).max(20).optional(),
  trafficPostIntervalMs: z.number().int().min(5_000).max(3_600_000).optional(),
  trafficMaxPostsPerCycle: z.number().int().min(1).max(40).optional(),
  trafficSubredditWhitelist: z.array(z.string().min(1).max(64)).max(20).optional(),
  trafficMode: z.enum(TRAFFIC_MODES).optional(),
  decisionMode: z.enum(DECISION_MODES).optional(),
});

export type UpdateSystemControls = z.infer<typeof updateSystemControlsSchema>;

export const resolveSystemDecisionSchema = z.object({
  note: z.string().max(500).optional().nullable(),
});

export type ResolveSystemDecision = z.infer<typeof resolveSystemDecisionSchema>;

export const runCompanyCycleSchema = z.object({
  companyId: z.string().min(1).max(128),
  cycleType: z.enum(CYCLE_MODES),
  reason: z.string().max(500).optional().nullable(),
});

export type RunCompanyCycle = z.infer<typeof runCompanyCycleSchema>;

export const runCompanyCycleByIntentSchema = z.object({
  companyId: z.string().min(1).max(128),
  intent: z.string().min(3).max(500),
  reason: z.string().max(500).optional().nullable(),
});

export type RunCompanyCycleByIntent = z.infer<typeof runCompanyCycleByIntentSchema>;
