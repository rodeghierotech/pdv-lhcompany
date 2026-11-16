// Both domains expose the same operation replay conflict and public error code.
export { OperationPayloadConflictError } from "../products/product-errors.js";

export class InventoryVariantNotFoundError extends Error {
  readonly code = "INVENTORY_VARIANT_NOT_FOUND";

  constructor() {
    super("Variante não encontrada.");
    this.name = "InventoryVariantNotFoundError";
  }
}

export class InventoryOperationNotAllowedError extends Error {
  readonly code = "INVENTORY_OPERATION_NOT_ALLOWED";

  constructor() {
    super("A reposição exige produto e variante ativos com controle de estoque.");
    this.name = "InventoryOperationNotAllowedError";
  }
}
