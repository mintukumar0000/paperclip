// ---------------------------------------------------------------------------
// Task Graph — DAG-based step management for autonomous plans
// ---------------------------------------------------------------------------

export type StepStatus = "pending" | "ready" | "running" | "completed" | "failed" | "skipped";

export interface TaskStep {
  id: string;
  name: string;
  description: string;
  dependsOn: string[]; // IDs of prerequisite steps
  status: StepStatus;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  output?: string;
  error?: string;
  retries: number;
  maxRetries: number;
}

export interface TaskGraph {
  steps: TaskStep[];
  metadata: {
    goal: string;
    createdAt: string;
    version: number;
    replanCount?: number;
  };
}

/** Create a new empty task graph */
export function createTaskGraph(goal: string): TaskGraph {
  return {
    steps: [],
    metadata: {
      goal,
      createdAt: new Date().toISOString(),
      version: 1,
    },
  };
}

/** Add a step to the graph */
export function addStep(
  graph: TaskGraph,
  step: Omit<TaskStep, "status" | "retries">,
): TaskGraph {
  return {
    ...graph,
    steps: [
      ...graph.steps,
      { ...step, status: "pending", retries: 0 },
    ],
  };
}

/** Get the next steps that are ready to execute (all dependencies completed) */
export function getReadySteps(graph: TaskGraph): TaskStep[] {
  const completedIds = new Set(
    graph.steps.filter((s) => s.status === "completed").map((s) => s.id),
  );

  return graph.steps.filter(
    (step) =>
      step.status === "pending" &&
      step.dependsOn.every((dep) => completedIds.has(dep)),
  );
}

/** Mark a step as running */
export function markStepRunning(graph: TaskGraph, stepId: string): TaskGraph {
  return updateStepStatus(graph, stepId, "running");
}

/** Mark a step as completed with output */
export function markStepCompleted(graph: TaskGraph, stepId: string, output?: string): TaskGraph {
  return {
    ...graph,
    steps: graph.steps.map((s) =>
      s.id === stepId ? { ...s, status: "completed" as const, output } : s,
    ),
  };
}

/** Mark a step as failed with error */
export function markStepFailed(graph: TaskGraph, stepId: string, error: string): TaskGraph {
  return {
    ...graph,
    steps: graph.steps.map((s) =>
      s.id === stepId
        ? { ...s, status: "failed" as const, error, retries: s.retries + 1 }
        : s,
    ),
  };
}

/** Reset a failed step back to pending for retry */
export function resetStepForRetry(graph: TaskGraph, stepId: string): TaskGraph {
  const step = graph.steps.find((s) => s.id === stepId);
  if (!step || step.retries >= step.maxRetries) return graph;
  return updateStepStatus(graph, stepId, "pending");
}

/** Check if the entire graph is complete (all steps completed or skipped) */
export function isGraphComplete(graph: TaskGraph): boolean {
  return graph.steps.every((s) => s.status === "completed" || s.status === "skipped");
}

/** Check if the graph is stuck (no ready steps but not complete) */
export function isGraphStuck(graph: TaskGraph): boolean {
  if (isGraphComplete(graph)) return false;
  const ready = getReadySteps(graph);
  const running = graph.steps.filter((s) => s.status === "running");
  return ready.length === 0 && running.length === 0;
}

/** Get graph progress summary */
export function getGraphProgress(graph: TaskGraph): {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
} {
  const steps = graph.steps;
  return {
    total: steps.length,
    completed: steps.filter((s) => s.status === "completed").length,
    failed: steps.filter((s) => s.status === "failed").length,
    running: steps.filter((s) => s.status === "running").length,
    pending: steps.filter((s) => s.status === "pending" || s.status === "ready").length,
  };
}

/** Replace the steps in a graph (used by replanner) */
export function replaceSteps(
  graph: TaskGraph,
  newSteps: Omit<TaskStep, "status" | "retries">[],
  keepCompleted = true,
): TaskGraph {
  const completed = keepCompleted
    ? graph.steps.filter((s) => s.status === "completed")
    : [];
  const completedIds = new Set(completed.map((s) => s.id));
  const fresh = newSteps
    .filter((s) => !completedIds.has(s.id))
    .map((s) => ({ ...s, status: "pending" as const, retries: 0 }));

  return {
    ...graph,
    steps: [...completed, ...fresh],
    metadata: { ...graph.metadata, version: graph.metadata.version + 1 },
  };
}

function updateStepStatus(graph: TaskGraph, stepId: string, status: StepStatus): TaskGraph {
  return {
    ...graph,
    steps: graph.steps.map((s) => (s.id === stepId ? { ...s, status } : s)),
  };
}
