import { AdminShell } from "./components/shared/AdminShell";

export function App() {
  return (
    <AdminShell
      title="PDV LH Company"
      description="Base administrativa da Rodeghiero Tech"
    >
      <section aria-labelledby="foundation-title" className="space-y-2">
        <h1 id="foundation-title" className="text-lg font-semibold text-foreground">
          Fundação técnica pronta para os módulos operacionais
        </h1>
        <p className="text-sm text-muted-foreground">
          Produtos, vendas, caixa e sincronização serão adicionados em etapas.
        </p>
      </section>
    </AdminShell>
  );
}
