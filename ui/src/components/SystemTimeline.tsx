import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, CircleCheck, CircleDot, CircleX, ExternalLink, TriangleAlert } from "lucide-react";
import type { ExecutionFeedEventResponse } from "../api/system-controls";
import { systemControlsApi } from "../api/system-controls";
import {
  extractEvidence,
  formatRelativeTime,
  getEventReason,
  getExecutionStatusLabel,
  getExecutionStatusTone,
  toTitleCase,
} from "../lib/execution-feed";
import { queryKeys } from "../lib/queryKeys";
import { ExecutionStatusBadge } from "./ExecutionStatusBadge";

interface SystemTimelineProps {
  companyId: string;
}

interface TimelineCycle {
  id: string;
  cycleType: string;
  startedAt: string | null;
  completedAt: string | null;
  status: ExecutionFeedEventResponse["status"];
  events: ExecutionFeedEventResponse[];
}

function eventTitle(event: ExecutionFeedEventResponse): string {
  if (event.action === "cycle.execution.plan") return "Cycle planned";
  if (event.action === "cycle.execution.result") return "Cycle completed";
  if (event.action === "distribution.reddit.posted") return "Reddit post published";
  if (event.action === "billing.checkout.created") return "Checkout link created";
  if (event.action.startsWith("email.sequence.") && event.action.endsWith(".sent")) return "Email sequence sent";
  if (event.action === "decision.execution.awaiting_approval") return "Decision awaiting approval";
  if (event.action === "decision.execution.result") return "Decision executed";
  if (event.action === "traffic.execution.awaiting_approval") return "Traffic awaiting approval";
  if (event.action === "cycle.execution.step.failed") return "Cycle step failed";
  return toTitleCase(event.message || event.action);
}

function iconForStatus(status: ExecutionFeedEventResponse["status"]) {
  const tone = getExecutionStatusTone(status);
  if (tone === "success") return CircleCheck;
  if (tone === "failed") return CircleX;
  if (tone === "blocked") return TriangleAlert;
  if (tone === "pending") return CircleDot;
  if (tone === "skipped") return TriangleAlert;
  return CircleDot;
}

function statusClass(status: ExecutionFeedEventResponse["status"]): string {
  const tone = getExecutionStatusTone(status);
  if (tone === "success") return "text-green-600 dark:text-green-400";
  if (tone === "failed") return "text-red-600 dark:text-red-400";
  if (tone === "blocked") return "text-yellow-600 dark:text-yellow-400";
  if (tone === "pending") return "text-blue-600 dark:text-blue-400";
  if (tone === "skipped") return "text-sky-600 dark:text-sky-400";
  return "text-muted-foreground";
}

function buildTimeline(events: ExecutionFeedEventResponse[]): TimelineCycle[] {
  const ascending = [...events].sort((a, b) => {
    const aTs = new Date(a.createdAt).getTime();
    const bTs = new Date(b.createdAt).getTime();
    return aTs - bTs;
  });

  const cycles: TimelineCycle[] = [];
  let current: TimelineCycle | null = null;
  let cycleCount = 0;

  const pushCurrent = () => {
    if (!current) return;
    cycles.push(current);
    current = null;
  };

  for (const event of ascending) {
    const details = event.details ?? {};
    const cycleType = typeof details.cycleType === "string" ? details.cycleType : null;

    if (event.action === "cycle.execution.plan") {
      pushCurrent();
      cycleCount += 1;
      current = {
        id: `${event.id}-${cycleCount}`,
        cycleType: cycleType ?? "launch",
        startedAt: event.createdAt,
        completedAt: null,
        status: "pending",
        events: [event],
      };
      continue;
    }

    if (!current && cycleType) {
      cycleCount += 1;
      current = {
        id: `${event.id}-${cycleCount}`,
        cycleType,
        startedAt: event.createdAt,
        completedAt: null,
        status: event.status,
        events: [],
      };
    }

    if (!current) {
      current = {
        id: `background-${event.id}`,
        cycleType: "background",
        startedAt: event.createdAt,
        completedAt: null,
        status: event.status,
        events: [],
      };
      cycleCount += 1;
    }

    current.events.push(event);

    if (event.action === "cycle.execution.result") {
      const resultStatus = typeof details.status === "string" ? details.status : event.status;
      if (
        resultStatus === "success"
        || resultStatus === "failed"
        || resultStatus === "pending"
        || resultStatus === "blocked"
        || resultStatus === "skipped"
        || resultStatus === "info"
      ) {
        current.status = resultStatus;
      } else {
        current.status = event.status;
      }
      current.completedAt = event.createdAt;
      continue;
    }

    current.status = event.status;
  }

  pushCurrent();

  return cycles.reverse().slice(0, 8);
}

export function SystemTimeline({ companyId }: SystemTimelineProps) {
  const timelineQuery = useQuery({
    queryKey: queryKeys.executionFeed(companyId, "all", "all", 180),
    queryFn: () => systemControlsApi.getExecutionFeed(companyId, { limit: 180 }),
    enabled: !!companyId,
    refetchInterval: 8_000,
  });

  const cycles = useMemo(() => buildTimeline(timelineQuery.data ?? []), [timelineQuery.data]);

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">System Story Timeline</h2>
          <p className="text-xs text-muted-foreground">Narrative view of each cycle so you can follow progression, blocks, and outcomes.</p>
        </div>
        <span className="text-xs text-muted-foreground">{cycles.length} cycles</span>
      </div>

      <div className="mt-3 space-y-3">
        {timelineQuery.isLoading && cycles.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-5 text-sm text-muted-foreground">
            Building timeline...
          </div>
        ) : cycles.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-5 text-sm text-muted-foreground">
            No cycle story yet. Trigger a cycle to populate the narrative.
          </div>
        ) : (
          cycles.map((cycle, index) => (
            <article key={cycle.id} className="rounded-lg border border-border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {cycle.cycleType === "background"
                      ? `Background Story ${cycles.length - index}`
                      : `Cycle ${cycles.length - index} - ${toTitleCase(cycle.cycleType)}`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {cycle.startedAt ? `Started ${formatRelativeTime(cycle.startedAt)}` : "Start time unavailable"}
                    {cycle.completedAt ? ` | Completed ${formatRelativeTime(cycle.completedAt)}` : " | In progress"}
                  </p>
                </div>
                <ExecutionStatusBadge status={cycle.status} />
              </div>

              <div className="space-y-1 px-3 py-2">
                {cycle.events.map((event) => {
                  const Icon = iconForStatus(event.status);
                  const reason = getEventReason(event);
                  const evidence = extractEvidence(event);
                  return (
                    <details key={event.id} className="rounded-md border border-border/80 bg-background/30 px-2.5 py-2">
                      <summary className="flex cursor-pointer list-none items-start justify-between gap-2">
                        <div className="flex min-w-0 items-start gap-2">
                          <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${statusClass(event.status)}`} />
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-foreground">{eventTitle(event)}</p>
                            <p className="text-xs text-muted-foreground">{formatRelativeTime(event.createdAt)}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="hidden text-[11px] font-medium text-muted-foreground sm:inline">
                            {getExecutionStatusLabel(event.status)}
                          </span>
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                      </summary>

                      <div className="mt-2 space-y-2 border-t border-border pt-2">
                        <p className="text-xs text-muted-foreground">Message: <span className="text-foreground">{event.message || toTitleCase(event.action)}</span></p>
                        {reason ? (
                          <p className="text-xs text-muted-foreground">Reason: <span className="text-foreground">{reason}</span></p>
                        ) : null}
                        {evidence?.url ? (
                          <p className="text-xs text-muted-foreground">
                            Link:{" "}
                            <a
                              href={evidence.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              {evidence.url}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </p>
                        ) : null}
                        <pre className="max-h-44 overflow-auto rounded bg-muted/40 p-2 text-[11px] text-muted-foreground">
                          {JSON.stringify(event.details, null, 2)}
                        </pre>
                      </div>
                    </details>
                  );
                })}
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
