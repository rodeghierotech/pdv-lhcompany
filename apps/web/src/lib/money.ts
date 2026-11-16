export function parseBrazilianMoneyToCents(value: string): number {
  const input = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(input)) {
    throw new Error("Informe um valor como 189,90, sem sinal ou símbolo de moeda.");
  }
  const [whole = "", fraction = ""] = input.split(",");
  const cents = Number(`${whole.replaceAll(".", "")}${fraction.padEnd(2, "0")}`);
  if (!Number.isSafeInteger(cents)) throw new Error("Valor acima do limite permitido.");
  return cents;
}

export function formatCents(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error("O valor deve ser um inteiro seguro em centavos.");
  const digits = String(Math.abs(value)).padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${value < 0 ? "-" : ""}${whole},${digits.slice(-2)}`;
}
