import { Package } from "lucide-react";
import { useState } from "react";
import { AdminShell } from "./components/shared/AdminShell";
import { FeedbackMessage } from "./components/shared/FeedbackMessage";
import { ResponsiveNavigation } from "./components/shared/ResponsiveNavigation";
import { ProductCatalogPage } from "./features/products/pages/ProductCatalogPage";
import { CreateProductPage } from "./features/products/pages/CreateProductPage";
import { VariantInventoryPage } from "./features/inventory/pages/VariantInventoryPage";

const navigation = [{ id: "products", label: "Produtos", icon: Package, shortcut: "p" }];

export function App() {
  const [notice, setNotice] = useState<{ text: string; variant: "info" | "success" } | null>(null);
  const [creating, setCreating] = useState(false);
  const [variantId, setVariantId] = useState<string | null>(null);
  return (
    <AdminShell
      title="PDV LH Company"
      description="Operação da loja"
      navigation={<ResponsiveNavigation items={navigation} activeItem="products" onNavigate={() => {
        setNotice(null); setCreating(false); setVariantId(null);
      }} />}
    >
      {notice && <FeedbackMessage variant={notice.variant} className="mb-4">{notice.text}</FeedbackMessage>}
      {variantId ? <VariantInventoryPage key={variantId} variantId={variantId} onBack={() => { setVariantId(null); setNotice(null); }} /> : creating ? <CreateProductPage
        onCreated={() => { setCreating(false); setNotice({ text: "Produto e variantes confirmados no servidor.", variant: "success" }); }}
        onCancel={() => { setCreating(false); setNotice(null); }}
      /> : <ProductCatalogPage
        onCreateProduct={() => { setNotice(null); setCreating(true); }}
        onSelectVariant={(id) => { setNotice(null); setVariantId(id); }}
      />}
    </AdminShell>
  );
}
