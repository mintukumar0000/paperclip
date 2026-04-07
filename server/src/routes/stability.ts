// ---------------------------------------------------------------------------
// Stability Routes — Ecosystem Stability Controller API
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  assessStability,
  canExpand,
  canCompanyExpand,
  getStabilityHistory,
  getStabilityEvents,
  getStabilityThresholds,
  setStabilityThresholds,
  resetStabilityThresholds,
  getEcosystemLimitsFromDb,
} from "../ai/stability/ecosystemStabilityController.js";
import { assertCompanyAccess } from "./authz.js";

export function stabilityRoutes(db: Db) {
  const r = Router();

  // =========================================================================
  // Ecosystem Stability Assessment
  // =========================================================================

  /** Get current ecosystem stability assessment */
  r.get("/stability/assessment", async (_req, res, next) => {
    try {
      const result = await assessStability(db);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /** Check if the ecosystem can expand (quick check) */
  r.get("/stability/can-expand", async (_req, res, next) => {
    try {
      const result = await canExpand(db);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /** Check if a specific company can expand */
  r.get(
    "/companies/:companyId/stability/can-expand",
    async (req, res, next) => {
      try {
        const { companyId } = req.params;
        assertCompanyAccess(req, companyId);
        const result = await canCompanyExpand(db, companyId);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // Stability History & Events
  // =========================================================================

  /** Get stability metric history */
  r.get("/stability/history", async (req, res, next) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const result = await getStabilityHistory(db, limit);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /** Get stability events (freeze, throttle, warn, etc.) */
  r.get("/stability/events", async (req, res, next) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const result = await getStabilityEvents(db, limit);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /** Get ecosystem limits from DB */
  r.get("/stability/limits", async (_req, res, next) => {
    try {
      const limits = await getEcosystemLimitsFromDb(db);
      res.json(limits);
    } catch (err) {
      next(err);
    }
  });

  // =========================================================================
  // Stability Thresholds (in-memory config)
  // =========================================================================

  /** Get current stability thresholds */
  r.get("/stability/thresholds", (_req, res) => {
    res.json(getStabilityThresholds());
  });

  /** Update stability thresholds */
  r.patch("/stability/thresholds", (req, res) => {
    const overrides = req.body;
    if (!overrides || typeof overrides !== "object") {
      res.status(400).json({ error: "Provide threshold overrides as JSON object" });
      return;
    }
    setStabilityThresholds(overrides);
    res.json({ updated: true, thresholds: getStabilityThresholds() });
  });

  /** Reset stability thresholds to defaults */
  r.post("/stability/thresholds/reset", (_req, res) => {
    resetStabilityThresholds();
    res.json({ reset: true, thresholds: getStabilityThresholds() });
  });

  return r;
}
