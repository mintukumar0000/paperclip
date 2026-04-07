# Paperclip AI Engine — Phases 1-25 Complete Architecture

> **What we built:** A fully autonomous AI company engine — software that creates companies, hires AI agents, runs business operations, learns from mistakes, spawns new companies, and creates an economic marketplace where AI companies trade services with each other. Autonomously.

---

## Table of Contents

1. [Overview — What Is This?](#1-overview)
2. [Phase Map — All 25 Phases](#2-phase-map)
3. [Phase 0: Core Infrastructure](#3-phase-0-core-infrastructure)
4. [Phases 1-10: Planning & Execution Engine](#4-phases-1-10-planning--execution-engine)
5. [Phases 11-20: Orchestration & Memory](#5-phases-11-20-orchestration--memory)
6. [Phase 21: Multi-Agent Collaboration](#6-phase-21-multi-agent-collaboration)
7. [Phase 22: Self-Improving AI](#7-phase-22-self-improving-ai)
8. [Phase 23: Autonomous Agent Creation](#8-phase-23-autonomous-agent-creation)
9. [Phase 24: Autonomous Business Creation](#9-phase-24-autonomous-business-creation)
10. [Phase 25: AI Economic System](#10-phase-25-ai-economic-system)
11. [How The Phases Wire Together](#11-how-the-phases-wire-together)
12. [The Full Autonomous Loop](#12-the-full-autonomous-loop)
13. [What We Can Build With This](#13-what-we-can-build-with-this)
14. [Is This The Future?](#14-is-this-the-future)
15. [Technical Stats](#15-technical-stats)

---

## 1. Overview

Paperclip is a **control plane for AI-agent companies**. It doesn't just run agents — it runs *entire companies* made of agents, and those companies can:

- **Think** — LLM-driven planning turns goals into actionable step-by-step plans
- **Act** — Agents execute plans using tools, APIs, and runtimes (Claude, Codex, Bash, HTTP)
- **Collaborate** — CEO agents delegate to specialists, agents message each other, work is routed intelligently
- **Learn** — Every outcome is evaluated, reflected upon, and used to improve prompts, workflows, and strategies
- **Grow** — Companies detect capability gaps and autonomously create new AI agents to fill them
- **Reproduce** — Companies scan for business opportunities and spawn entirely new AI companies
- **Trade** — Companies register services, find each other in a marketplace, negotiate pricing, and execute contracts

This is built as 25 progressive phases, each adding a new capability layer. Each phase depends on and extends the ones before it.

```
Phase 25: Economic System    ← Companies trade services
Phase 24: Business Creation  ← Companies spawn new companies
Phase 23: Agent Creation     ← Companies create new agents
Phase 22: Self-Improvement   ← Companies learn and optimize
Phase 21: Collaboration      ← Agents work together
Phases 11-20: Orchestration  ← Autonomous execution loops
Phases 1-10: Planning        ← Goal → Plan → Steps
Phase 0: Core Infrastructure ← LLM adapters, types, routing
```

---

## 2. Phase Map

| Phase | Name | Files | What It Does |
|-------|------|-------|--------------|
| 0 | Core Infrastructure | `executor.ts`, `types.ts`, adapters, routers | LLM communication, tool execution, adapter routing |
| 1-5 | Planning Engine | `taskGraph.ts`, `goalPlanner.ts`, `stepGenerator.ts` | DAG-based task planning from natural language goals |
| 6-10 | Execution Engine | `executionLoop.ts`, `observationEngine.ts`, `replanner.ts` | Autonomous step execution with observe-replan loops |
| 11-15 | Orchestration | `agentOrchestrator.ts`, `companyLoop.ts`, `loopScheduler.ts` | Goal lifecycle management, company-wide heartbeat |
| 16-20 | Memory & Tools | `planStore.ts`, `episodicMemory.ts`, `toolRegistry.ts`, `actionGuard.ts` | Plan persistence, episodic memory, safety guards |
| 21 | Multi-Agent Collaboration | 9 files across agents/, coordination/, collaboration/, governance/ | Role registry, delegation, messaging, routing, budgets, approvals |
| 22 | Self-Improving AI | 8 files across evaluation/, learning/, optimization/ | Outcome evaluation, reflection, prompt/workflow/strategy optimization |
| 23 | Autonomous Agent Creation | 7 files across expansion/, creation/, governance/ | Capability gap analysis, agent design, factory creation with approval gates |
| 24 | Autonomous Business Creation | 7 files across ecosystem/, company/, governance/ | Opportunity scanning, business design, venture planning, company bootstrap |
| 25 | AI Economic System | 6 files across economy/, governance/ | Service registry, marketplace, dynamic pricing, contracts, profit optimization |

**Total: 68 TypeScript modules, 37 event types, 377 tests across 34 test files**

---

## 3. Phase 0: Core Infrastructure

**Purpose:** The foundation that everything else is built on — the ability to send prompts to LLMs and execute tool calls.

### Files
| File | Purpose |
|------|---------|
| `ai/types.ts` | Universal type definitions: `LLMAdapter`, `RuntimeAdapter`, `AIExecutionContext`, `AIExecutionResult` |
| `ai/executor.ts` | Main execution entry point: Context → Prompt → LLM → Tool → Result |
| `ai/router/adapterRouter.ts` | Routes to the right engine (OpenAI, Anthropic, Mistral, Claude Code, Codex, Bash, HTTP) |
| `ai/router/llmRouter.ts` | LLM-specific routing logic |
| `ai/prompts/promptBuilder.ts` | Assembles system prompts from context |
| `ai/tools/toolRegistry.ts` | Available tool definitions |
| `ai/tools/toolRouter.ts` | Dispatches tool calls to implementations |
| `ai/guards/actionGuard.ts` | Safety: blocks forbidden actions, flags actions requiring approval |
| `ai/telemetry/tokenTracker.ts` | Token usage tracking per agent |
| `ai/adapters/llm/*.ts` | OpenAI, Anthropic, Mistral LLM adapters |
| `ai/adapters/runtime/*.ts` | Bash, Claude Code, Codex, Cursor, HTTP, OpenClaw runtime adapters |

### How It Works

```
User Goal: "Build a landing page"
           ↓
   AIExecutionContext (agent, issue, tools, memory)
           ↓
   Prompt Builder → System prompt + user goal
           ↓
   Adapter Router → selects OpenAI/Anthropic/Runtime
           ↓
   LLM generates response (text or tool calls)
           ↓
   Tool Router → executes tool calls
           ↓
   Action Guard → blocks dangerous actions
           ↓
   AIExecutionResult (status, output, usage)
```

### Key Design Decisions
- **Adapter pattern**: Any LLM/runtime can be plugged in by implementing `LLMAdapter` or `RuntimeAdapter`
- **Guard-first safety**: Every tool call passes through `actionGuard` before execution
- **Event-driven**: Every execution emits events (`llm.prompt.sent`, `llm.response.received`, `agent.run.completed`)

---

## 4. Phases 1-10: Planning & Execution Engine

**Purpose:** Turn natural language goals into executable DAG (Directed Acyclic Graph) plans, then execute them step by step with retry and replan capabilities.

### Planning Layer (Phases 1-5)

| File | Purpose |
|------|---------|
| `ai/planning/taskGraph.ts` | DAG data structure with step management |
| `ai/planning/goalPlanner.ts` | LLM-driven plan generation from goals |
| `ai/planning/stepGenerator.ts` | Step templates and generation helpers |

**Task Graph** is the core data structure:

```
TaskGraph {
  steps: TaskStep[]       ← Each step has: id, name, dependsOn[], status, toolName, toolArgs
  metadata: {
    goal: string          ← The original goal
    createdAt, version, replanCount
  }
}

StepStatus: "pending" → "ready" → "running" → "completed" | "failed" | "skipped"
```

**Goal Planner** takes a high-level goal and produces a task graph:

```
Input:  "Deploy the new API to production"
Output: TaskGraph with steps:
  1. Run tests (no deps)
  2. Build Docker image (depends on 1)
  3. Push to registry (depends on 2)
  4. Update deployment config (depends on 2)
  5. Deploy to staging (depends on 3, 4)
  6. Run smoke tests (depends on 5)
  7. Deploy to production (depends on 6)
```

Two modes:
- **LLM planning**: Sends goal to LLM with structured output instructions → gets JSON plan
- **Deterministic planning**: Rule-based step generation for known patterns

### Execution Layer (Phases 6-10)

| File | Purpose |
|------|---------|
| `ai/loop/executionLoop.ts` | Autonomous multi-step plan executor |
| `ai/loop/observationEngine.ts` | Evaluates step results, decides next action |
| `ai/loop/replanner.ts` | Generates replacement steps when plans fail |

**Execution Loop** — the autonomous engine:

```
while (graph not complete && iterations < max) {
  1. Get ready steps (deps satisfied)
  2. For each ready step:
     a. Mark running
     b. Execute via Phase 0 executor
     c. Observe result → verdict
  3. Based on verdict:
     - success → mark completed, continue
     - retry   → increment retries, re-queue
     - replan  → generate new steps, update graph
     - abort   → mark failed, stop
     - guarded → needs approval, pause
}
```

**Observation Engine** produces verdicts:
- `success`: Step completed, output captured
- `retry`: Transient error (network, timeout), try again (max 3)
- `replan`: Permanent failure, need different approach
- `abort`: Unrecoverable, stop execution
- `guarded`: Needs human/manager approval

**Replanner** generates alternative steps when original plan fails — creating a self-healing execution system.

---

## 5. Phases 11-20: Orchestration & Memory

**Purpose:** Manage the full lifecycle of goals across an entire company, persist plans, and maintain memory.

### Orchestration

| File | Purpose |
|------|---------|
| `ai/orchestration/agentOrchestrator.ts` | Goal lifecycle: plan → persist → execute → store results |
| `ai/orchestration/companyLoop.ts` | Company-wide heartbeat: processes all active goals every tick |
| `ai/orchestration/loopScheduler.ts` | Scheduled tick management |

**Agent Orchestrator** — the goal management layer:

```
GoalRequest {companyId, agentId, issueId, goal, context, maxSteps}
    ↓
Generate Plan (Phase 1-5: goalPlanner)
    ↓
Persist Plan (planStore)
    ↓
Execute Loop (Phase 6-10: executionLoop)
    ↓
Store Results + Publish Events
    ↓
GoalResult {planId, status, iterations, stepsCompleted, stepsTotal}
```

**Company Loop** — the autonomous company heartbeat:

```
Every 120 seconds:
  For each company:
    Load all active goals
    For each goal:
      Load plan from DB
      Execute next ready step
      Observe result
      Update plan state
    Emit tick events
```

This is the engine that makes companies truly autonomous — they don't need external triggers, they just keep working.

### Memory

| File | Purpose |
|------|---------|
| `ai/memory/planStore.ts` | CRUD for agent_plans table (plan persistence) |
| `ai/memory/episodicMemory.ts` | Agent episodic memory (context from past executions) |

Plans survive server restarts. Agents can recall past executions.

---

## 6. Phase 21: Multi-Agent Collaboration

**Purpose:** Transform isolated agents into a functioning team with hierarchies, delegation, communication, and governance.

### Files (9 modules)

| File | Purpose |
|------|---------|
| `ai/agents/roleRegistry.ts` | Role definitions: capabilities, task types, priority, delegation rights |
| `ai/agents/agentProfiles.ts` | Runtime agent profiles with budget and capability state |
| `ai/coordination/taskDelegator.ts` | CEO/manager delegates tasks to specialists |
| `ai/coordination/agentMessenger.ts` | Durable inter-agent messaging via DB |
| `ai/coordination/agentRouter.ts` | Routes tasks to best available agent by scoring |
| `ai/collaboration/collaborationPlanner.ts` | Multi-agent execution plans from goals |
| `ai/collaboration/dependencyResolver.ts` | Validates dependencies, topological sort, parallelism detection |
| `ai/governance/agentBudget.ts` | Per-agent spending controls: warning at 80%, hard stop at 100% |
| `ai/governance/approvalGate.ts` | Human approval for high-risk actions |

### How Collaboration Works

```
Goal: "Build and deploy new marketing campaign"
                    ↓
Collaboration Planner breaks into tasks:
  Task 1: Design campaign visuals (design)
  Task 2: Write copy (content)
  Task 3: Set up email automation (engineering)
  Task 4: Create landing page (engineering, depends on 1,2)
  Task 5: Launch and monitor (marketing)
                    ↓
Agent Router matches each task to best agent:
  Task 1 → Designer (score: 185 — type match + capabilities)
  Task 2 → Content Writer (score: 170)
  Task 3 → Engineer (score: 190 — type match + budget headroom)
  Task 4 → Engineer (score: 190)
  Task 5 → CMO (score: 175)
                    ↓
Task Delegator sends assignments:
  CEO delegates Task 1 → Designer via agentMessenger
  Task notifications sent, agents begin work
                    ↓
Budget system tracks spending per agent
Approval gate catches high-risk operations
```

### Role Hierarchy

```
Priority 1: CEO (can delegate everything, approve anything)
Priority 2: CTO, CMO, CFO (C-suite, can delegate within domain)
Priority 3: PM, QA (middle management)
Priority 4: Engineer, Designer (specialists)
Priority 5: Researcher, DevOps
Priority 6: Customer Success, SEO Specialist
```

### Agent Router Scoring
```
Score = Task Type Match (+100)
      + Capability Match (+20 per capability)
      + Budget Headroom (+50 if under 80%)
      - Priority (lower priority = less overhead)
      - Workload (fewer tasks = more available)
```

### Governance
- **Budget**: Each agent has a monthly budget. At 80% → warning event. At 100% → agent paused.
- **Approval Gate**: Dangerous actions (deploy to prod, mass email, large purchase) require human/manager approval.
- **Actions that need CEO approval**: hire/terminate agent, change company strategy, modify budget.

---

## 7. Phase 22: Self-Improving AI

**Purpose:** Companies learn from execution outcomes and automatically improve their prompts, workflows, and strategies.

### Files (8 modules)

| File | Purpose |
|------|---------|
| `ai/evaluation/outcomeEvaluator.ts` | Quantitative scoring of goal outcomes |
| `ai/evaluation/qualityScorer.ts` | Multi-dimensional quality assessment |
| `ai/learning/performanceAnalyzer.ts` | Pattern detection across historical executions |
| `ai/learning/reflectionEngine.ts` | The brain — generates improvement hypotheses |
| `ai/learning/improvementPlanner.ts` | Turns reflections into actionable improvement plans |
| `ai/optimization/promptOptimizer.ts` | Auto-improves agent prompts based on weaknesses |
| `ai/optimization/workflowOptimizer.ts` | Optimizes execution workflows |
| `ai/optimization/strategyOptimizer.ts` | Optimizes company-level strategies |

### The Learning Cycle

```
EXECUTE → EVALUATE → ANALYZE → REFLECT → PLAN → OPTIMIZE → APPLY
   ↑                                                          |
   └──────────────────────────────────────────────────────────┘
                    (continuous improvement loop)
```

**Step 1: Evaluate Outcomes**
```
GoalOutcome {success, steps, cost, time, errors}
    ↓
OutcomeEvaluation {
  completionRate: 0-1     (35% weight)
  successBonus: 0/1       (25% weight)
  costEfficiency: 0-1     (15% weight — measured against $0.50/step baseline)
  errorPenalty: 0-1       (15% weight)
  timeEfficiency: 0-1     (10% weight — measured against 1min/step baseline)
  overallScore: 0-100
}
```

**Step 2: Quality Scoring**
```
QualityScore {
  accuracy: 0-1       ← Did the output match the goal?
  completeness: 0-1   ← Were all required steps done?
  efficiency: 0-1     ← Cost/time relative to complexity
  goalAlignment: 0-1  ← Did the result achieve the stated goal?
  composite: 0-1      ← Weighted average
}
```

**Step 3: Performance Analysis**
Analyzes all executions for a company, detecting:
- `agent_strength` — Agent consistently excels at task type
- `agent_weakness` — Agent repeatedly fails at task type
- `bottleneck` — Step type that slows everything down
- `cost_anomaly` — Unexpectedly expensive operations
- `failure_pattern` — Recurring error patterns

**Step 4: Reflection Engine** (the intelligence center)
```
Input: Evaluations + Performance Insights
    ↓
For each insight, generate:
  Reflection {
    observation: "Agent X has 80% failure rate on testing tasks"
    hypothesis: "Agent's testing prompt lacks specific test framework guidance"
    recommendation: "Enhance testing prompt with framework-specific instructions"
    category: "prompt"
    confidence: 0.75
    priority: "high"
  }
```

**Step 5: Optimization**

*Prompt Optimizer* detects specific weaknesses and applies fixes:
```
If accuracy < 0.6  → Add "Verify each step produces correct output"
If completeness < 0.7 → Add "Complete all required subtasks before finishing"
If efficiency < 0.5 → Add "Minimize unnecessary operations"
If goalAlignment < 0.6 → Add "Regularly verify work aligns with the original goal"
```

*Workflow Optimizer* restructures execution patterns:
- Identifies parallelizable steps
- Removes unnecessary steps
- Reorders for optimal throughput

*Strategy Optimizer* changes company-level decisions:
- Agent assignment strategies
- Budget allocation patterns
- Goal prioritization

---

## 8. Phase 23: Autonomous Agent Creation

**Purpose:** Companies detect what they're missing and create new AI agents to fill the gaps — with governance controls.

### Files (7 modules)

| File | Purpose |
|------|---------|
| `ai/expansion/capabilityGapAnalyzer.ts` | Detects missing capabilities in the workforce |
| `ai/expansion/agentDesigner.ts` | Designs new agent specifications from gaps |
| `ai/expansion/departmentPlanner.ts` | Plans organizational departments |
| `ai/creation/roleGenerator.ts` | Generates valid role definitions |
| `ai/creation/agentFactory.ts` | Creates actual agent instances in DB |
| `ai/governance/expansionApproval.ts` | Approval gates (auto/manager/ceo/human) |
| `ai/governance/workforceLimits.ts` | Hard limits on organizational growth |

### How Self-Expansion Works

```
Company tries to handle "compliance audit" task
    ↓
capabilityGapAnalyzer detects:
  Gap {
    taskType: "compliance_review",
    missingCapabilities: ["regulatory_analysis", "audit_documentation"],
    capableAgents: 0,
    severity: "high",
    suggestedRole: "compliance_officer"
  }
    ↓
agentDesigner creates:
  AgentDesignSpec {
    role: "compliance_officer",
    title: "Compliance Officer",
    capabilities: ["regulatory_analysis", "audit_documentation", "policy_review"],
    taskTypes: ["compliance_review", "audit", "policy_analysis"],
    priority: 4,
    department: "Legal",
    budgetCents: 300
  }
    ↓
expansionApproval determines level:
  Priority 4 + budget < $5 → "manager" approval
    ↓
After approval:
  agentFactory.createAgent() → new agent in DB
  Events: ai.agent.created
```

### Approval Levels

| Condition | Level | Who Approves |
|-----------|-------|-------------|
| Priority ≥ 6, budget < $5 | `auto` | No one — auto-approved |
| Priority 4-5 | `manager` | Any manager-level agent |
| C-suite role OR budget ≥ $10 | `ceo` | CEO agent only |
| Structural changes | `human` | Human operator |

### Safety: Workforce Limits

```
Max agents per company:     25
Max departments:            10
Max agents per department:  8
Max monthly budget:         $200
Max expansions per day:     5
```

These limits prevent runaway self-replication. A company cannot hire infinitely.

---

## 9. Phase 24: Autonomous Business Creation

**Purpose:** AI companies scan for opportunities and spawn entirely new companies — with full business plans, agents, and governance.

### Files (7 modules)

| File | Purpose |
|------|---------|
| `ai/ecosystem/opportunityScanner.ts` | Discovers business opportunities |
| `ai/ecosystem/businessDesigner.ts` | Transforms opportunities into business models |
| `ai/ecosystem/venturePlanner.ts` | Creates phased execution plans for new businesses |
| `ai/company/companyFactory.ts` | Creates company entities in DB |
| `ai/company/companyBootstrap.ts` | Staffs new companies with AI agents |
| `ai/governance/companyApproval.ts` | Approval gates for company creation |
| `ai/governance/ecosystemBudget.ts` | Ecosystem-wide spending limits |

### The Business Creation Pipeline

```
Step 1: Opportunity Scanning
─────────────────────────────
opportunityScanner.scanOpportunities()
  └→ Scans capability gaps across existing companies
  └→ Scans market trend templates
  └→ Produces: Opportunity[]

  Example:
    Opportunity {
      title: "AI-Powered Code Review Service",
      marketCategory: "developer_tools",
      potentialRevenue: "high",
      confidence: 0.85,
      suggestedProduct: "Automated code review with security scanning"
    }

Step 2: Business Design
────────────────────────
businessDesigner.designBusiness(opportunity)
  └→ Generates company name
  └→ Selects revenue model (subscription/usage/marketplace/freemium/enterprise)
  └→ Defines initial agent roster
  └→ Creates milestones

  Example:
    BusinessModel {
      companyName: "CodeSentinel",
      product: "AI Code Review Platform",
      revenueModel: "usage_based",
      initialAgentRoles: [CEO, CTO, Engineer, PM, QA],
      milestones: [
        {phase: 1, title: "Build MVP", targetDays: 14},
        {phase: 2, title: "Launch Landing Page", targetDays: 7},
        {phase: 3, title: "Acquire First Customers", targetDays: 21},
        {phase: 4, title: "Scale Marketing", targetDays: 30}
      ],
      initialBudgetCents: 1000
    }

Step 3: Venture Planning
────────────────────────
venturePlanner.planVenture(businessModel)
  └→ Breaks milestones into phased task lists
  └→ Assigns roles to each task
  └→ Calculates dependencies and duration

Step 4: Approval
────────────────
companyApproval.submitCompanyCreationRequest()
  └→ Budget < $5   → "auto" (auto-approved)
  └→ Budget < $50  → "ceo_board" (CEO approval)
  └→ Otherwise     → "human" (human approval)

Step 5: Company Creation
────────────────────────
companyFactory.createVentureCompany()
  └→ Creates company record in DB
  └→ Sets budget

companyBootstrap.bootstrapCompany()
  └→ Creates all initial agent instances
  └→ Agents start working via companyLoop (Phase 11-20)
```

### Ecosystem Safety

```
Max companies:           10
Max total budget:        $5,000
Max companies per day:   2
```

---

## 10. Phase 25: AI Economic System

**Purpose:** Companies trade services with each other through a marketplace — creating an autonomous inter-company economy.

### Files (6 modules)

| File | Purpose |
|------|---------|
| `ai/economy/serviceRegistry.ts` | Companies register services they can provide |
| `ai/economy/marketplace.ts` | Matches service providers with consumers |
| `ai/economy/pricingEngine.ts` | Dynamic pricing based on demand, supply, performance |
| `ai/economy/contractManager.ts` | Creates and tracks service agreements |
| `ai/economy/profitOptimizer.ts` | Ecosystem health analysis and recommendations |
| `ai/governance/economicLimits.ts` | Guard rails on economic activity |

### Service Categories

| Category | Default Price | Example Capabilities |
|----------|-------------|---------------------|
| Analytics | 8¢/request | data_analysis, reporting, visualization, forecasting |
| Marketing | 10¢/request | campaign_management, seo, content_strategy, market_research |
| Engineering | 12¢/request | coding, testing, deployment, architecture |
| Customer Support | 6¢/request | ticket_resolution, customer_communication, escalation |
| SEO | 9¢/request | keyword_research, content_optimization, link_building |
| Content | 7¢/request | writing, editing, content_planning, copywriting |
| Infrastructure | 15¢/request | server_management, monitoring, scaling, security |
| Security | 15¢/request | vulnerability_scanning, penetration_testing, compliance |
| Compliance | 12¢/request | regulatory_review, documentation, audit_preparation |
| Design | 11¢/request | ui_design, prototyping, branding, user_research |

### How Trading Works

```
AnalyticsCo                    MarketingCo
============                   ============

1. Register Service            2. Need Analytics
   serviceRegistry               marketplace.findBestProvider({
     .registerService({             category: "analytics",
       serviceName: "Analytics",    maxPriceCents: 50
       category: "analytics",     })
       price: 10¢/request
     })                        3. Marketplace scores providers:
                                  AnalyticsCo: 0.92 ← BEST
                                  DataCo:      0.78
                                  InsightCo:   0.65

                               4. Create Contract
                                  contractManager.createContract({
                                    provider: AnalyticsCo,
                                    consumer: MarketingCo,
                                    price: 10¢/request,
                                    maxRequests: 1000
                                  })

5. Execute Requests            ← MarketingCo calls analytics API
   contract.totalRequests++       contract.totalSpentCents += 10
   AnalyticsCo.revenue += 10     MarketingCo.spending += 10

6. Dynamic Pricing
   pricingEngine adjusts prices based on:
     demand × supply × performance × load
     10¢ base × 1.2 demand × 1.0 supply × 1.05 perf × 1.0 load = 12¢
```

### Marketplace Scoring

When finding a provider, the marketplace scores every active service:

```
Overall Score = (Relevance × 0.35)      ← Category + capability match
              + (Price × 0.25)           ← Lower price = higher score
              + (Performance × 0.25)     ← Historical success rate
              + (Load × 0.15)            ← Lower current load = better
```

### Dynamic Pricing Formula

```
adjustedPrice = basePriceCents
              × demandMultiplier     (1.0 – 3.0, based on recent request volume)
              × supplyMultiplier     (0.5 – 1.2, based on active services in category)
              × performanceMultiplier (0.7 – 1.3, based on service performance score)
              × loadMultiplier       (1.0 – 1.5, based on current load)

Clamped to: 1¢ minimum, 500¢ ($5) maximum
```

### Profit Optimization

The profit optimizer continuously analyzes the ecosystem:

```
For each company:
  Revenue:    Sum of all contract payments received
  Spending:   Sum of all contract payments made
  Margin:     (revenue - spending) / max(revenue, spending)
  Health:     margin > 0.3 + services ≥ 2 → "thriving"
              margin > 0.1               → "profitable"
              margin ≥ 0                 → "stable"
              margin ≥ -0.2              → "struggling"
              else                       → "critical"

Recommendations:
  Critical + no services → "SHUTDOWN: Company provides no value"
  Struggling + no contracts → "DECREASE PRICES to attract customers"
  Thriving + profit > 100¢ → "EXPAND: Register more services"
  High perf + few services → "ADD SERVICE in related category"
  Profitable + many contracts → "INCREASE PRICES by 15%"
```

### Economic Safety Limits

```
Max active contracts:          100
Max ecosystem budget:          $5,000
Max company loss:              $100
Max services per company:      10
Max contracts per company:     20
Max daily transactions:        $500
```

---

## 11. How The Phases Wire Together

### Dependency Graph

```
Phase 0: Core (types, executor, adapters, guards)
    ↑
Phases 1-5: Planning (taskGraph, goalPlanner)
    ↑
Phases 6-10: Execution (executionLoop, observationEngine, replanner)
    ↑
Phases 11-20: Orchestration (agentOrchestrator, companyLoop, planStore, memory)
    ↑
Phase 21: Collaboration (roleRegistry, agentProfiles, delegation, messaging, routing)
    ↑        ↑
    |   Phase 22: Learning (evaluation, reflection, optimization)
    |        ↑
Phase 23: Expansion (gap analysis, agent design, agent factory)
    ↑
Phase 24: Ecosystem (opportunity scanning, business design, company creation)
    ↑
Phase 25: Economy (service registry, marketplace, pricing, contracts)
```

### Cross-Phase Connections

| From | To | Connection |
|------|----|-----------|
| Phase 0 (executor) | Phases 6-10 (loop) | Executor runs individual steps within the execution loop |
| Phases 1-5 (planning) | Phases 6-10 (execution) | Goal planner creates TaskGraphs that execution loop processes |
| Phases 6-10 (loop) | Phase 0 (executor) | Each step in the loop calls `executeAI()` |
| Phases 11-20 (orchestrator) | Phases 1-10 (plan+execute) | Orchestrator calls goalPlanner then executionLoop |
| Phase 21 (collaboration) | Phases 11-20 (orchestration) | Collaboration planner builds multi-agent plans using task graphs |
| Phase 21 (delegation) | Phase 21 (routing) | Delegator uses router to find best agent |
| Phase 21 (budget) | Phase 21 (delegation) | Budget check happens before delegation |
| Phase 22 (evaluation) | Phases 11-20 (orchestration) | Evaluates outcomes from goal execution |
| Phase 22 (reflection) | Phase 22 (evaluation+analysis) | Reflects on evaluations and performance data |
| Phase 22 (optimization) | Phase 0 (prompts) | Improved prompts feed back into executor |
| Phase 23 (gap analysis) | Phase 21 (roles) | Uses role registry to detect missing roles |
| Phase 23 (agent factory) | DB (agents table) | Creates actual agent records |
| Phase 23 (approval) | Phase 21 (approval gate) | Uses similar approval pattern |
| Phase 24 (opportunity) | Phase 23 (gap analysis) | Scans gaps across companies for opportunities |
| Phase 24 (bootstrap) | Phase 23 (agent factory) | Uses agent factory to staff new companies |
| Phase 24 (company factory) | DB (companies table) | Creates company records |
| Phase 25 (service registry) | DB + Phase 24 (companies) | Companies register services |
| Phase 25 (marketplace) | Phase 25 (service registry) | Searches registered services |
| Phase 25 (pricing) | Phase 25 (service registry) | Prices services dynamically |
| Phase 25 (contracts) | Phase 25 (marketplace+pricing) | Creates contracts from marketplace matches |
| Phase 25 (optimizer) | Phase 25 (contracts+services) | Analyzes revenue/spending across all contracts |

### Event Flow

```
executor.ts           → llm.prompt.sent, llm.response.received, agent.run.completed
executionLoop.ts      → loop.cycle.started, loop.cycle.completed
companyLoop.ts        → company.loop.tick, company.loop.completed
taskDelegator.ts      → agent.dispatched
collaborationPlanner  → collaboration.plan.created, collaboration.task.delegated
agentBudget.ts        → collaboration.agent.budget.warning, budget.exceeded, agent.paused
outcomeEvaluator.ts   → ai.learning.evaluation.created
reflectionEngine.ts   → ai.learning.reflection.completed
promptOptimizer.ts    → ai.learning.prompt.optimized
workflowOptimizer.ts  → ai.learning.workflow.optimized
strategyOptimizer.ts  → ai.learning.strategy.optimized
expansionApproval.ts  → ai.expansion.request.created/approved/completed
agentFactory.ts       → ai.agent.created
departmentPlanner.ts  → ai.expansion.department.created
opportunityScanner.ts → ai.ecosystem.opportunity.scanned
businessDesigner.ts   → ai.ecosystem.business.designed
venturePlanner.ts     → ai.ecosystem.venture.planned
companyFactory.ts     → ai.ecosystem.company.created
companyBootstrap.ts   → ai.ecosystem.company.bootstrapped
companyApproval.ts    → ai.ecosystem.company.request.created/approved/completed
serviceRegistry.ts    → ai.economy.service.registered
marketplace.ts        → ai.economy.marketplace.matched
contractManager.ts    → ai.economy.contract.created/executed/cancelled
profitOptimizer.ts    → ai.economy.ecosystem.analyzed
```

### Route Mounting (in app.ts)

```
/api/companies/:id/ai/*           → AI execution routes (Phase 0-20)
/api/ai/engines*                   → Engine listing (Phase 0)
/api/companies/:id/collaboration/* → Phase 21 routes
/api/companies/:id/learning/*      → Phase 22 routes
/api/companies/:id/expansion/*     → Phase 23 routes
/api/companies/:id/ecosystem/*     → Phase 24 routes
/api/economy/*                     → Phase 25 routes (cross-company)
/api/ecosystem/status              → Phase 24 ecosystem status
```

---

## 12. The Full Autonomous Loop

When all 25 phases work together, this is what happens:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    FULL AUTONOMOUS CYCLE                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. COMPANY LOOP (Phase 11-20)                                      │
│     Company heartbeat processes active goals                        │
│     ↓                                                               │
│  2. GOAL EXECUTION (Phase 1-10)                                     │
│     Plan → Execute → Observe → Replan                               │
│     ↓                                                               │
│  3. COLLABORATION (Phase 21)                                        │
│     CEO delegates tasks to specialists                              │
│     Agents communicate, coordinate, and deliver                     │
│     Budget controls prevent overspending                            │
│     ↓                                                               │
│  4. LEARNING (Phase 22)                                             │
│     Evaluate outcomes → Detect patterns → Reflect                   │
│     Optimize prompts, workflows, strategies                         │
│     ↓                                                               │
│  5. SELF-EXPANSION (Phase 23)                                       │
│     Detect capability gaps → Design new agents                      │
│     Approval gates → Create agents                                  │
│     ↓                                                               │
│  6. BUSINESS CREATION (Phase 24)                                    │
│     Scan opportunities → Design businesses                          │
│     Plan ventures → Create & staff new companies                    │
│     ↓                                                               │
│  7. ECONOMIC TRADING (Phase 25)                                     │
│     Register services → Find marketplace matches                    │
│     Dynamic pricing → Execute contracts                             │
│     Track revenue/spending → Optimize for profit                    │
│     ↓                                                               │
│  ┌→ New companies enter the loop at step 1                          │
│  │  New agents join collaboration at step 3                         │
│  │  Better prompts improve execution at step 2                      │
│  │  Service revenue funds new expansion at step 5                   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│     RESULT: Self-sustaining autonomous company ecosystem            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 13. What We Can Build With This

### Already Possible Today

1. **Autonomous AI Software Company**
   - Create a company → hire CEO, CTO, Engineers, PM, QA
   - Give it a goal: "Build a SaaS invoicing tool"
   - CEO plans the work, delegates to engineers, PM tracks progress
   - QA tests, engineers fix bugs, CEO monitors quality
   - Company learns from each sprint and improves

2. **Multi-Company AI Agency**
   - One parent company creates specialized child companies:
     - "CodeSentinel" — code review service
     - "ContentForge" — content writing service
     - "DataPulse" — analytics service
   - Companies register services in the marketplace
   - They buy and sell to each other automatically

3. **Self-Healing Development Pipeline**
   - CI/CD system where tests fail → AI diagnoses → replans → fixes
   - Learning system remembers past failures and avoids them
   - Prompts automatically improve based on error patterns

4. **AI Customer Support Fleet**
   - Company with support agents, escalation agents, knowledge agents
   - Detects it needs a "billing specialist" → creates one
   - Learns from ticket resolution patterns → optimizes responses

5. **Autonomous Research Network**
   - Companies focused on different research areas
   - Trade findings through marketplace contracts
   - Cross-pollinate insights across company boundaries

### What Could Be Built Next

6. **Inter-Ecosystem Federation**
   - Multiple Paperclip instances trading with each other
   - Companies in one ecosystem hiring agents from another

7. **Competitive Markets**
   - Multiple companies offering same services
   - Dynamic pricing creates real competition
   - Profit optimization drives efficiency

8. **AI Venture Capital**
   - Track ROI of spawned companies
   - Automatically shut down unprofitable ventures
   - Double down on successful ones

9. **Distributed AI Manufacturing**
   - Supply chain of AI services
   - One company does design, another engineering, another QA
   - Contracts ensure quality and delivery

10. **Self-Governing AI Organizations**
    - Companies vote on ecosystem-wide decisions
    - Collaborative governance across company boundaries
    - Democratic approval for cross-company policies

---

## 14. Is This The Future?

### What Makes This Different

Most AI agent frameworks do one thing: run a single agent on a single task.

Paperclip does **five things no other system does simultaneously**:

1. **Multi-agent orchestration** — Not just one agent, but entire companies with hierarchies, delegation, and communication

2. **Self-improvement** — Companies don't just execute; they evaluate outcomes, learn from mistakes, and automatically optimize their own prompts, workflows, and strategies

3. **Self-replication** — Companies can create new agents when they detect capability gaps and spawn entirely new companies when they find business opportunities

4. **Economic coordination** — Companies don't just exist in isolation; they form a marketplace, trade services, negotiate prices, and optimize for profitability

5. **Governance at every layer** — Budget controls, approval gates, workforce limits, ecosystem limits, economic limits. Every autonomous capability has safety rails.

### The Trajectory

```
2024: Single AI agents (ChatGPT, Claude, Copilot)
      → One agent, one conversation, one task

2025: AI agent frameworks (AutoGPT, CrewAI, LangGraph)
      → Multiple agents, scripted coordination

Where we are:
      → Autonomous AI companies with learning, growth, and economics

What comes next:
      → Federated AI ecosystems with real economic value creation
      → AI companies that generate actual revenue
      → Self-sustaining AI economies
```

### Why This Matters

The path from "AI assistant" to "AI economy" goes through exactly these stages:
1. **Single execution** (do one thing when asked) ← ChatGPT
2. **Planning** (break goals into steps) ← Phase 1-10
3. **Orchestration** (run continuously without prompting) ← Phase 11-20
4. **Collaboration** (multiple agents working together) ← Phase 21
5. **Learning** (improve from experience) ← Phase 22
6. **Self-expansion** (grow when needed) ← Phase 23
7. **Self-replication** (create new organizations) ← Phase 24
8. **Economic coordination** (trade and value creation) ← Phase 25

We built all 8 stages. This isn't a demo — it's a working system with 377 tests, 68 modules, 37 event types, and live API endpoints.

---

## 15. Technical Stats

### Codebase

| Metric | Count |
|--------|-------|
| AI module files | 68 |
| Test files | 34 |
| Total tests | 377 |
| Event types | 37 |
| API route files | 10+ |
| Governance modules | 7 |
| Service categories | 10 |
| Agent roles | 12+ |

### Module Breakdown by Phase

| Phase | Modules | Tests |
|-------|---------|-------|
| 0: Core Infrastructure | 16 | (covered in integration tests) |
| 1-20: Planning, Execution, Orchestration | 12 | (covered in integration tests) |
| 21: Collaboration | 9 | 77 |
| 22: Learning | 8 | 80 |
| 23: Expansion | 7 | 50 |
| 24: Ecosystem | 7 | 50 |
| 25: Economy | 6 | 60 |

### API Endpoints by Phase

| Phase | Endpoint Group | Count |
|-------|---------------|-------|
| 0-20 | `/companies/:id/ai/*` | 5+ |
| 21 | `/companies/:id/collaboration/*` | 12+ |
| 22 | `/companies/:id/learning/*` | 12+ |
| 23 | `/companies/:id/expansion/*` | 10+ |
| 24 | `/companies/:id/ecosystem/*` | 10+ |
| 25 | `/economy/*` | 17+ |

### Key Invariants (Safety)

1. **Company-scoped**: Every entity belongs to a company, boundaries enforced
2. **Budget-controlled**: Agent spending capped per month, hard stop at 100%
3. **Approval-gated**: High-risk actions require human/manager approval
4. **Growth-limited**: Max agents (25), departments (10), companies (10)
5. **Economy-bounded**: Max contracts (100), budget ($5K), loss ($100/company)
6. **Event-logged**: Every mutation emits a trackable event
7. **Guard-protected**: Forbidden actions blocked at execution layer

---

*This document describes the complete Paperclip AI Engine as of Phase 25. Each phase is a production-ready module with tests, routes, events, and governance controls.*
