import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Boxes, Package } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { ResponsiveNavigation } from "./ResponsiveNavigation";

const items = [
  { id: "produtos", label: "Produtos", icon: Package, shortcut: "p" },
  { id: "estoque", label: "Estoque", icon: Boxes, shortcut: "e" },
];

function renderNavigation() {
  const onNavigate = vi.fn();
  render(<ResponsiveNavigation items={items} activeItem="produtos" onNavigate={onNavigate} />);
  return onNavigate;
}

describe("ResponsiveNavigation", () => {
  it("names the navigation and its controls without duplicate responsive copies", () => {
    renderNavigation();
    expect(screen.getByRole("navigation", { name: "Navegação principal" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Produtos" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Estoque" })).toHaveAttribute("aria-keyshortcuts", "Alt+e");
  });

  it("marks only the active page and updates when its prop changes", () => {
    const { rerender } = render(<ResponsiveNavigation items={items} activeItem="produtos" onNavigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Produtos" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Estoque" })).not.toHaveAttribute("aria-current");
    rerender(<ResponsiveNavigation items={items} activeItem="estoque" onNavigate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Estoque" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Produtos" })).not.toHaveAttribute("aria-current");
  });

  it("navigates on click", async () => {
    const user = userEvent.setup();
    const onNavigate = renderNavigation();
    await user.click(screen.getByRole("button", { name: "Estoque" }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("estoque");
  });

  it("supports Tab, Enter and Space on native buttons without optional shortcuts", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<ResponsiveNavigation items={[{ id: "produtos", label: "Produtos", icon: Package }]} activeItem="produtos" onNavigate={onNavigate} />);
    await user.tab();
    // jsdom has no responsive CSS; the desktop collapse control may be first.
    if (document.activeElement !== screen.getByRole("button", { name: "Produtos" })) await user.tab();
    expect(screen.getByRole("button", { name: "Produtos" })).toHaveFocus();
    await user.keyboard("{Enter} ");
    expect(onNavigate.mock.calls).toEqual([["produtos"], ["produtos"]]);
  });

  it("navigates with an advertised Alt shortcut, never with bare typing", () => {
    const onNavigate = renderNavigation();
    fireEvent.keyDown(document.body, { key: "e" });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "E", altKey: true });
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("estoque");
  });

  it.each(["input", "textarea", "select"])("suspends shortcuts while focus is inside %s", (tag) => {
    const onNavigate = renderNavigation();
    const field = document.createElement(tag);
    document.body.append(field);
    field.focus();
    fireEvent.keyDown(field, { key: "e", altKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "e", altKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
    field.remove();
    fireEvent.keyDown(document.body, { key: "e", altKey: true });
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("estoque");
  });

  it.each(["true", "", "plaintext-only"])("suspends shortcuts in contenteditable=%s descendants", (value) => {
    const onNavigate = renderNavigation();
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", value);
    const child = document.createElement("span");
    editor.append(child);
    document.body.append(editor);
    editor.focus();
    fireEvent.keyDown(child, { key: "e", altKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
    editor.remove();
  });

  it("ignores repeat, composition and conflicting modifier keys", () => {
    const onNavigate = renderNavigation();
    for (const extra of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      fireEvent.keyDown(document.body, { key: "e", altKey: true, ...extra });
    }
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("keeps names and shortcuts available when the desktop rail is collapsed", async () => {
    const user = userEvent.setup();
    renderNavigation();
    await user.click(screen.getByRole("button", { name: "Recolher navegação" }));
    expect(screen.getByRole("button", { name: "Expandir navegação" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Produtos" })).toHaveTextContent("Produtos");
    expect(screen.getByRole("button", { name: "Estoque" })).toHaveTextContent("Alt+E");
  });

  it("removes its shortcut listener when unmounted", () => {
    const onNavigate = vi.fn();
    const { unmount } = render(<ResponsiveNavigation items={items} activeItem="produtos" onNavigate={onNavigate} />);
    unmount();
    fireEvent.keyDown(document.body, { key: "e", altKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
