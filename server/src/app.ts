import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import rateLimit from "express-rate-limit";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { privateHostnameGuard, resolvePrivateHostnameAllowSet } from "./middleware/private-hostname-guard.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { goalRoutes } from "./routes/goals.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { llmRoutes } from "./routes/llms.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { templateRoutes } from "./routes/templates.js";
import { workflowRoutes } from "./routes/workflows.js";
import { memoryRoutes } from "./routes/memory.js";
import { strategyRoutes } from "./routes/strategy.js";
import { messageRoutes } from "./routes/messages.js";
import { executionLoopRoutes } from "./routes/execution-loop.js";
import { metricsRoutes } from "./routes/metrics.js";
import { aiRoutes } from "./routes/ai.js";
import { aiDashboardRoutes } from "./routes/ai-dashboard.js";
import { collaborationRoutes } from "./routes/collaboration.js";
import { learningRoutes } from "./routes/learning.js";
import { expansionRoutes } from "./routes/expansion.js";
import { ecosystemRoutes } from "./routes/ecosystem.js";
import { economyRoutes } from "./routes/economy.js";
import { billingRoutes } from "./routes/billing.js";
import { governanceRoutes } from "./routes/governance.js";
import { stabilityRoutes } from "./routes/stability.js";
import { simulationRoutes } from "./routes/simulation.js";
import { waitlistRoutes } from "./routes/waitlist.js";
import { systemDebugRoutes } from "./routes/system-debug.js";
import { httpRequestDuration, httpRequestsTotal } from "./observability/metrics.js";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";

type UiMode = "none" | "static" | "vite-dev";

const UUID_SEGMENT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISSUE_IDENTIFIER_RE = /^[A-Z][A-Z0-9_]*-\d+$/i;
const LONG_HEX_SEGMENT_RE = /^[0-9a-f]{24,}$/i;

function normalizeMetricsRoute(pathname: string): string {
  const cleanPath = pathname.split("?")[0] ?? "/";
  if (cleanPath === "/" || cleanPath.length === 0) return "/";

  const normalizedSegments = cleanPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (UUID_SEGMENT_RE.test(segment)) return ":id";
      if (/^\d+$/.test(segment)) return ":id";
      if (ISSUE_IDENTIFIER_RE.test(segment)) return ":id";
      if (LONG_HEX_SEGMENT_RE.test(segment)) return ":id";
      if (segment.length > 72) return ":token";
      return segment;
    });

  if (normalizedSegments.length === 0) return "/";
  return `/${normalizedSegments.join("/")}`;
}

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    storageService: StorageService;
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    betterAuthHandler?: express.RequestHandler;
    resolveSession?: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const app = express();

  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as ExpressRequest & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(httpLogger);

  // Rate limiters
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // limit auth endpoints to 50 requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: Number(process.env.API_RATE_LIMIT ?? 300), // requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });

  // Prometheus HTTP metrics
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      const route = normalizeMetricsRoute(req.path || "unknown");
      const labels = { method: req.method, route, status_code: String(res.statusCode) };
      httpRequestDuration.observe(labels, durationSec);
      httpRequestsTotal.inc(labels);
    });
    next();
  });
  const privateHostnameGateEnabled =
    opts.deploymentMode === "authenticated" && opts.deploymentExposure === "private";
  const privateHostnameAllowSet = resolvePrivateHostnameAllowSet({
    allowedHostnames: opts.allowedHostnames,
    bindHost: opts.bindHost,
  });
  app.use(
    privateHostnameGuard({
      enabled: privateHostnameGateEnabled,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  );
  app.use(
    actorMiddleware(db, {
      deploymentMode: opts.deploymentMode,
      resolveSession: opts.resolveSession,
    }),
  );
  app.get("/api/auth/get-session", (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json({
      session: {
        id: `paperclip:${req.actor.source}:${req.actor.userId}`,
        userId: req.actor.userId,
      },
      user: {
        id: req.actor.userId,
        email: null,
        name: req.actor.source === "local_implicit" ? "Local Board" : null,
      },
    });
  });
  if (opts.betterAuthHandler) {
    app.all("/api/auth/*authPath", authLimiter, opts.betterAuthHandler);
  }
  app.use(llmRoutes(db));

  // Mount API routes
  const api = Router();
  api.use("/metrics", metricsRoutes());
  api.use(apiLimiter);
  api.use(boardMutationGuard());
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
    }),
  );
  api.use(waitlistRoutes(db));
  api.use(systemDebugRoutes(db));
  api.use("/companies", companyRoutes(db));
  api.use(agentRoutes(db));
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(issueRoutes(db, opts.storageService));
  api.use(goalRoutes(db));
  api.use(approvalRoutes(db));
  api.use(secretRoutes(db));
  api.use(costRoutes(db));
  api.use(activityRoutes(db));
  api.use(dashboardRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(
    accessRoutes(db, {
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      bindHost: opts.bindHost,
      allowedHostnames: opts.allowedHostnames,
    }),
  );
  api.use(templateRoutes(db));
  api.use(workflowRoutes(db));
  api.use(memoryRoutes(db));
  api.use(strategyRoutes(db));
  api.use(messageRoutes(db));
  api.use(executionLoopRoutes(db));
  api.use(aiRoutes(db));
  api.use(aiDashboardRoutes(db));
  api.use(collaborationRoutes(db));
  api.use(learningRoutes(db));
  api.use(expansionRoutes(db));
  api.use(ecosystemRoutes(db));
  api.use(economyRoutes(db));
  api.use(billingRoutes(db));
  api.use(governanceRoutes(db));
  api.use(stabilityRoutes(db));
  api.use(simulationRoutes(db));
  app.use("/api", api);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      app.use(express.static(uiDist));
      app.get(/.*/, (_req, res) => {
        res.sendFile(path.join(uiDist, "index.html"));
      });
    } else {
      console.warn("[paperclip] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "spa",
      server: {
        middlewareMode: true,
        allowedHosts: privateHostnameGateEnabled ? Array.from(privateHostnameAllowSet) : undefined,
      },
    });

    app.use(vite.middlewares);
    app.get(/.*/, async (req, res, next) => {
      try {
        const templatePath = path.resolve(uiRoot, "index.html");
        const template = fs.readFileSync(templatePath, "utf-8");
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
  }

  app.use(errorHandler);

  return app;
}
