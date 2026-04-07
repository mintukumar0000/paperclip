// ---------------------------------------------------------------------------
// AI Layer — Public API
// ---------------------------------------------------------------------------

// Core types
export type {
  LLMAdapter,
  LLMGenerateInput,
  LLMResponse,
  LLMToolDefinition,
  AIExecutionContext,
  AIExecutionResult,
  RuntimeAdapter,
} from "./types.js";

// Main executor
export { executeAI } from "./executor.js";

// LLM adapters
export { OpenAIAdapter } from "./adapters/llm/openaiAdapter.js";
export { AnthropicAdapter } from "./adapters/llm/anthropicAdapter.js";
export { MistralAdapter } from "./adapters/llm/mistralAdapter.js";

// Runtime adapters
export { OpenClawRuntimeAdapter } from "./adapters/runtime/openclawAdapter.js";
export { ClaudeCodeRuntimeAdapter } from "./adapters/runtime/claudeCodeAdapter.js";
export { CodexRuntimeAdapter } from "./adapters/runtime/codexAdapter.js";
export { CursorRuntimeAdapter } from "./adapters/runtime/cursorAdapter.js";
export { BashRuntimeAdapter } from "./adapters/runtime/bashAdapter.js";
export { HttpRuntimeAdapter } from "./adapters/runtime/httpAdapter.js";

// Runtime infrastructure
export { detectCapabilities, resetCapabilities, isEngineAvailable } from "./runtime/capabilities.js";
export type { AICapabilities } from "./runtime/capabilities.js";
export {
  getEngineRegistry,
  getEnabledEngines,
  getEnabledEnginesByType,
  resolveRegistryEngine,
} from "./runtime/engineRegistry.js";
export type { EngineType, EngineEntry } from "./runtime/engineRegistry.js";
export { runCLI } from "./runtime/cliRunner.js";
export type { CLIRunResult } from "./runtime/cliRunner.js";

// Routers
export {
  getExecutionEngine,
  resolveEngine,
  listExecutionEngines,
  listAvailableEngines,
  listEnginesByCategory,
} from "./router/adapterRouter.js";
export { getLLMAdapter, listLLMProviders } from "./router/llmRouter.js";

// Prompt builder
export { buildPrompt } from "./prompts/promptBuilder.js";

// Tools
export { createToolRegistry } from "./tools/toolRegistry.js";
export { executeTool } from "./tools/toolRouter.js";

// Guards
export { guardAction, isActionForbidden, isActionApprovalRequired, GuardedActionError } from "./guards/actionGuard.js";

// Telemetry
export { trackTokenUsage, getRecentUsage, getUsageByProvider, clearTrackedUsage } from "./telemetry/tokenTracker.js";

// Planning layer
export {
  createTaskGraph,
  addStep,
  getReadySteps,
  markStepRunning,
  markStepCompleted,
  markStepFailed,
  resetStepForRetry,
  isGraphComplete,
  isGraphStuck,
  getGraphProgress,
  replaceSteps,
} from "./planning/taskGraph.js";
export type { TaskGraph, TaskStep, StepStatus } from "./planning/taskGraph.js";
export { generatePlan, generateDeterministicPlan } from "./planning/goalPlanner.js";
export { generateExecutableStep, collectPreviousOutputs } from "./planning/stepGenerator.js";

// Execution loop
export { runExecutionLoop } from "./loop/executionLoop.js";
export type { LoopResult, LoopStatus, LoopOptions } from "./loop/executionLoop.js";
export { observe } from "./loop/observationEngine.js";
export type { Observation, ObservationVerdict } from "./loop/observationEngine.js";
export { replan } from "./loop/replanner.js";

// Memory & plan store
export { planStore } from "./memory/planStore.js";
export { episodicMemory } from "./memory/episodicMemory.js";

// Orchestration
export { agentOrchestrator } from "./orchestration/agentOrchestrator.js";
export type { GoalRequest, GoalResult } from "./orchestration/agentOrchestrator.js";
export { tickScheduler, startLoopScheduler } from "./orchestration/loopScheduler.js";
export { companyExecutionLoop, startCompanyLoop } from "./orchestration/companyLoop.js";
export type { CompanyLoopResult } from "./orchestration/companyLoop.js";

// Multi-Agent Collaboration (Phase 21)
export { getRoleDefinition, getAllRoles, canRoleHandleTask, findBestRoleForTask, roleHasCapability } from "./agents/roleRegistry.js";
export type { RoleDefinition } from "./agents/roleRegistry.js";
export { buildAgentProfile, loadCompanyProfiles, findAgentsForTaskType, findDelegator, loadAgentProfile } from "./agents/agentProfiles.js";
export type { AgentProfile } from "./agents/agentProfiles.js";
export { delegateTask, delegateWithFallback, canDelegateTaskType, getAgentWorkloads } from "./coordination/taskDelegator.js";
export type { DelegationRequest, DelegationResult, AgentWorkload } from "./coordination/taskDelegator.js";
export { sendAgentMessage, getUnreadMessages, broadcastToCompany, markMessageActedOn, getConversation, getMessageCount } from "./coordination/agentMessenger.js";
export type { SendMessageRequest, MessageType } from "./coordination/agentMessenger.js";
export { routeTask, routeToAll, getHierarchy } from "./coordination/agentRouter.js";
export type { RouteRequest, RouteResult } from "./coordination/agentRouter.js";
export { buildCollaborationPlan, autoCollaborationPlan, classifyGoalTasks } from "./collaboration/collaborationPlanner.js";
export type { CollaborationTask, CollaborationPlanRequest, CollaborationPlanResult, TaskAssignment } from "./collaboration/collaborationPlanner.js";
export { validateDependencies, topologicalSort, getMaxParallelism, getExecutionLevels } from "./collaboration/dependencyResolver.js";
export type { DependencyIssue } from "./collaboration/dependencyResolver.js";
export { checkBudget, recordSpending, getCompanyBudgetSummary, canAfford } from "./governance/agentBudget.js";
export type { BudgetStatus } from "./governance/agentBudget.js";
export { checkApproval, approveAction, rejectAction, listPendingApprovals, getApproval, getApprovalLevel } from "./governance/approvalGate.js";
export type { ApprovalRequest, ApprovalStatus } from "./governance/approvalGate.js";

// Self-Improving AI Layer (Phase 22)
export { evaluateOutcome, evaluateOutcomes } from "./evaluation/outcomeEvaluator.js";
export type { GoalOutcome, OutcomeEvaluation } from "./evaluation/outcomeEvaluator.js";
export { scoreQuality, scoreGoalQuality, aggregateQualityScores } from "./evaluation/qualityScorer.js";
export type { QualityInput, QualityScore } from "./evaluation/qualityScorer.js";
export { analyzePerformance, analyzeAgentPerformance } from "./learning/performanceAnalyzer.js";
export type { PerformanceInsight, PerformanceReport, AgentPerformanceSummary } from "./learning/performanceAnalyzer.js";
export { reflect, reflectOnGoal } from "./learning/reflectionEngine.js";
export type { Reflection, ReflectionResult } from "./learning/reflectionEngine.js";
export { planImprovements, getUnappliedPlans, markPlanApplied, rollbackPlan } from "./learning/improvementPlanner.js";
export type { ImprovementAction, ImprovementPlan, PlanningResult } from "./learning/improvementPlanner.js";
export { optimizePrompt, getPromptHistory } from "./optimization/promptOptimizer.js";
export type { PromptVersion, PromptOptimizationResult } from "./optimization/promptOptimizer.js";
export { optimizeWorkflow, getWorkflowOptimizationHistory } from "./optimization/workflowOptimizer.js";
export type { WorkflowStep, WorkflowOptimization } from "./optimization/workflowOptimizer.js";
export { optimizeStrategy, classifyGoalType, getStrategyHistory } from "./optimization/strategyOptimizer.js";
export type { StrategyStep, StrategyOptimization } from "./optimization/strategyOptimizer.js";

// Autonomous Agent Creation & Organizational Expansion (Phase 23)
export { analyzeCapabilityGaps, canHandleTask, analyzeGoalGaps } from "./expansion/capabilityGapAnalyzer.js";
export type { CapabilityGap, GapAnalysisResult } from "./expansion/capabilityGapAnalyzer.js";
export { designAgents, designFromGap } from "./expansion/agentDesigner.js";
export type { AgentDesignSpec, DesignResult } from "./expansion/agentDesigner.js";
export { getCompanyDepartments, planDepartments, createDepartment } from "./expansion/departmentPlanner.js";
export type { DepartmentPlan, ProposedDepartment } from "./expansion/departmentPlanner.js";
export { generateRole, generateRoles, validateRole, toRoleDefinition } from "./creation/roleGenerator.js";
export type { GeneratedRole } from "./creation/roleGenerator.js";
export { createAgent as createExpansionAgent, createAgents as createExpansionAgents } from "./creation/agentFactory.js";
export type { AgentCreationRequest, AgentCreationResult } from "./creation/agentFactory.js";
export { submitExpansionRequest, approveExpansion, rejectExpansion, completeExpansion, listPendingRequests, listExpansionRequests, determineApprovalLevel } from "./governance/expansionApproval.js";
export type { ExpansionRequest, ApprovalLevel as ExpansionApprovalLevel } from "./governance/expansionApproval.js";
export { checkWorkforceStatus, canCreateAgent as canCreateExpansionAgent, canCreateDepartment, getWorkforceLimits } from "./governance/workforceLimits.js";
export type { WorkforceLimits, WorkforceStatus } from "./governance/workforceLimits.js";

// Autonomous Business Creation & Multi-Company Ecosystem (Phase 24)
export { scanOpportunities, scanFromCompanyGaps, scanMarketTrends } from "./ecosystem/opportunityScanner.js";
export type { Opportunity, OpportunitySource, ScanResult } from "./ecosystem/opportunityScanner.js";
export { designBusiness, designBusinesses, generateCompanyName } from "./ecosystem/businessDesigner.js";
export type { BusinessModel, RevenueModel, AgentRoleSpec as EcosystemAgentRoleSpec, Milestone, DesignResult as BusinessDesignResult } from "./ecosystem/businessDesigner.js";
export { planVenture, planVentures } from "./ecosystem/venturePlanner.js";
export type { VenturePlan, VenturePhase, VentureTask } from "./ecosystem/venturePlanner.js";
export { createVentureCompany } from "./company/companyFactory.js";
export type { CompanyCreationRequest, CompanyCreationResult } from "./company/companyFactory.js";
export { bootstrapCompany } from "./company/companyBootstrap.js";
export type { BootstrapResult, AgentCreated } from "./company/companyBootstrap.js";
export { checkEcosystemStatus, canCreateNewCompany, getEcosystemLimits } from "./governance/ecosystemBudget.js";
export type { EcosystemLimits, EcosystemStatus } from "./governance/ecosystemBudget.js";
export { submitCompanyCreationRequest, approveCompanyCreation, rejectCompanyCreation, completeCompanyCreation, listPendingCompanyRequests, listCompanyRequests, determineCompanyApprovalLevel } from "./governance/companyApproval.js";
export type { CompanyApprovalLevel, CompanyApprovalStatus, CompanyApprovalRequest } from "./governance/companyApproval.js";

// AI Economic System (Phase 25)
export { registerService, autoRegisterFromCompany, listActiveServices, findServicesByCategory, findServicesByCompany, getRegistryStats, getService, pauseService, resumeService, deprecateService, clearRegistry, updateServiceLoad, updateServicePerformance, CATEGORY_CAPABILITIES, DEFAULT_CATEGORY_PRICE } from "./economy/serviceRegistry.js";
export type { ServiceListing, ServiceCategory, ServiceStatus, RegisterServiceInput, RegistryStats } from "./economy/serviceRegistry.js";
export { findBestProvider, findMatches, createServiceRequest, getMarketplaceStats, listRequests as listMarketplaceRequests, getMatchHistory, clearMarketplace } from "./economy/marketplace.js";
export type { ServiceRequest, MatchResult, ServiceMatch, MarketplaceStats } from "./economy/marketplace.js";
export { calculatePrice, calculatePriceById, calculateCategoryPrices, getCategoryAveragePrice, getPricingHistory, recordDemand, getDemandLevel, resetDemand, clearPricingData } from "./economy/pricingEngine.js";
export type { PricingFactors, PriceCalculation, PricingHistory, PricingStrategy } from "./economy/pricingEngine.js";
export { createContract, executeContract, getContract, listContractsByCompany, listActiveContracts, cancelContract, getContractExecutions, getContractSummary, getCompanyRevenue, getCompanySpending, clearContracts } from "./economy/contractManager.js";
export type { ServiceContract, ContractStatus, ContractCreationInput, ContractExecution, ContractSummary } from "./economy/contractManager.js";
export { analyzeEcosystem, analyzeCompanyPerformance, getRecommendations, getRecommendationsByPriority, clearOptimizerData } from "./economy/profitOptimizer.js";
export type { CompanyPerformance, CompanyHealthStatus, OptimizationRecommendation, OptimizationAction, EcosystemAnalysis } from "./economy/profitOptimizer.js";
export { checkEconomicStatus, canCreateContract, checkCompanyEconomicStatus, getEconomicLimits, canRegisterService } from "./governance/economicLimits.js";
export type { EconomicLimits, EconomicStatus, CompanyEconomicStatus } from "./governance/economicLimits.js";

// Global Autonomy Limits — hard constraints preventing unbounded expansion
export { getAutonomyLimits, setAutonomyLimits, resetAutonomyLimits, checkLimit, getAutonomyLimitsSnapshot } from "./governance/autonomyLimits.js";
export type { GlobalAutonomyLimits, LimitCheckResult } from "./governance/autonomyLimits.js";

// Goal Containment — prevents Recursive Goal Amplification (RGA)
export { canCreateGoal, capPlanningTasks, getGoalContainmentStats } from "./governance/goalContainment.js";
export type { GoalContainmentCheck } from "./governance/goalContainment.js";

// System Stability — Central Governance Engine (Phase 26)
export { requestGovernanceClearance, recordGovernanceFailure, recordGovernanceSuccess, resetCircuitBreakers, getGovernanceAudit, clearGovernanceAudit, getGovernanceStats } from "./governance/governanceEngine.js";
export type { GovernedActionType, GovernanceRequest, GovernanceDecision, GovernanceStats } from "./governance/governanceEngine.js";

// System Stability — System Rate Limiter (Phase 26)
export { checkRateLimit, peekRateLimit, setRateLimit, getRateLimitConfig, getAllRateLimits, getRateLimitStats, clearRateLimits } from "./governance/systemRateLimiter.js";
export type { RateLimitDomain, RateLimitConfig, RateLimitResult } from "./governance/systemRateLimiter.js";

// System Stability — Execution Sandboxing (Phase 26)
export { getExecutionEnvironment, getPromotionGates, getPromotionGate, createSandboxExecution, recordTestResults, promoteExecution, rejectExecution, getExecution, listExecutions, getSandboxStats, clearSandboxExecutions } from "./governance/executionSandbox.js";
export type { ExecutionEnvironment, PromotionStatus, SandboxExecution, TestResult, PromotionGate } from "./governance/executionSandbox.js";

// System Stability — Economic Feedback Loop (Phase 26)
export { evaluateCompanyROI, evaluateAgentProductivity, runCompanyFeedback, evaluateEcosystemHealth, getPendingFeedbackActions, getCompanyROIHistory, getAgentProductivityHistory, recordTaskCompletion, getFeedbackConfig, setFeedbackConfig, clearFeedbackData } from "./governance/economicFeedbackLoop.js";
export { runBehaviorFeedback } from "./governance/economicFeedbackLoop.js";
export type { CompanyROI, AgentProductivity, FeedbackAction, EcosystemHealth, CompanyHealthTrend, FeedbackLoopConfig, BehaviorMetrics } from "./governance/economicFeedbackLoop.js";

// Real System Behavior (Layer 2) — Metrics + Autonomous Decisions
export { recordSystemMetric, getRecentSystemMetricsSnapshot, listRecentSystemMetrics, estimateTokenCostCents } from "./feedback/metricsEngine.js";
export type { MetricSourceType, SystemMetricInput, SystemMetricSnapshot } from "./feedback/metricsEngine.js";
export { runAutonomousDecisionCycle } from "./governance/decisionEngine.js";
export type { DecisionActionType, DecisionAction, DecisionCycleInput, DecisionCycleResult } from "./governance/decisionEngine.js";
