import type { PropsWithChildren, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type AdminShellProps = PropsWithChildren<{
  title: string;
  description?: string;
  navigation?: ReactNode;
  actions?: ReactNode;
}>;

export function AdminShell({ children, description, title, navigation, actions }: AdminShellProps) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <a href="#main-content" className="sr-only rounded-control bg-surface p-3 text-sm font-medium focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-30">
        Pular para o conteúdo
      </a>
      <div className="md:flex">
        {navigation}
        <div className="min-w-0 flex-1">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 md:px-6">
            <div className="min-w-0">
              <p className="text-base font-semibold">{title}</p>
              {description && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </header>
          <main
            id="main-content"
            tabIndex={-1}
            className={cn("mx-auto w-full max-w-screen-2xl px-4 py-5 md:px-6 md:py-6", navigation && "pb-navigation-offset md:pb-6")}
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
