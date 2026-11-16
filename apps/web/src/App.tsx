import { Package } from "lucide-react";
import { useState } from "react";
import { AdminShell } from "./components/shared/AdminShell";
import { FeedbackMessage } from "./components/shared/FeedbackMessage";
import { ResponsiveNavigation } from "./components/shared/ResponsiveNavigation";
import { ProductCatalogPage } from "./features/products/pages/ProductCatalogPage";

const navigation = [{ id: "products", label: "Produtos", icon: Package, shortcut: "p" }];

export function App() {
  const [notice, setNotice] = useState("");
  return (
    <AdminShell
      title="PDV LH Company"
      description="Operação da loja"
      navigation={<ResponsiveNavigation items={navigation} activeItem="products" onNavigate={() => setNotice("")} />}
    >
      {notice && <FeedbackMessage className="mb-4">{notice}</FeedbackMessage>}
      <ProductCatalogPage
        onCreateProduct={() => setNotice("O cadastro de produtos será disponibilizado na próxima etapa.")}
        onSelectVariant={() => setNotice("O detalhe da variante e o histórico de estoque serão disponibilizados na próxima etapa.")}
      />
    </AdminShell>
  );
}
