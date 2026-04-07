export interface WorkflowStep {
  id: string;
  agent: string; // agent role or ID
  description?: string;
  dependsOn?: string[];
  retryCount?: number;
  timeoutSec?: number;
}

export interface WorkflowDefinition {
  name: string;
  steps: WorkflowStep[];
}

export interface WorkflowStepResult {
  stepId: string;
  status: "completed" | "failed" | "skipped";
  result?: unknown;
  error?: string;
}
