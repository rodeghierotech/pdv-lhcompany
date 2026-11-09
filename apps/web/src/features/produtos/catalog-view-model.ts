export type CatalogImportStatus = "pending" | "completed" | "recoverable_failure" | "needs_review";

export function catalogFeedback(status: CatalogImportStatus) {
  const feedback = {
    pending: { title: "Importação pendente", confirmed: false },
    completed: { title: "Importação confirmada", confirmed: true },
    recoverable_failure: { title: "Falha recuperável na importação", confirmed: false },
    needs_review: { title: "Importação com pendências", confirmed: false },
  } as const;

  return feedback[status];
}
