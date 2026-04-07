import { Router } from "express";
import { register } from "../observability/metrics.js";

export function metricsRoutes() {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      res.set("Content-Type", register.contentType);
      const metrics = await register.metrics();
      res.end(metrics);
    } catch (err) {
      res.status(500).end("Error collecting metrics");
    }
  });

  return router;
}
