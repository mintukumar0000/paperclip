import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const normalizedStatus = typeof status === "string" && status.trim().length > 0
    ? status
    : "unknown";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[normalizedStatus] ?? statusBadgeDefault
      )}
    >
      {normalizedStatus.replace(/_/g, " ")}
    </span>
  );
}
