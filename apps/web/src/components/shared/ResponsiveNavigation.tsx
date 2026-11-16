import { PanelLeftClose, PanelLeftOpen, type LucideIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "./Button";

export interface NavigationItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** One letter or number, activated with Alt. */
  shortcut?: string;
}

export interface ResponsiveNavigationProps {
  items: readonly NavigationItem[];
  activeItem: string;
  onNavigate: (itemId: string) => void;
}

function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select")) return true;
  const editable = target.closest("[contenteditable]");
  return editable !== null && editable.getAttribute("contenteditable") !== "false";
}

function shortcutFor(item: NavigationItem): string | undefined {
  return item.shortcut && /^[a-z0-9]$/i.test(item.shortcut) ? item.shortcut.toLowerCase() : undefined;
}

export function ResponsiveNavigation({ items, activeItem, onNavigate }: ResponsiveNavigationProps) {
  const [expanded, setExpanded] = useState(true);
  const listId = useId();

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented || event.repeat || event.isComposing ||
        !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        isEditing(event.target) || isEditing(document.activeElement)
      ) return;
      const item = items.find((candidate) => shortcutFor(candidate) === event.key.toLowerCase());
      if (!item) return;
      event.preventDefault();
      onNavigate(item.id);
    }
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [items, onNavigate]);

  const CollapseIcon = expanded ? PanelLeftClose : PanelLeftOpen;
  return (
    <nav
      aria-label="Navegação principal"
      className={cn(
        "fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface pb-safe-bottom md:sticky md:inset-x-auto md:top-0 md:h-dvh md:shrink-0 md:overflow-y-auto md:border-t-0 md:border-r md:p-3",
        expanded ? "md:w-navigation-wide" : "md:w-navigation-compact",
      )}
    >
      <Button
        variant="ghost"
        aria-label={expanded ? "Recolher navegação" : "Expandir navegação"}
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((value) => !value)}
        className="mb-4 hidden w-full justify-start px-2 text-muted-foreground md:inline-flex"
      >
        <CollapseIcon aria-hidden="true" className="size-4 shrink-0" />
        <span>{expanded ? "Recolher" : "Expandir"}</span>
      </Button>
      <ul id={listId} className="flex overflow-x-auto md:flex-col md:gap-1 md:overflow-x-visible">
        {items.map((item) => {
          const active = activeItem === item.id;
          const Icon = item.icon;
          const shortcut = shortcutFor(item);
          return (
            <li key={item.id} className="min-w-20 flex-1 md:min-w-0 md:flex-none">
              <Button
                variant="ghost"
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                aria-keyshortcuts={shortcut ? `Alt+${shortcut}` : undefined}
                onClick={() => onNavigate(item.id)}
                className={cn(
                  "min-h-16 w-full flex-col gap-1 rounded-none border-t-2 border-t-transparent px-2 py-2 text-xs focus-visible:-outline-offset-4 md:min-h-11 md:flex-row md:justify-start md:gap-2 md:rounded-control md:border-t-0 md:border-l-2 md:border-l-transparent md:text-sm",
                  active && "border-t-primary bg-accent font-semibold text-primary md:border-l-primary",
                )}
              >
                <Icon aria-hidden="true" className="size-5 shrink-0 md:size-4" />
                <span className="min-w-0 break-words md:flex-1 md:text-left">{item.label}</span>
                {shortcut && <kbd aria-hidden="true" className="hidden shrink-0 font-sans text-xs font-normal text-muted-foreground md:inline">Alt+{shortcut.toUpperCase()}</kbd>}
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
