/// <reference path="./types/express.d.ts" />
process.setMaxListeners(25);
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq } from "@paperclipai/db";
import {
  createDb,
  ensurePostgresDatabase,
  inspectMigrations,
  applyPendingMigrations,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./middleware/logger.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import { heartbeatService, issueService } from "./services/index.js";
import { getRedisUrl, isRedisReachable } from "./redis/index.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { performPlaywrightRealActionForIssue } from "./services/real-action.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

const config = loadConfig();
const isWorkerOnly = process.env.WORKER_ONLY === "true";

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== "string") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

const aiEnabled = parseBooleanEnv(process.env.AI_ENABLED, true);
const autoExecutionEnabled = parseBooleanEnv(process.env.AUTO_EXECUTION, true);
const revenuePriorityModeEnabled = parseBooleanEnv(process.env.REVENUE_PRIORITY_MODE, false);
if (process.env.PAPERCLIP_SECRETS_PROVIDER === undefined) {
  process.env.PAPERCLIP_SECRETS_PROVIDER = config.secretsProvider;
}
if (process.env.PAPERCLIP_SECRETS_STRICT_MODE === undefined) {
  process.env.PAPERCLIP_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
}
if (process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE === undefined) {
  process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
}

type MigrationSummary =
  | "skipped"
  | "already applied"
  | "applied (empty database)"
  | "applied (pending migrations)"
  | "pending migrations skipped";

function formatPendingMigrationSummary(migrations: string[]): string {
  if (migrations.length === 0) return "none";
  return migrations.length > 3
    ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
    : migrations.join(", ");
}

async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
  if (process.env.PAPERCLIP_MIGRATION_PROMPT === "never") return false;
  if (process.env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true") return true;
  if (!stdin.isTTY || !stdout.isTTY) return true;

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await prompt.question(
      `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
    )).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

type EnsureMigrationsOptions = {
  autoApply?: boolean;
};

async function ensureMigrations(
  connectionString: string,
  label: string,
  opts?: EnsureMigrationsOptions,
): Promise<MigrationSummary> {
  const autoApply = opts?.autoApply === true;
  let state = await inspectMigrations(connectionString);
  if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
    const repair = await reconcilePendingMigrationHistory(connectionString);
    if (repair.repairedMigrations.length > 0) {
      logger.warn(
        { repairedMigrations: repair.repairedMigrations },
        `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
      );
      state = await inspectMigrations(connectionString);
      if (state.status === "upToDate") return "already applied";
    }
  }
  if (state.status === "upToDate") return "already applied";
  if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
    logger.warn(
      { tableCount: state.tableCount },
      `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
    );
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      logger.warn(
        { pendingMigrations: state.pendingMigrations },
        `${label} has pending migrations; continuing without applying. Run pnpm db:migrate to apply before startup.`,
      );
      return "pending migrations skipped";
    }

    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }

  const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
  if (!apply) {
    logger.warn(
      { pendingMigrations: state.pendingMigrations },
      `${label} has pending migrations; continuing without applying. Run pnpm db:migrate to apply before startup.`,
    );
    return "pending migrations skipped";
  }

  logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
  await applyPendingMigrations(connectionString);
  return "applied (pending migrations)";
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

const LOCAL_BOARD_USER_ID = "local-board";
const LOCAL_BOARD_USER_EMAIL = "local@paperclip.local";
const LOCAL_BOARD_USER_NAME = "Board";

async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
  const now = new Date();
  const existingUser = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
    .then((rows: Array<{ id: string }>) => rows[0] ?? null);

  if (!existingUser) {
    await db.insert(authUsers).values({
      id: LOCAL_BOARD_USER_ID,
      name: LOCAL_BOARD_USER_NAME,
      email: LOCAL_BOARD_USER_EMAIL,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const role = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  if (!role) {
    await db.insert(instanceUserRoles).values({
      userId: LOCAL_BOARD_USER_ID,
      role: "instance_admin",
    });
  }

  const companyRows = await db.select({ id: companies.id }).from(companies);
  for (const company of companyRows) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, company.id),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
        ),
      )
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (membership) continue;
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: LOCAL_BOARD_USER_ID,
      status: "active",
      membershipRole: "owner",
    });
  }
}

let db;
let embeddedPostgres: EmbeddedPostgresInstance | null = null;
let embeddedPostgresStartedByThisProcess = false;
let migrationSummary: MigrationSummary = "skipped";
const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
let activeDatabaseConnectionString: string;
let startupDbInfo:
  | { mode: "external-postgres"; connectionString: string }
  | { mode: "embedded-postgres"; dataDir: string; port: number };
if (config.databaseUrl) {
  migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL");

  db = createDb(config.databaseUrl);
  logger.info("Using external PostgreSQL via DATABASE_URL/config");
  activeDatabaseConnectionString = config.databaseUrl;
  startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
} else {
  const moduleName = "embedded-postgres";
  let EmbeddedPostgres: EmbeddedPostgresCtor;
  try {
    const mod = await import(moduleName);
    EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
    );
  }

  const dataDir = resolve(config.embeddedPostgresDataDir);
  const configuredPort = config.embeddedPostgresPort;
  let port = configuredPort;
  const embeddedPostgresLogBuffer: string[] = [];
  const EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT = 120;
  const verboseEmbeddedPostgresLogs = process.env.PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE === "true";
  const appendEmbeddedPostgresLog = (message: unknown) => {
    const text = typeof message === "string" ? message : message instanceof Error ? message.message : String(message ?? "");
    for (const lineRaw of text.split(/\r?\n/)) {
      const line = lineRaw.trim();
      if (!line) continue;
      embeddedPostgresLogBuffer.push(line);
      if (embeddedPostgresLogBuffer.length > EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT) {
        embeddedPostgresLogBuffer.splice(0, embeddedPostgresLogBuffer.length - EMBEDDED_POSTGRES_LOG_BUFFER_LIMIT);
      }
      if (verboseEmbeddedPostgresLogs) {
        logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
      }
    }
  };
  const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
    if (embeddedPostgresLogBuffer.length > 0) {
      logger.error(
        {
          phase,
          recentLogs: embeddedPostgresLogBuffer,
          err,
        },
        "Embedded PostgreSQL failed; showing buffered startup logs",
      );
    }
  };

  if (config.databaseMode === "postgres") {
    logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
  }

  const clusterVersionFile = resolve(dataDir, "PG_VERSION");
  const clusterAlreadyInitialized = existsSync(clusterVersionFile);
  const postmasterPidFile = resolve(dataDir, "postmaster.pid");
  const isPidRunning = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const getRunningPid = (): number | null => {
    if (!existsSync(postmasterPidFile)) return null;
    try {
      const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
      const pid = Number(pidLine);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      if (!isPidRunning(pid)) return null;
      return pid;
    } catch {
      return null;
    }
  };

  const runningPid = getRunningPid();
  if (runningPid) {
    logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
  } else {
    const detectedPort = await detectPort(configuredPort);
    if (detectedPort !== configuredPort) {
      logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
    }
    port = detectedPort;
    logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
    embeddedPostgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "paperclip",
      password: "paperclip",
      port,
      persistent: true,
      onLog: appendEmbeddedPostgresLog,
      onError: appendEmbeddedPostgresLog,
    });

    if (!clusterAlreadyInitialized) {
      try {
        await embeddedPostgres.initialise();
      } catch (err) {
        logEmbeddedPostgresFailure("initialise", err);
        throw err;
      }
    } else {
      logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
    }

    if (existsSync(postmasterPidFile)) {
      logger.warn("Removing stale embedded PostgreSQL lock file");
      rmSync(postmasterPidFile, { force: true });
    }
    try {
      await embeddedPostgres.start();
    } catch (err) {
      logEmbeddedPostgresFailure("start", err);
      throw err;
    }
    embeddedPostgresStartedByThisProcess = true;
  }

  const embeddedAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
  const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "paperclip");
  if (dbStatus === "created") {
    logger.info("Created embedded PostgreSQL database: paperclip");
  }

  const embeddedConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
  if (shouldAutoApplyFirstRunMigrations) {
    logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
  }
  migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
    autoApply: shouldAutoApplyFirstRunMigrations,
  });

  db = createDb(embeddedConnectionString);
  logger.info("Embedded PostgreSQL ready");
  activeDatabaseConnectionString = embeddedConnectionString;
  startupDbInfo = { mode: "embedded-postgres", dataDir, port };
}

if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
  throw new Error(
    `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
      "Use authenticated mode for non-loopback deployments.",
  );
}

if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
  throw new Error("local_trusted mode only supports private exposure");
}

if (config.deploymentMode === "authenticated") {
  if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
    throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
  }
  if (config.deploymentExposure === "public") {
    if (config.authBaseUrlMode !== "explicit") {
      throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
    }
    if (!config.authPublicBaseUrl) {
      throw new Error("authenticated public exposure requires auth.publicBaseUrl");
    }
  }
}

let authReady = config.deploymentMode === "local_trusted";
let betterAuthHandler: RequestHandler | undefined;
let resolveSession:
  | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
  | undefined;
let resolveSessionFromHeaders:
  | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
  | undefined;
if (config.deploymentMode === "local_trusted") {
  await ensureLocalTrustedBoardPrincipal(db as any);
}
if (config.deploymentMode === "authenticated") {
  const {
    createBetterAuthHandler,
    createBetterAuthInstance,
    resolveBetterAuthSession,
    resolveBetterAuthSessionFromHeaders,
  } = await import("./auth/better-auth.js");
  const betterAuthSecret =
    process.env.BETTER_AUTH_SECRET?.trim() ?? process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
  if (!betterAuthSecret) {
    throw new Error(
      "authenticated mode requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) to be set",
    );
  }
  const auth = createBetterAuthInstance(db as any, config);
  betterAuthHandler = createBetterAuthHandler(auth);
  resolveSession = (req) => resolveBetterAuthSession(auth, req);
  resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
  await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
  authReady = true;
}

let server: ReturnType<typeof createServer> | null = null;
let listenPort = config.port;

if (!isWorkerOnly) {
  const storageService = createStorageServiceFromConfig(config);
  const app = await createApp(db as any, {
    uiMode,
    storageService,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    betterAuthHandler,
    resolveSession,
  });
  server = createServer(app as any);
  listenPort = await detectPort(config.port);

  if (listenPort !== config.port) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${config.port}, selectedPort=${listenPort})`);
  }

  const runtimeListenHost = config.host;
  const runtimeApiHost =
    runtimeListenHost === "0.0.0.0" || runtimeListenHost === "::"
      ? "localhost"
      : runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_HOST = runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_PORT = String(listenPort);
  process.env.PAPERCLIP_API_URL = `http://${runtimeApiHost}:${listenPort}`;

  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });

  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any);

    // Reap orphaned runs at startup (no threshold -- runningProcesses is empty)
    void heartbeat.reapOrphanedRuns().catch((err) => {
      logger.error({ err }, "startup reap of orphaned heartbeat runs failed");
    });

    setInterval(() => {
      void heartbeat
        .tickTimers(new Date())
        .then((result) => {
          if (result.enqueued > 0) {
            logger.info({ ...result }, "heartbeat timer tick enqueued runs");
          }
        })
        .catch((err) => {
          logger.error({ err }, "heartbeat timer tick failed");
        });

      // Periodically reap orphaned runs (5-min staleness threshold)
      void heartbeat
        .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
        .catch((err) => {
          logger.error({ err }, "periodic reap of orphaned heartbeat runs failed");
        });
    }, config.heartbeatSchedulerIntervalMs);
  }

  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
    let backupInFlight = false;

    const runScheduledBackup = async () => {
      if (backupInFlight) {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return;
      }

      backupInFlight = true;
      try {
        const result = await runDatabaseBackup({
          connectionString: activeDatabaseConnectionString,
          backupDir: config.databaseBackupDir,
          retentionDays: config.databaseBackupRetentionDays,
          filenamePrefix: "paperclip",
        });
        logger.info(
          {
            backupFile: result.backupFile,
            sizeBytes: result.sizeBytes,
            prunedCount: result.prunedCount,
            backupDir: config.databaseBackupDir,
            retentionDays: config.databaseBackupRetentionDays,
          },
          `Automatic database backup complete: ${formatDatabaseBackupResult(result)}`,
        );
      } catch (err) {
        logger.error({ err, backupDir: config.databaseBackupDir }, "Automatic database backup failed");
      } finally {
        backupInFlight = false;
      }
    };

    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionDays: config.databaseBackupRetentionDays,
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );
    setInterval(() => {
      void runScheduledBackup();
    }, backupIntervalMs);
  }

  // --- AI Company Execution Loop ---
  // Start the autonomous AI company loop on a periodic timer.
  if (aiEnabled) {
    const { startCompanyLoop } = await import("./ai/orchestration/companyLoop.js");
    const AI_LOOP_INTERVAL_MS = 30_000; // 30 seconds
    const stopLoop = startCompanyLoop(db as any, AI_LOOP_INTERVAL_MS);
    process.once("SIGINT", stopLoop);
    process.once("SIGTERM", stopLoop);
    logger.info({ intervalMs: AI_LOOP_INTERVAL_MS }, "AI company execution loop started");
  } else {
    logger.warn("AI loop startup skipped because AI_ENABLED=false");
  }

  // --- Issue Execution Loop Scheduler ---
  // Periodically assign and dispatch backlog/todo issues without manual triggers.
  if (autoExecutionEnabled && config.executionLoopSchedulerEnabled) {
    const { executionLoop } = await import("./core/executionLoop.js");
    const loop = executionLoop(db as any);
    let cycleInFlight = false;

    const runScheduledExecutionLoop = async () => {
      if (cycleInFlight) {
        logger.warn("Skipping execution loop scheduler tick because previous cycle is still running");
        return;
      }

      cycleInFlight = true;
      try {
        const results = await loop.runAll();
        const dispatched = results.reduce((sum, result) => sum + result.tasksDispatched, 0);
        if (dispatched > 0) {
          logger.info(
            {
              companiesProcessed: results.length,
              tasksDispatched: dispatched,
            },
            "Execution loop scheduler tick dispatched work",
          );
        }
      } catch (err) {
        logger.error({ err }, "Execution loop scheduler tick failed");
      } finally {
        cycleInFlight = false;
      }
    };

    setInterval(() => {
      void runScheduledExecutionLoop();
    }, config.executionLoopSchedulerIntervalMs);

    logger.info(
      { intervalMs: config.executionLoopSchedulerIntervalMs },
      "Execution loop scheduler started",
    );
  } else if (!autoExecutionEnabled) {
    logger.warn("Execution loop scheduler skipped because AUTO_EXECUTION=false");
  }

  // --- Traffic Generation Loop ---
  if (aiEnabled) {
    const { startTrafficLoop } = await import("./core/trafficLoop.js");
    const stopTrafficLoop = startTrafficLoop(db as any, 3 * 60 * 60_000);
    process.once("SIGINT", stopTrafficLoop);
    process.once("SIGTERM", stopTrafficLoop);
  }

  if (aiEnabled) {
    // --- Reddit Reply Agent ---
    {
      const { startRedditReplyAgent } = await import("./ai/distribution/redditReplyAgent.js");
      const stopReplyAgent = startRedditReplyAgent(db as any, 15 * 60_000);
      process.once("SIGINT", stopReplyAgent);
      process.once("SIGTERM", stopReplyAgent);
    }

    // --- Email Sequence Scheduler ---
    {
      const { startEmailSequenceScheduler } = await import("./ai/distribution/emailSequence.js");
      const stopEmailSeq = startEmailSequenceScheduler(db as any, 60 * 60_000);
      process.once("SIGINT", stopEmailSeq);
      process.once("SIGTERM", stopEmailSeq);
    }

    if (!revenuePriorityModeEnabled) {
      // --- Strategy Brain (Persistent Thinking Layer) — 2h cycles for faster iteration ---
      {
        const { startStrategyBrain } = await import("./ai/brain/strategyBrain.js");
        const stopBrain = startStrategyBrain(db as any, 2 * 60 * 60_000);
        process.once("SIGINT", stopBrain);
        process.once("SIGTERM", stopBrain);
      }
    } else {
      logger.warn("Strategy brain skipped because REVENUE_PRIORITY_MODE=true");
    }

    // --- Conversion Controller (promote winners, kill losers, generate challengers) ---
    {
      const { startConversionController } = await import("./ai/conversion/conversionController.js");
      const stopConversion = startConversionController(db as any, 2 * 60 * 60_000);
      process.once("SIGINT", stopConversion);
      process.once("SIGTERM", stopConversion);
    }

    if (!revenuePriorityModeEnabled) {
      // --- SEO Content Engine ---
      {
        const { startSEOContentEngine } = await import("./ai/distribution/seoContentEngine.js");
        const stopSEO = startSEOContentEngine(db as any, 12 * 60 * 60_000);
        process.once("SIGINT", stopSEO);
        process.once("SIGTERM", stopSEO);
      }
    } else {
      logger.warn("SEO content engine skipped because REVENUE_PRIORITY_MODE=true");
    }

    if (!revenuePriorityModeEnabled) {
      // --- Agent Coordinator (CEO/CMO/CRO/CFO) — 2h cycles for faster iteration ---
      {
        const { startAgentCoordinator } = await import("./ai/agents/agentCoordinator.js");
        const stopCoordinator = startAgentCoordinator(db as any, 2 * 60 * 60_000);
        process.once("SIGINT", stopCoordinator);
        process.once("SIGTERM", stopCoordinator);
      }
    } else {
      logger.warn("Agent coordinator skipped because REVENUE_PRIORITY_MODE=true");
    }

    if (!revenuePriorityModeEnabled) {
      // --- Continuous Thinking Loop (15-min micro-decisions) ---
      {
        const { startContinuousThinking } = await import("./ai/brain/continuousThinking.js");
        const stopThinking = startContinuousThinking(db as any, 15 * 60_000);
        process.once("SIGINT", stopThinking);
        process.once("SIGTERM", stopThinking);
      }
    } else {
      logger.warn("Continuous thinking loop skipped because REVENUE_PRIORITY_MODE=true");
    }
  }
}

// --- Evolution: Distributed Worker & Queue System ---
// Initialize BullMQ worker when Redis is configured.
// In WORKER_ONLY mode, start the worker and skip the HTTP server entirely.
const redisReachable = await isRedisReachable();

if (aiEnabled && isWorkerOnly && redisReachable) {
  try {
    const { createAgentWorker } = await import("./workers/agentWorker.js");
    const hbSvc = heartbeatService(db as any);
    const issuesSvc = issueService(db as any);

    createAgentWorker({
      invokeHeartbeat: async (params) => {
        const result = await hbSvc.invoke(
          params.agentId,
          "automation",
          {
            ...(params.context ?? {}),
            ...(params.issueId ? { issueId: params.issueId, taskId: params.issueId } : {}),
          },
          "system",
        );
        return { runId: result?.id ?? "unknown" };
      },
      markIssueCompleted: async ({ issueId, agentId }) => {
        const existing = await issuesSvc.getById(issueId);
        if (!existing) return;
        if (existing.assigneeAgentId && existing.assigneeAgentId !== agentId) return;
        await issuesSvc.update(issueId, {
          status: "done",
          assigneeAgentId: agentId,
          assigneeUserId: null,
        });
      },
      markIssueFailed: async ({ issueId, agentId }) => {
        const existing = await issuesSvc.getById(issueId);
        if (!existing) return;
        if (existing.assigneeAgentId && existing.assigneeAgentId !== agentId) return;
        await issuesSvc.update(issueId, {
          status: "blocked",
          assigneeAgentId: agentId,
          assigneeUserId: null,
        });
      },
      executeRealAction: async ({ issueId, agentId, companyId, runId }) =>
        performPlaywrightRealActionForIssue(db as any, {
          issueId,
          agentId,
          companyId,
          runId,
        }),
    });

    logger.info({ redisUrl: getRedisUrl() }, "Distributed agent worker started (BullMQ + Redis)");
  } catch (err) {
    logger.warn({ err }, "Distributed worker system not available (Redis may not be configured)");
  }
} else if (isWorkerOnly && !aiEnabled) {
  logger.warn("Distributed worker system disabled because AI_ENABLED=false");
} else if (isWorkerOnly) {
  logger.warn(
    { redisUrl: getRedisUrl() },
    "Distributed worker system disabled because Redis is not reachable",
  );
}

if (aiEnabled && redisReachable) {
  try {
    const { createDecisionWorker } = await import("./workers/decisionWorker.js");
    const { runDecisionCycleForCompany } = await import("./services/decision-dispatch.js");

    createDecisionWorker({
      runDecisionCycle: async ({ companyId, source, windowMinutes, reason }) => {
        await runDecisionCycleForCompany(db as any, {
          companyId,
          source,
          windowMinutes,
          reason,
        });
      },
    });

    logger.info({ redisUrl: getRedisUrl() }, "Decision-cycle worker started (BullMQ + Redis)");
  } catch (err) {
    logger.warn({ err }, "Decision-cycle worker not available");
  }
} else if (!aiEnabled) {
  logger.warn("Decision-cycle worker skipped because AI_ENABLED=false");
}

// Load company templates at startup
try {
  const { loadTemplates } = await import("./templates/templateLoader.js");
  const templates = loadTemplates();
  logger.info({ templateCount: templates.length }, "Company templates loaded");
} catch (err) {
  logger.warn({ err }, "Failed to load company templates");
}

// In WORKER_ONLY mode, skip HTTP server startup — this process only runs workers.
if (isWorkerOnly) {
  logger.info("Running in WORKER_ONLY mode — HTTP server skipped, worker processing queue jobs");
  // Keep the process alive; the BullMQ worker keeps its own event loop running.
  // Graceful shutdown on SIGINT/SIGTERM
  const workerShutdown = (signal: string) => {
    logger.info({ signal }, "Worker shutting down");
    process.exit(0);
  };
  process.once("SIGINT", () => workerShutdown("SIGINT"));
  process.once("SIGTERM", () => workerShutdown("SIGTERM"));
} else {
  if (!server) {
    throw new Error("HTTP server initialization failed in non-worker mode");
  }

server.listen(listenPort, config.host, () => {
  logger.info(`Server listening on ${config.host}:${listenPort}`);
  if (process.env.PAPERCLIP_OPEN_ON_LISTEN === "true") {
    const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
    const url = `http://${openHost}:${listenPort}`;
    void import("open")
      .then((mod) => mod.default(url))
      .then(() => {
        logger.info(`Opened browser at ${url}`);
      })
      .catch((err) => {
        logger.warn({ err, url }, "Failed to open browser on startup");
      });
  }
  printStartupBanner({
    host: config.host,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authReady,
    requestedPort: config.port,
    listenPort,
    uiMode,
    db: startupDbInfo,
    migrationSummary,
    heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
    heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
    databaseBackupEnabled: config.databaseBackupEnabled,
    databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
    databaseBackupRetentionDays: config.databaseBackupRetentionDays,
    databaseBackupDir: config.databaseBackupDir,
  });

  const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
  if (boardClaimUrl) {
    const red = "\x1b[41m\x1b[30m";
    const yellow = "\x1b[33m";
    const reset = "\x1b[0m";
    console.log(
      [
        `${red}  BOARD CLAIM REQUIRED  ${reset}`,
        `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
        `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
        `${yellow}${boardClaimUrl}${reset}`,
        `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
      ].join("\n"),
    );
  }
});

if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
  const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
    logger.info({ signal }, "Stopping embedded PostgreSQL");
    try {
      await embeddedPostgres?.stop();
    } catch (err) {
      logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}
} // end of else (non-WORKER_ONLY mode)
