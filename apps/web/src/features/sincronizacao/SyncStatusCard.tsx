import { Cloud, CloudOff } from "lucide-react";

import type { SyncStatus } from "./sync-status";

type SyncStatusCardProps = {
  status: SyncStatus;
};

export function SyncStatusCard({ status }: SyncStatusCardProps) {
  const Icon = status.kind === "configuration_required" ? CloudOff : Cloud;

  return (
    <section
      aria-labelledby="sync-status-title"
      className="border-border bg-surface rounded-lg border p-4"
    >
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className="text-muted-foreground size-5" />
        <div className="space-y-1">
          <h2 id="sync-status-title" className="text-sm font-semibold">
            Sincronização: {status.label}
          </h2>
          <p className="text-muted-foreground text-sm">{status.description}</p>
        </div>
      </div>
    </section>
  );
}
