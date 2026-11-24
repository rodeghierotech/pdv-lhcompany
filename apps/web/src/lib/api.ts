import type { ApiErrorBody } from '@pdv/shared';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3333';
const TOKEN_KEY = 'pdv.token';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
  /** Falha de rede/servidor indisponível (candidata a retentativa), ao contrário de erro de negócio. */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // armazenamento indisponível: a sessão vale apenas até recarregar
  }
}

/** Notificado a cada requisição: true = servidor respondeu; false = falha de rede. */
let onReachability: ((reachable: boolean) => void) | null = null;
export function setReachabilityHandler(fn: ((reachable: boolean) => void) | null): void {
  onReachability = fn;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    query?: Record<string, unknown>;
    /** false: não envia o JWT nem trata 401 como logout (ex.: sincronização autenticada por grant). */
    auth?: boolean;
  } = {},
): Promise<T> {
  const url = new URL(path, API_URL);
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined && v !== '' && v !== null) url.searchParams.set(k, String(v));
  }
  const token = options.auth === false ? null : getToken();
  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    onReachability?.(false);
    throw new ApiError(0, 'NETWORK', 'Sem conexão com o servidor');
  }
  onReachability?.(true);
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    if (res.status === 401 && token) onUnauthorized?.();
    throw new ApiError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `Erro ${res.status}`,
      err?.details,
    );
  }
  return data as T;
}

/** Baixa um arquivo autenticado (ex.: CSV) e dispara o download no navegador. */
export async function apiDownload(
  path: string,
  query: Record<string, unknown>,
  fallbackName: string,
): Promise<void> {
  const url = new URL(path, API_URL);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '' && v !== null) url.searchParams.set(k, String(v));
  }
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Sem conexão com o servidor');
  }
  if (!res.ok) {
    let err: ApiErrorBody['error'] | undefined;
    try {
      err = ((await res.json()) as ApiErrorBody).error;
    } catch {
      /* corpo não JSON */
    }
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Erro ${res.status}`);
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const objectUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
