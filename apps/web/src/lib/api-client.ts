export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

const publicMessages: Record<string, string> = {
  INVALID_REQUEST: "Dados da requisição inválidos. Confira os campos e tente novamente.",
  PRODUCT_CONFLICT: "Já existe uma variante com este SKU ou código de barras.",
  OPERATION_PAYLOAD_CONFLICT: "Esta operação já foi registrada com dados diferentes. Confira antes de tentar novamente.",
  PRODUCT_NOT_FOUND: "Produto não encontrado.",
  INVENTORY_VARIANT_NOT_FOUND: "Variante não encontrada.",
  INVENTORY_OPERATION_NOT_ALLOWED: "A reposição exige produto e variante ativos com controle de estoque.",
  INTERNAL_ERROR: "Não foi possível concluir a operação no servidor. Tente novamente.",
};

function responseError(status: number, body: unknown): ApiError {
  // Never display server text: even a structured error may contain infrastructure secrets.
  const code = typeof body === "object" && body !== null && "code" in body
    && typeof body.code === "string" && Object.hasOwn(publicMessages, body.code)
    ? body.code : "HTTP_ERROR";
  return new ApiError(status, code, publicMessages[code] ?? (
    status === 409 ? "A operação entrou em conflito. Confira os dados antes de tentar novamente."
      : "Não foi possível concluir a operação no servidor. Tente novamente."
  ));
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = import.meta.env.VITE_API_BASE_URL?.trim() || (import.meta.env.DEV ? "/api" : "");
  if (!base) throw new ApiError(0, "API_NOT_CONFIGURED", "A conexão com a API não está configurada.");
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  let response: Response;
  let text: string;
  try {
    response = await fetch(`${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`, { ...init, headers });
    text = await response.text();
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Não foi possível conectar à API. Verifique sua conexão e tente novamente.");
  }

  let body: unknown;
  try {
    body = text.trim() ? JSON.parse(text) : undefined;
  } catch {
    if (!response.ok) throw responseError(response.status, undefined);
    throw new ApiError(response.status, "INVALID_RESPONSE", "A API retornou uma resposta inválida. Tente novamente.");
  }
  if (!response.ok) throw responseError(response.status, body);
  return body as T;
}
