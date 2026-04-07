import client from "prom-client";

// Collect default Node.js metrics (CPU, memory, event loop, GC)
client.collectDefaultMetrics({ prefix: "paperclip_" });

// --- HTTP request metrics ---
export const httpRequestDuration = new client.Histogram({
  name: "paperclip_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

export const httpRequestsTotal = new client.Counter({
  name: "paperclip_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
});

// --- Agent execution metrics ---
export const agentJobDuration = new client.Histogram({
  name: "paperclip_agent_job_duration_seconds",
  help: "Duration of agent job execution in seconds",
  labelNames: ["agent_id", "status"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
});

export const agentJobsTotal = new client.Counter({
  name: "paperclip_agent_jobs_total",
  help: "Total number of agent jobs processed",
  labelNames: ["status"] as const,
});

export const agentJobsActive = new client.Gauge({
  name: "paperclip_agent_jobs_active",
  help: "Number of currently running agent jobs",
});

// --- Queue metrics ---
export const queueDepth = new client.Gauge({
  name: "paperclip_queue_depth",
  help: "Number of jobs waiting in queue",
  labelNames: ["queue"] as const,
});

export const queueLatency = new client.Histogram({
  name: "paperclip_queue_latency_seconds",
  help: "Time from job enqueue to job start in seconds",
  labelNames: ["queue"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
});

// --- Event bus metrics ---
export const eventsPublished = new client.Counter({
  name: "paperclip_events_published_total",
  help: "Total events published to event bus",
  labelNames: ["event_type"] as const,
});

// --- Memory system metrics ---
export const memoryOpsTotal = new client.Counter({
  name: "paperclip_memory_ops_total",
  help: "Total memory system operations",
  labelNames: ["operation"] as const,
});

// --- Workflow metrics ---
export const workflowRunsTotal = new client.Counter({
  name: "paperclip_workflow_runs_total",
  help: "Total workflow runs",
  labelNames: ["status"] as const,
});

// --- Company / issue gauges ---
export const companiesTotal = new client.Gauge({
  name: "paperclip_companies_total",
  help: "Total number of companies",
});

export const issuesTotal = new client.Gauge({
  name: "paperclip_issues_total",
  help: "Total number of issues",
  labelNames: ["status"] as const,
});

export const agentsTotal = new client.Gauge({
  name: "paperclip_agents_total",
  help: "Total number of agents",
  labelNames: ["status"] as const,
});

// --- Redis connection ---
export const redisConnected = new client.Gauge({
  name: "paperclip_redis_connected",
  help: "Whether Redis is connected (1=yes, 0=no)",
});

// --- DB connection ---
export const dbConnected = new client.Gauge({
  name: "paperclip_db_connected",
  help: "Whether database is connected (1=yes, 0=no)",
});

// Export the registry for the /metrics endpoint
export const register = client.register;
