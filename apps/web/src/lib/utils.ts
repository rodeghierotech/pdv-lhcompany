import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Chave de idempotência gerada no cliente; reutilizada em reenvios da mesma ação. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

/** Data pura (AAAA-MM-DD) sem conversão de fuso, para vencimentos. */
export function formatDateOnly(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}
