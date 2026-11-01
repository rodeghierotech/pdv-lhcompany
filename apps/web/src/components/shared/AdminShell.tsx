import type { PropsWithChildren } from "react";

type AdminShellProps = PropsWithChildren<{
  title: string;
  description: string;
}>;

export function AdminShell({ children, description, title }: AdminShellProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-surface px-6 py-4">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </header>
      <main className="mx-auto w-full max-w-screen-2xl px-6 py-6">{children}</main>
    </div>
  );
}
