/** Todo valor monetário do sistema é um inteiro em centavos. */

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(cents: number): string {
  return brl.format(cents / 100);
}

/**
 * Converte texto digitado ("1.234,56", "12,5", "12") em centavos.
 * Retorna null quando o texto não representa um valor monetário válido.
 */
export function parseBRLToCents(input: string): number | null {
  const cleaned = input.replace(/[R$\s]/g, '');
  if (cleaned === '') return null;
  // Formato pt-BR: ponto = milhar, vírgula = decimal.
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+(,\d{1,2})?$/.test(cleaned)) return null;
  const [intPart = '0', decPart = ''] = cleaned.replace(/\./g, '').split(',');
  const cents = Number(intPart) * 100 + Number(decPart.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Aplica desconto percentual (em pontos-base: 1000 = 10%) arredondando para o centavo mais próximo. */
export function applyPercentDiscount(cents: number, basisPoints: number): number {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError('cents inválido');
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new RangeError('desconto inválido');
  }
  return cents - Math.round((cents * basisPoints) / 10_000);
}
