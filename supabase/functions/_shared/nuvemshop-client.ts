import { z } from "npm:zod@3.24.1";

const NuvemshopVariantSchema = z.object({
  id: z.union([z.string(), z.number()]),
  sku: z.string().nullable().optional(),
  price: z.union([z.string(), z.number()]),
  cost: z.union([z.string(), z.number()]).nullable().optional(),
  stock_management: z.boolean().optional(),
  stock: z.number().optional(),
  inventory_levels: z.array(z.object({
    location_id: z.union([z.string(), z.number()]),
    stock: z.number(),
  })).optional(),
  values: z.array(z.string()).optional(),
});

const NuvemshopProductSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  variants: z.array(NuvemshopVariantSchema),
});

export type NuvemshopProduct = z.infer<typeof NuvemshopProductSchema>;

export async function fetchNuvemshopProducts(input: {
  storeId: string;
  accessToken: string;
  userAgent: string;
}): Promise<NuvemshopProduct[]> {
  const products: NuvemshopProduct[] = [];

  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `https://api.tiendanube.com/v1/${encodeURIComponent(input.storeId)}/products?page=${page}&per_page=30`,
      {
        headers: {
          Authentication: `bearer ${input.accessToken}`,
          "User-Agent": input.userAgent,
        },
      },
    );
    if (!response.ok) throw new Error(`Nuvemshop respondeu ${response.status}.`);

    const batch = z.array(NuvemshopProductSchema).parse(await response.json());
    products.push(...batch);
    if (batch.length < 30) return products;
  }
}
