// ---------------------------------------------------------------------------
// Dependency Resolver — ensures correct step ordering across agents
// ---------------------------------------------------------------------------

import type { TaskGraph, TaskStep } from "../planning/taskGraph.js";
import pino from "pino";

const logger = pino({ name: "dependency-resolver" });

export interface DependencyIssue {
  stepId: string;
  type: "circular" | "missing_dep" | "self_dep";
  detail: string;
}

/**
 * Validate a task graph for dependency correctness.
 * Returns issues found (empty array = valid).
 */
export function validateDependencies(graph: TaskGraph): DependencyIssue[] {
  const issues: DependencyIssue[] = [];
  const stepIds = new Set(graph.steps.map((s) => s.id));

  for (const step of graph.steps) {
    // Check for self-dependency
    if (step.dependsOn.includes(step.id)) {
      issues.push({
        stepId: step.id,
        type: "self_dep",
        detail: `Step "${step.name}" depends on itself`,
      });
    }

    // Check for missing dependencies
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) {
        issues.push({
          stepId: step.id,
          type: "missing_dep",
          detail: `Step "${step.name}" depends on non-existent step "${dep}"`,
        });
      }
    }
  }

  // Check for circular dependencies
  const cycles = detectCycles(graph);
  for (const cycle of cycles) {
    issues.push({
      stepId: cycle[0],
      type: "circular",
      detail: `Circular dependency: ${cycle.join(" → ")}`,
    });
  }

  if (issues.length > 0) {
    logger.warn({ issueCount: issues.length }, "Dependency validation found issues");
  }

  return issues;
}

/**
 * Detect cycles in the dependency graph using DFS.
 */
function detectCycles(graph: TaskGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const parent = new Map<string, string>();

  // Build adjacency map: stepId → set of dependent step IDs
  const adj = new Map<string, string[]>();
  for (const step of graph.steps) {
    adj.set(step.id, step.dependsOn.slice());
  }

  function dfs(nodeId: string, path: string[]) {
    if (inStack.has(nodeId)) {
      // Found a cycle — extract it
      const cycleStart = path.indexOf(nodeId);
      if (cycleStart >= 0) {
        cycles.push([...path.slice(cycleStart), nodeId]);
      }
      return;
    }
    if (visited.has(nodeId)) return;

    visited.add(nodeId);
    inStack.add(nodeId);
    path.push(nodeId);

    for (const dep of adj.get(nodeId) ?? []) {
      dfs(dep, path);
    }

    path.pop();
    inStack.delete(nodeId);
  }

  for (const step of graph.steps) {
    if (!visited.has(step.id)) {
      dfs(step.id, []);
    }
  }

  return cycles;
}

/**
 * Compute the topological execution order of steps.
 * Returns null if the graph has cycles.
 */
export function topologicalSort(graph: TaskGraph): TaskStep[] | null {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const stepMap = new Map<string, TaskStep>();

  for (const step of graph.steps) {
    stepMap.set(step.id, step);
    inDegree.set(step.id, 0);
    adj.set(step.id, []);
  }

  // Build reverse adjacency: if A depends on B, then B → A
  for (const step of graph.steps) {
    for (const dep of step.dependsOn) {
      if (adj.has(dep)) {
        adj.get(dep)!.push(step.id);
        inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: TaskStep[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const step = stepMap.get(current);
    if (step) sorted.push(step);

    for (const neighbor of adj.get(current) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== graph.steps.length) {
    logger.warn("Topological sort failed — graph has cycles");
    return null;
  }

  return sorted;
}

/**
 * Get the maximum parallelism possible in the graph.
 * Returns the number of steps that can run concurrently at the widest point.
 */
export function getMaxParallelism(graph: TaskGraph): number {
  const sorted = topologicalSort(graph);
  if (!sorted) return 1;

  // Compute the "level" of each step (longest dependency chain)
  const level = new Map<string, number>();
  for (const step of sorted) {
    let maxDepLevel = -1;
    for (const dep of step.dependsOn) {
      maxDepLevel = Math.max(maxDepLevel, level.get(dep) ?? 0);
    }
    level.set(step.id, maxDepLevel + 1);
  }

  // Count steps per level
  const levelCounts = new Map<number, number>();
  for (const lvl of level.values()) {
    levelCounts.set(lvl, (levelCounts.get(lvl) ?? 0) + 1);
  }

  return Math.max(1, ...levelCounts.values());
}

/**
 * Get execution levels — groups of steps that can run in parallel.
 */
export function getExecutionLevels(graph: TaskGraph): TaskStep[][] {
  const sorted = topologicalSort(graph);
  if (!sorted) return [graph.steps];

  const level = new Map<string, number>();
  for (const step of sorted) {
    let maxDepLevel = -1;
    for (const dep of step.dependsOn) {
      maxDepLevel = Math.max(maxDepLevel, level.get(dep) ?? 0);
    }
    level.set(step.id, maxDepLevel + 1);
  }

  const levels = new Map<number, TaskStep[]>();
  for (const step of sorted) {
    const lvl = level.get(step.id) ?? 0;
    if (!levels.has(lvl)) levels.set(lvl, []);
    levels.get(lvl)!.push(step);
  }

  return Array.from(levels.entries())
    .sort(([a], [b]) => a - b)
    .map(([, steps]) => steps);
}
