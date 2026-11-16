import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { FeedbackMessage } from "./FeedbackMessage";
import { TextField } from "./TextField";

describe("shared controls", () => {
  it("blocks repeated clicks and exposes loading state", async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Salvar produto</Button>);
    const button = screen.getByRole("button", { name: /Salvar produto/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not submit a surrounding form by default", () => {
    render(<Button>Voltar</Button>);
    expect(screen.getByRole("button", { name: "Voltar" })).toHaveAttribute("type", "button");
  });

  it("associates label, hint and error and retains the field value", () => {
    const { rerender } = render(<TextField label="SKU" hint="Código único" defaultValue="CAM-01" />);
    const input = screen.getByRole("textbox", { name: "SKU" });
    expect(input).toHaveAccessibleDescription("Código único");
    rerender(<TextField label="SKU" hint="Código único" error="SKU já cadastrado" defaultValue="CAM-01" />);
    expect(input).toHaveValue("CAM-01");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Código único SKU já cadastrado");
  });

  it("preserves external aria descriptions", () => {
    render(<><p id="context">Obrigatório no catálogo</p><TextField label="Nome" aria-describedby="context" hint="Nome da peça" /></>);
    expect(screen.getByRole("textbox", { name: "Nome" })).toHaveAccessibleDescription("Obrigatório no catálogo Nome da peça");
  });

  it("announces errors as alerts and confirmations as status with text", () => {
    const { rerender } = render(<FeedbackMessage variant="error">Falha ao salvar. Tente novamente.</FeedbackMessage>);
    expect(screen.getByRole("alert")).toHaveTextContent("Falha ao salvar. Tente novamente.");
    rerender(<FeedbackMessage variant="success">Produto salvo no servidor.</FeedbackMessage>);
    expect(screen.getByRole("status")).toHaveTextContent("Produto salvo no servidor.");
  });
});
