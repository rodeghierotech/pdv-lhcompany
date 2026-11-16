import { CreateProductCommandSchema, ProductSchema, ProductCatalogItemSchema, ProductCatalogQuerySchema, type ProductCatalogItem, type ProductCatalogQuery, type CreateProductCommand, type Product } from "@lh-company/contracts";
import { ApiError, requestJson } from "../../../lib/api-client";

export async function createProduct(command: CreateProductCommand): Promise<Product> {
  const parsed = CreateProductCommandSchema.safeParse(command);
  if (!parsed.success) throw new ApiError(0, "INVALID_REQUEST", "Confira os campos do produto e das variantes.");
  const body = await requestJson<unknown>("/products", { method: "POST", body: JSON.stringify(parsed.data) });
  const result = ProductSchema.safeParse(body);
  if (!result.success) throw new ApiError(201, "INVALID_RESPONSE", "A API retornou dados de produto inválidos. Confira o catálogo antes de tentar novamente.");
  return result.data;
}

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
