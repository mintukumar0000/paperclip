// ---------------------------------------------------------------------------
// Venture Planner — creates execution plans for new company launches
// ---------------------------------------------------------------------------

import type { BusinessModel, Milestone } from "./businessDesigner.js";
import pino from "pino";

const logger = pino({ name: "venture-planner" });

export interface VenturePlan {
  companyName: string;
  businessModel: BusinessModel;
  phases: VenturePhase[];
  totalEstimatedDays: number;
  riskLevel: "low" | "medium" | "high";
  plannedAt: string;
}

export interface VenturePhase {
  phase: number;
  title: string;
  description: string;
  targetDays: number;
  tasks: VentureTask[];
  dependencies: number[]; // phase numbers this depends on
}

export interface VentureTask {
  title: string;
  assigneeRole: string;
  description: string;
  estimatedDays: number;
  priority: number;
}

/**
 * Generate granular tasks for each milestone phase.
 */
function generatePhaseTasks(
  milestone: Milestone,
  roles: string[],
): VentureTask[] {
  const tasks: VentureTask[] = [];

  switch (milestone.phase) {
    case 1: // Build MVP
      tasks.push(
        { title: "Define product requirements", assigneeRole: "pm", description: "Document core features and user stories", estimatedDays: 2, priority: 1 },
        { title: "Design system architecture", assigneeRole: "engineer", description: "Technical architecture and data models", estimatedDays: 3, priority: 2 },
        { title: "Implement core features", assigneeRole: "engineer", description: "Build the primary product functionality", estimatedDays: 7, priority: 3 },
        { title: "Internal testing", assigneeRole: "engineer", description: "Quality assurance and bug fixing", estimatedDays: 2, priority: 4 },
      );
      if (roles.includes("designer")) {
        tasks.push(
          { title: "Design UI/UX", assigneeRole: "designer", description: "User interface and experience design", estimatedDays: 4, priority: 2 },
        );
      }
      break;

    case 2: // Launch Landing Page
      tasks.push(
        { title: "Create landing page", assigneeRole: "engineer", description: "Public-facing website", estimatedDays: 3, priority: 1 },
        { title: "Write documentation", assigneeRole: "pm", description: "User guides and API documentation", estimatedDays: 3, priority: 2 },
        { title: "Set up analytics", assigneeRole: "engineer", description: "Usage tracking and monitoring", estimatedDays: 1, priority: 3 },
      );
      break;

    case 3: // First Customers
      tasks.push(
        { title: "Define go-to-market strategy", assigneeRole: "ceo", description: "Customer acquisition strategy", estimatedDays: 3, priority: 1 },
        { title: "Create onboarding flow", assigneeRole: "pm", description: "New user onboarding experience", estimatedDays: 5, priority: 2 },
        { title: "Launch outreach campaign", assigneeRole: roles.includes("cmo") ? "cmo" : "ceo", description: "Initial marketing outreach", estimatedDays: 7, priority: 2 },
      );
      break;

    case 4: // Scale Marketing
      tasks.push(
        { title: "Scale acquisition channels", assigneeRole: roles.includes("cmo") ? "cmo" : "ceo", description: "Expand marketing channels and campaigns", estimatedDays: 14, priority: 1 },
        { title: "Optimize product based on feedback", assigneeRole: "engineer", description: "Iterate based on customer feedback", estimatedDays: 10, priority: 2 },
        { title: "Build partnerships", assigneeRole: "ceo", description: "Strategic partnership development", estimatedDays: 14, priority: 3 },
      );
      break;

    default:
      tasks.push(
        { title: milestone.title, assigneeRole: "ceo", description: milestone.description, estimatedDays: milestone.targetDays, priority: 1 },
      );
  }

  return tasks;
}

/**
 * Assess risk level based on business model attributes.
 */
export function assessRisk(model: BusinessModel): "low" | "medium" | "high" {
  let riskScore = 0;

  // High budget = more risk
  if (model.initialBudgetCents >= 10000) riskScore += 2;
  else if (model.initialBudgetCents >= 5000) riskScore += 1;

  // Low confidence = more risk
  if (model.confidence < 0.6) riskScore += 2;
  else if (model.confidence < 0.75) riskScore += 1;

  // Many agents = more complexity
  if (model.initialAgentRoles.length > 6) riskScore += 1;

  // Enterprise revenue model = harder execution
  if (model.revenueModel === "enterprise") riskScore += 1;
  if (model.revenueModel === "marketplace") riskScore += 2;

  if (riskScore >= 4) return "high";
  if (riskScore >= 2) return "medium";
  return "low";
}

/**
 * Create a venture plan from a business model.
 */
export function planVenture(model: BusinessModel): VenturePlan {
  const roles = model.initialAgentRoles.map((a) => a.role);
  const riskLevel = assessRisk(model);

  const phases: VenturePhase[] = model.milestones.map((ms) => ({
    phase: ms.phase,
    title: ms.title,
    description: ms.description,
    targetDays: ms.targetDays,
    tasks: generatePhaseTasks(ms, roles),
    dependencies: ms.phase > 1 ? [ms.phase - 1] : [],
  }));

  const totalEstimatedDays = phases.reduce((sum, p) => sum + p.targetDays, 0);

  logger.info(
    { companyName: model.companyName, phases: phases.length, totalEstimatedDays, riskLevel },
    "Venture plan created",
  );

  return {
    companyName: model.companyName,
    businessModel: model,
    phases,
    totalEstimatedDays,
    riskLevel,
    plannedAt: new Date().toISOString(),
  };
}

/**
 * Plan ventures for multiple business models.
 */
export function planVentures(models: BusinessModel[]): VenturePlan[] {
  return models.map(planVenture);
}
