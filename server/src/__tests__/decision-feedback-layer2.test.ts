import { describe, expect, it, beforeEach } from "vitest";
import {
  runBehaviorFeedback,
  clearFeedbackData,
  setFeedbackConfig,
} from "../ai/governance/economicFeedbackLoop.js";

describe("Layer 2 decision feedback rules", () => {
  beforeEach(() => {
    clearFeedbackData();
    setFeedbackConfig({
      minBehaviorSampleCount: 1,
      minTrafficThreshold: 25,
      minConversionRatePercent: 2,
      maxBounceRatePercent: 65,
      minTaskSuccessRate: 0.65,
      expansionRevenueThresholdCents: 5000,
    });
  });

  it("triggers landing-page and content actions on weak funnel signals", () => {
    const actions = runBehaviorFeedback("company_1", {
      traffic: 12,
      conversions: 0,
      revenueCents: 100,
      taskSuccessRate: 0.8,
      costPerActionCents: 10,
      conversionRatePercent: 0,
      bounceRatePercent: 40,
      sampleCount: 5,
    });

    expect(actions.some((a) => a.type === "improve_landing_page")).toBe(true);
    expect(actions.some((a) => a.type === "increase_content_output")).toBe(true);
  });

  it("triggers strategy update when task success is low", () => {
    const actions = runBehaviorFeedback("company_1", {
      traffic: 100,
      conversions: 10,
      revenueCents: 1000,
      taskSuccessRate: 0.3,
      costPerActionCents: 20,
      conversionRatePercent: 10,
      bounceRatePercent: 30,
      sampleCount: 5,
    });

    expect(actions.some((a) => a.type === "update_strategy")).toBe(true);
  });

  it("triggers expansion on strong performance", () => {
    const actions = runBehaviorFeedback("company_1", {
      traffic: 200,
      conversions: 20,
      revenueCents: 20000,
      taskSuccessRate: 0.95,
      costPerActionCents: 5,
      conversionRatePercent: 10,
      bounceRatePercent: 20,
      sampleCount: 10,
    });

    expect(actions.some((a) => a.type === "trigger_expansion")).toBe(true);
  });

  it("triggers landing-page action on high bounce rate", () => {
    const actions = runBehaviorFeedback("company_1", {
      traffic: 120,
      conversions: 8,
      revenueCents: 2000,
      taskSuccessRate: 0.9,
      costPerActionCents: 10,
      conversionRatePercent: 6.67,
      bounceRatePercent: 82,
      sampleCount: 5,
    });

    expect(actions.some((a) => a.type === "improve_landing_page")).toBe(true);
  });
});
