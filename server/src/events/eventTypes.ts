/** All typed event names in the system */
export type EventName =
  // Issue lifecycle
  | "issue.created"
  | "issue.updated"
  | "issue.closed"
  | "issue.reopened"
  | "issue.completed"
  | "issue.assigned"
  | "issue.cancelled"
  | "issue.released"
  | "issue.removed"
  // Agent lifecycle
  | "agent.created"
  | "agent.updated"
  | "agent.failed"
  | "agent.paused"
  | "agent.dispatched"
  | "agent.run.completed"
  | "agent.run.started"
  // Goal lifecycle
  | "goal.created"
  | "goal.updated"
  | "goal.completed"
  // Project lifecycle
  | "project.created"
  | "project.updated"
  // Workflow events
  | "workflow.started"
  | "workflow.step.completed"
  | "workflow.step.failed"
  | "workflow.completed"
  | "workflow.failed"
  // Strategy events
  | "strategy.planned"
  | "strategy.tasks.generated"
  // Company events
  | "company.created"
  | "company.template.deployed"
  // Approval events
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  // Message events
  | "message.sent"
  // Execution loop events
  | "loop.cycle.started"
  | "loop.cycle.completed"
  // AI reasoning events
  | "llm.prompt.sent"
  | "llm.response.received"
  | "tool.executed"
  | "ai.execution.started"
  | "ai.execution.completed"
  // AI autonomous planning events
  | "ai.goal.created"
  | "ai.goal.completed"
  | "ai.goal.failed"
  | "ai.goal.cancelled"
  | "ai.step.started"
  | "ai.step.completed"
  | "ai.step.failed"
  // Company loop events
  | "company.loop.tick"
  | "company.loop.completed"
  // Engine registry events
  | "engine.resolved"
  | "engine.unavailable"
  // Multi-agent collaboration events
  | "collaboration.plan.created"
  | "collaboration.task.delegated"
  | "collaboration.task.routed"
  | "collaboration.agent.budget.warning"
  | "collaboration.agent.budget.exceeded"
  // Self-improving AI layer events (Phase 22)
  | "ai.learning.evaluation.created"
  | "ai.learning.reflection.completed"
  | "ai.learning.improvements.planned"
  | "ai.learning.improvement.applied"
  | "ai.learning.improvement.rolledback"
  | "ai.learning.prompt.optimized"
  | "ai.learning.workflow.optimized"
  | "ai.learning.strategy.optimized"
  // Autonomous expansion events (Phase 23)
  | "ai.expansion.department.created"
  | "ai.expansion.request.created"
  | "ai.expansion.request.approved"
  | "ai.expansion.request.rejected"
  | "ai.expansion.request.completed"
  | "ai.agent.created"
  // Autonomous Business Creation & Multi-Company Ecosystem events (Phase 24)
  | "ai.ecosystem.opportunity.scanned"
  | "ai.ecosystem.business.designed"
  | "ai.ecosystem.venture.planned"
  | "ai.ecosystem.company.created"
  | "ai.ecosystem.company.bootstrapped"
  | "ai.ecosystem.company.request.created"
  | "ai.ecosystem.company.request.approved"
  | "ai.ecosystem.company.request.rejected"
  | "ai.ecosystem.company.request.completed"
  // AI Economic System events (Phase 25)
  | "ai.economy.service.registered"
  | "ai.economy.marketplace.matched"
  | "ai.economy.contract.created"
  | "ai.economy.contract.executed"
  | "ai.economy.contract.cancelled"
  | "ai.economy.ecosystem.analyzed"
  // Governance & Safety events (Phase 26 — System Stability)
  | "governance.action.allowed"
  | "governance.action.blocked"
  | "governance.circuit_breaker.opened"
  | "governance.rate_limit.exceeded"
  | "governance.sandbox.created"
  | "governance.sandbox.tested"
  | "governance.sandbox.promoted"
  | "governance.sandbox.rejected"
  | "governance.feedback.action"
  | "governance.feedback.ecosystem_evaluated"
  // Goal Containment telemetry events
  | "goal.limit.hit"
  | "goal.containment.created"
  | "goal.containment.planning_capped"
  | "goal.containment.rejected"
  | "goal.containment.limit_reached"
  | "goal.containment.cycle_detected"
  // Constitutional governance events
  | "governance.rule.evaluated"
  | "governance.rule.blocked"
  | "governance.rule.warned"
  | "governance.knowledge.queried"
  | "governance.playbook.executed"
  | "governance.playbook.step_completed"
  // Ecosystem Stability Controller events
  | "stability.assessed"
  | "stability.freeze"
  | "stability.throttle"
  | "stability.warn"
  | "stability.recover"
  | "stability.emergency"
  | "stability.expansion.denied"
  // Simulation Layer events
  | "simulation.started"
  | "simulation.step.completed"
  | "simulation.finished"
  | "simulation.evaluated"
  | "simulation.strategy.selected"
  // Monte Carlo Engine events
  | "simulation.montecarlo.started"
  | "simulation.universe.completed"
  | "simulation.analysis.finished"
  | "simulation.montecarlo.strategy.selected"
  // Real System Behavior (Layer 2)
  | "metrics.recorded"
  | "decision.cycle.completed"
  | "decision.action.executed"
  // Continuous Thinking Loop events
  | "thinking.micro_decision"
  | "thinking.bottleneck.detected"
  | "thinking.action.triggered"
  // Executor scaling events
  | "executor.kill.underperformer"
  | "executor.scale.winner"
  | "executor.finance.pause_requested"
  | "executor.pricing.optimization"
  | "executor.cycle.completed"
  // Autonomous subsystem events
  | "agent.coordinator.completed"
  | "strategy.brain.updated"
  | "conversion.cycle.completed"
  | "email.sequence.cycle.completed"
  | "reddit.reply.cycle.completed"
  | "traffic.loop.cycle.completed"
  | "skill.extracted"
  | "decision.direct_action";

export interface EventPayload {
  [key: string]: unknown;
}

export interface PaperclipEvent<T extends EventPayload = EventPayload> {
  name: EventName;
  payload: T;
  timestamp: string;
  source?: string;
}

export type EventHandler<T extends EventPayload = EventPayload> = (
  event: PaperclipEvent<T>,
) => void | Promise<void>;
