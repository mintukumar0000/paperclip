# Hybrid Cycle Architecture

This document defines the runtime architecture for deterministic cycle execution with optimizer-driven iteration.

## 1. Core Runtime Model

```mermaid
flowchart TD
  A[runFullCycle(goal, mode)] --> B[Real-World Side Effects]
  B --> C[Outcome Verification]
  C --> D[Continuous Thinking]
  D --> E[decideNextCycle(metrics)]
  E --> F[runFullCycle(goal, nextMode)]
  F --> B
```

Key property: continuous thinking no longer executes ad-hoc direct actions. It only selects the next deterministic cycle mode.

## 2. Deterministic Full Cycle

```mermaid
flowchart LR
  S[Start runFullCycle] --> R[runResearch]
  R --> G[generateStrategy]
  G --> L[generateLanding]
  L --> D[deployLanding]
  D --> T[runTraffic]
  T --> E[runEmailSequence]
  E --> V[setupTracking + verifyOutcome]
  V --> X[Return success + tracking summary]
```

Fail-fast rule:
- Any step failure aborts the cycle and returns an exception.
- No queue dependence is used inside runFullCycle.
- No background loops are required to advance steps.

## 3. Mode Selection Logic

```mermaid
flowchart TD
  M[Metrics Snapshot] --> C{Conversion normalized}
  C --> T{traffic < 100}
  T -- yes --> L1[launch]
  T -- no --> I{conversion < 0.02}
  I -- yes --> L2[improve]
  I -- no --> S{revenue < 100}
  S -- yes --> L3[scale]
  S -- no --> L4[dominate]
```

## 4. Governance + Reliability Hardening

```mermaid
flowchart LR
  Q[Execution Loop Claim Issue] --> DQ[Dispatch to Queue]
  DQ -->|failure| RB[Rollback issue to todo + unassign]
  DQ -->|success| WK[Agent Worker Executes]

  TR[Tool Router] --> AG[actionGuard]
  AG -->|approval_required| BLK[Hard block]
  AG -->|forbidden| BLK
  AG -->|allowed| EX[Execute tool]

  SV[Server Startup] --> AW[Start Agent Worker in-process]
  SV --> DW[Start Decision Worker]
```

## 5. Objective Function Gate (RPV)

```mermaid
flowchart TD
  P[Proposed decision actions] --> RPV[Compute current RPV]
  RPV --> F[Estimate projected RPV per action]
  F --> G{projected <= current}
  G -- yes --> RJ[Reject action]
  G -- no --> AC[Allow action]
  AC --> EX[Execute]
```

The decision engine now rejects non-RPV-improving actions before execution.

## 6. Verification Surfaces

Outcome verification now provides deterministic summaries for:
- Landing: visitors, signups, conversionRate, success
- Reddit: posts, replies, upvotes, comments, success
- Email: emailsSent, openRate/clickRate availability, success

## 7. End-to-End Runtime Connection Map

```mermaid
flowchart TB
  subgraph Scheduler Layer
    CT[continuousThinking interval]
  end

  subgraph Deterministic Engine
    RFC[runFullCycle]
    CC[cycleController decideNextCycle]
    VO[verifyOutcome]
  end

  subgraph Execution Layer
    EL[executionLoop]
    AQ[agentQueue]
    AW[agentWorker]
    EXE[AI Executor + Tools]
  end

  subgraph Revenue Layer
    WL[waitlist routes]
    BH[billing webhook]
    CF[company finance]
    DE[decision engine]
  end

  CT --> CC
  CC --> RFC
  RFC --> EXE
  RFC --> VO

  EL --> AQ --> AW --> EXE
  EL --> DE
  DE --> RFC

  WL --> BH --> CF --> DE
```
