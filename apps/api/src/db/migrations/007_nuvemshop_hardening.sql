-- Fase 9 (revisão): lote de envio com resultado incerto, dedupe de eventos e novos tipos de pendência.

-- Lote de envio de estoque: gravado ANTES da chamada. Se a resposta HTTP se perder, o reenvio compara
-- a leitura do remoto com (base, delta) do lote e nunca aplica o mesmo delta duas vezes.
alter table integration_outbox
  add column batch_id uuid,
  add column batch_base integer,
  add column batch_delta integer;
create index integration_outbox_batch_idx on integration_outbox (link_id, batch_id) where batch_id is not null;

-- Dedupe de webhooks só contra eventos AINDA NÃO iniciados: uma reentrega que chega durante o
-- processamento (que já leu o estado antigo do pedido) precisa gerar nova leitura.
drop index integration_events_dedupe_uq;
create unique index integration_events_dedupe_uq on integration_events (dedupe_key) where status = 'pendente';

alter table integration_issues drop constraint integration_issues_kind_check;
alter table integration_issues add constraint integration_issues_kind_check
  check (kind in ('sem_estoque', 'item_nao_mapeado', 'estoque_divergente', 'reembolso_revisar', 'pedido_editado',
                  'estoque_remoto_insuficiente', 'multiplas_locations', 'envio_incerto'));
