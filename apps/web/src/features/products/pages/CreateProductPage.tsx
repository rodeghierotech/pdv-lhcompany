import type { Product } from "@lh-company/contracts";
import { createProduct } from "../api/products-api";
import { ProductForm } from "../components/ProductForm";

export interface CreateProductPageProps {
  onCreated: (product: Product) => void;
  onCancel: () => void;
}

export function CreateProductPage({ onCreated, onCancel }: CreateProductPageProps) {
  return (
    <section aria-labelledby="create-product-title" className="space-y-5">
      <h1 id="create-product-title" className="text-xl font-semibold">Novo produto</h1>
      <ProductForm onCancel={onCancel} onSubmit={async (command) => {
        const product = await createProduct(command);
        onCreated(product);
      }} />
    </section>
  );
}
