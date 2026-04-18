import type { ExecutionFeedEventResponse } from "../api/system-controls";
import { cn } from "../lib/utils";
import { getExecutionStatusLabel, getExecutionStatusTone } from "../lib/execution-feed";

const TONE_CLASS: Record<string, string> = {
  success: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  blocked: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  pending: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  skipped: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  info: "bg-muted text-muted-foreground",
};

export function ExecutionStatusBadge({ status }: { status: ExecutionFeedEventResponse["status"] }) {
  const tone = getExecutionStatusTone(status);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide",
        TONE_CLASS[tone],
      )}
    >
      {getExecutionStatusLabel(status)}
    </span>
  );
}
