import { Package } from "lucide-react";
import { useState } from "react";
import { AdminShell } from "./components/shared/AdminShell";
import { FeedbackMessage } from "./components/shared/FeedbackMessage";
import { ResponsiveNavigation } from "./components/shared/ResponsiveNavigation";
import { ProductCatalogPage } from "./features/products/pages/ProductCatalogPage";
import { CreateProductPage } from "./features/products/pages/CreateProductPage";

const navigation = [{ id: "products", label: "Produtos", icon: Package, shortcut: "p" }];

export function App() {
  const [notice, setNotice] = useState<{ text: string; variant: "info" | "success" } | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <AdminShell
      title="PDV LH Company"
      description="Operação da loja"
      navigation={<ResponsiveNavigation items={navigation} activeItem="products" onNavigate={() => setNotice(null)} />}
    >
      {notice && <FeedbackMessage variant={notice.variant} className="mb-4">{notice.text}</FeedbackMessage>}
      {creating ? <CreateProductPage
        onCreated={() => { setCreating(false); setNotice({ text: "Produto e variantes confirmados no servidor.", variant: "success" }); }}
        onCancel={() => { setCreating(false); setNotice(null); }}
      /> : <ProductCatalogPage
        onCreateProduct={() => { setNotice(null); setCreating(true); }}
        onSelectVariant={() => setNotice({ text: "O detalhe da variante e o histórico de estoque serão disponibilizados na próxima etapa.", variant: "info" })}
      />}
    </AdminShell>
  );
}
