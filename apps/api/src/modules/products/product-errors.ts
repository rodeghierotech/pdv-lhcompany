export class ProductConflictError extends Error {
  readonly code = "PRODUCT_CONFLICT";

  constructor() {
    super("Já existe uma variante com este SKU ou código de barras.");
    this.name = "ProductConflictError";
  }
}

export class OperationPayloadConflictError extends Error {
  readonly code = "OPERATION_PAYLOAD_CONFLICT";

  constructor() {
    super("Esta operação já foi registrada com dados diferentes.");
    this.name = "OperationPayloadConflictError";
  }
}

export class ProductNotFoundError extends Error {
  readonly code = "PRODUCT_NOT_FOUND";

  constructor() {
    super("Produto não encontrado.");
    this.name = "ProductNotFoundError";
  }
}
