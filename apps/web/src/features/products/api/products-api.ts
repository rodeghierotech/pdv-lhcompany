import { ProductCatalogItemSchema, ProductCatalogQuerySchema, type ProductCatalogItem, type ProductCatalogQuery } from "@lh-company/contracts";
import { ApiError, requestJson } from "../../../lib/api-client";

export async function listProducts(query: ProductCatalogQuery): Promise<ProductCatalogItem[]> {
  const parsedQuery = ProductCatalogQuerySchema.safeParse(query);
  if (!parsedQuery.success) throw new ApiError(0, "INVALID_REQUEST", "Confira os filtros do catálogo e tente novamente.");
  const { search, lowStockOnly, status, limit } = parsedQuery.data;
  const params = new URLSearchParams({ search, lowStockOnly: String(lowStockOnly), status, limit: String(limit) });
  const body = await requestJson<unknown>(`/products?${params}`);
  const result = ProductCatalogItemSchema.array().safeParse(body);
  if (!result.success) throw new ApiError(200, "INVALID_RESPONSE", "A API retornou dados de catálogo inválidos. Tente novamente.");
  return result.data;
}
