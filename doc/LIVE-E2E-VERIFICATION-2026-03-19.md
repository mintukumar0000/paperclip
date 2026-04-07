# Live E2E Verification Report (2026-03-19)

This report captures a real run against a live local Paperclip instance at `http://localhost:3100`.

## Environment Snapshot

- API health: `ok`
- Deployment mode: `local_trusted`
- Deployment exposure: `private`
- AI capability detection:
  - `openai: true`
  - `anthropic: false`
  - `mistral: false`
  - `claude_code: true`
  - `codex: true`

## End-to-End Live Checklist

| # | Check | Command/Path | Expected | Result | Notes |
|---|---|---|---|---|---|
| 1 | API reachable | `GET /api/health` | status ok | PASS | health endpoint returned ok |
| 2 | Runtime mode valid for smoke scripts | `health.deploymentMode` | local_trusted | PASS | required by provided smoke scripts |
| 3 | AI capabilities discovered | `GET /api/ai/engines/capabilities` | provider/runtime booleans | PASS | OpenAI true; Anthropic/Mistral false |
| 4 | Acquire-100 scenario script | `node scripts/smoke/acquire-100-users.mjs` | company + issue + goal + artifacts | PARTIAL PASS | artifacts created; AI goal failed due OpenAI quota |
| 5 | Acquire-100 goal execution | `GET /api/companies/:id/ai/goals/:goalId` | completed goal | FAIL | OpenAI 429 insufficient_quota |
| 6 | Full-system scenario script | `node scripts/smoke/micro-saas-50-paying-users.mjs` | collaboration/learning/economy/sim/stability all run | PASS | all subsystem calls returned ok |
| 7 | Full-system AI goal execution | `GET /api/companies/:id/ai/goals/:goalId` | completed goal | FAIL | OpenAI 429 insufficient_quota |
| 8 | Fallback artifact generation | smoke script fallback path | deterministic UI artifacts | PASS | issues/messages/memories/goals visible |
| 9 | Learning module | `POST /api/companies/:id/learning/cycle` | success | PASS | learning cycle executed |
| 10 | Economy module | service register + status | success | PASS | services + status returned |
| 11 | Simulation module | single + montecarlo | success | PASS | both calls returned success |
| 12 | Stability module | assessment + can-expand | success | PASS | both calls returned success |

## Observed Live Run IDs

### Scenario A (Acquire 100 users)
- Company ID: `f0cde462-b4ed-45a3-ba36-a30ef78beca6`
- Issue Prefix: `GRO`
- Core Issue ID: `a5450c0e-69d1-4536-a8c0-d9115dc5e86e`
- Goal Plan ID: `9e6e780e-6411-4796-a06a-7f76f0244ed1`
- Goal status: `failed`
- Failure reason: OpenAI `429 insufficient_quota`

### Scenario B (Micro SaaS 50 paying users)
- Company ID: `de532c5f-e9d0-47ed-b670-1ded3fdd0390`
- Issue Prefix: `AUTAA`
- Core Issue ID: `0f3ca7f2-a578-4add-adff-5964eef5f94f`
- Goal Plan ID: `b95bd48a-2565-4406-a15c-a8bb3e4c3ffe`
- Goal status: `failed`
- Failure reason: OpenAI `429 insufficient_quota`

## Architecture Graphs

## 1) Complete System Architecture (Runtime + Control Plane)

```mermaid
flowchart LR
  UI[React UI]
  API[Express API /api routes]
  WS[Live Events WebSocket]

  subgraph Core[Core Platform]
    DB[(Postgres / Drizzle)]
    EB[Event Bus\nlocal + Redis pubsub]
    Q[BullMQ Queue]
    W[Agent Worker]
    HB[Heartbeat Service]
    LOOP[Company Loop Scheduler]
  end

  subgraph AI[AI Runtime]
    ORCH[Agent Orchestrator]
    EXEC[AI Executor]
    ROUTER[Adapter Router]
    TOOLS[Tool Registry / Router]
    MEM[Memory Retrieval + Episodic Memory]
  end

  subgraph Advanced[Advanced Systems]
    COL[Collaboration]
    LEARN[Learning]
    EXP[Expansion]
    ECO[Ecosystem]
    ECON[Economy]
    GOV[Governance]
    STAB[Stability]
    SIM[Simulation]
  end

  UI --> API
  API --> DB
  API --> EB
  API --> WS

  LOOP --> ORCH
  ORCH --> EXEC
  EXEC --> ROUTER
  EXEC --> TOOLS
  EXEC --> MEM
  ORCH --> DB

  HB --> EXEC
  HB --> MEM

  API --> Q
  Q --> W
  W --> HB

  API --> COL
  API --> LEARN
  API --> EXP
  API --> ECO
  API --> ECON
  API --> GOV
  API --> STAB
  API --> SIM

  COL --> DB
  LEARN --> DB
  EXP --> DB
  ECO --> DB
  ECON --> DB
  GOV --> DB
  STAB --> DB
  SIM --> DB

  EB --> WS
```

## 2) AI Goal Execution Sequence

```mermaid
sequenceDiagram
  participant U as UI/Script
  participant A as API /ai/goals
  participant P as Plan Store
  participant O as Orchestrator/Loop
  participant E as Executor
  participant R as LLM/Runtime Adapter
  participant T as Tool Router
  participant D as DB
  participant B as Event Bus

  U->>A: POST /companies/:id/ai/goals
  A->>P: createPlan(graphJson, status=planning)
  A->>P: updatePlanStatus(active)
  A-->>U: 201 {planId}

  O->>P: list active plans
  O->>E: execute next step
  E->>R: generate/execute
  alt Tool call
    E->>T: executeTool(name,args)
    T->>D: mutate issue/message/memory
  end
  E->>B: publish step/goal events
  O->>P: updatePlanGraph + episodic updates
  O->>P: updatePlanStatus(completed/failed)
```

## 3) Hybrid Onboarding Flow (Implemented)

```mermaid
flowchart TD
  S[Start Quick Create]
  C[Create Company]
  F[Create Fixed Bootstrap Team\nCEO/CTO/CMO/CFO/Engineer/Researcher]
  G[Create Goal + Kickoff Issue]
  CP[Collaboration Auto Plan]
  AG[Create AI Goal Plan]
  HX[Run Hybrid Expansion\nPOST /expansion/expand]
  E1[Economy Auto Services]
  L1[Learning Cycle]
  SI[Simulation Run]
  ST[Stability Can Expand]
  N[Invalidate React Query Caches]
  R[Route to Issue/Dashboard]

  S --> C --> F --> G --> CP --> AG
  AG --> HX
  AG --> E1
  AG --> L1
  AG --> SI
  AG --> ST
  HX --> N
  E1 --> N
  L1 --> N
  SI --> N
  ST --> N
  N --> R
```

## 4) Expansion Pipeline (Research-Driven Agent Creation)

```mermaid
flowchart LR
  X[POST /companies/:id/expansion/expand]
  GV[Governance Clearance + Rate Limit]
  WL[Workforce Limit Check]
  GAP[Capability Gap Analysis]
  DSG[Design Agents from Gaps]
  APR[Submit Expansion Request]
  DEC{Approved?}
  CRT[Create Agent]
  CMP[Complete Expansion]
  OUT[Return results[]]

  X --> GV --> WL --> GAP --> DSG --> APR --> DEC
  DEC -- yes --> CRT --> CMP --> OUT
  DEC -- no --> OUT
```

## Verification Summary

- Platform architecture is operational end-to-end for orchestration, collaboration, learning, economy, simulation, and stability APIs.
- Real OpenAI path is wired but currently blocked in this environment by account quota (`insufficient_quota`).
- Hybrid onboarding implementation is active and non-blocking: fixed bootstrap + research-driven expansion attempt.

## Recommended Next Live Validation

1. Recharge/enable OpenAI billing quota and rerun both smoke scripts.
2. Add Anthropic/Mistral keys, then rerun capability check and route-specific AI goal tests.
3. Add one dedicated script that sets `adapterConfig.aiRuntime` per provider and verifies successful step completion without fallback.
