CREATE TABLE public.catalog_import_operation (
  operation_id UUID PRIMARY KEY,
  import_id UUID NOT NULL REFERENCES public.catalog_import(id),
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  variant_id UUID REFERENCES public.product_variant(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('imported', 'linked', 'needs_review')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.catalog_import_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_import_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY "Members read catalog import operations" ON public.catalog_import_operation
  FOR SELECT TO authenticated USING (public.is_organization_member(organization_id));

CREATE OR REPLACE FUNCTION public.apply_nuvemshop_catalog_candidate(
  import_id UUID,
  candidate JSONB,
  operation_id UUID,
  actor_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  organization_uuid UUID;
  external_product TEXT;
  external_variant TEXT;
  product_name TEXT;
  sku_value TEXT;
  sale_price INTEGER;
  cost_value INTEGER;
  stock_quantity INTEGER;
  tracks_stock BOOLEAN;
  needs_cost_review BOOLEAN;
  variant_uuid UUID;
  product_uuid UUID;
  lot_uuid UUID;
  balance_quantity INTEGER;
  stored_outcome TEXT;
BEGIN
  SELECT catalog.organization_id INTO organization_uuid
  FROM public.catalog_import AS catalog
  WHERE catalog.id = apply_nuvemshop_catalog_candidate.import_id
  FOR UPDATE;
  IF organization_uuid IS NULL THEN RAISE EXCEPTION 'Importação não encontrada'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_member
    WHERE organization_id = organization_uuid AND user_id = apply_nuvemshop_catalog_candidate.actor_id
  ) THEN RAISE EXCEPTION 'Usuário sem acesso à organização'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(operation_id::TEXT, 0));
  SELECT operation.outcome, operation.variant_id INTO stored_outcome, variant_uuid
  FROM public.catalog_import_operation AS operation
  WHERE operation.operation_id = apply_nuvemshop_catalog_candidate.operation_id;
  IF stored_outcome IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', stored_outcome, 'variant_id', variant_uuid, 'replayed', TRUE);
  END IF;

  external_product := NULLIF(trim(candidate->>'externalProductId'), '');
  external_variant := NULLIF(trim(candidate->>'externalVariantId'), '');
  product_name := NULLIF(trim(candidate->>'name'), '');
  sku_value := NULLIF(trim(candidate->>'sku'), '');
  sale_price := (candidate->>'salePriceInCents')::INTEGER;
  cost_value := (candidate->>'costInCents')::INTEGER;
  stock_quantity := (candidate->>'stockQuantity')::INTEGER;
  tracks_stock := COALESCE((candidate->>'tracksInventory')::BOOLEAN, TRUE);
  needs_cost_review := COALESCE((candidate->>'requiresCostReview')::BOOLEAN, FALSE);

  IF external_product IS NULL OR external_variant IS NULL OR product_name IS NULL OR sku_value IS NULL
    OR sale_price IS NULL OR cost_value IS NULL OR stock_quantity IS NULL
    OR sale_price < 0 OR cost_value < 0 OR stock_quantity < 0 THEN
    RAISE EXCEPTION 'Candidato de importação inválido';
  END IF;

  SELECT mapping.variant_id INTO variant_uuid
  FROM public.external_variant_mapping AS mapping
  WHERE mapping.organization_id = organization_uuid
    AND mapping.source = 'nuvemshop'
    AND mapping.external_variant_id = external_variant;

  IF variant_uuid IS NOT NULL THEN
    INSERT INTO public.catalog_pending_review (organization_id, import_id, sku, reason)
    VALUES (organization_uuid, import_id, sku_value, 'Variante já vinculada: reimportação requer revisão humana.');
    INSERT INTO public.catalog_import_operation (operation_id, import_id, organization_id, variant_id, outcome)
    VALUES (operation_id, import_id, organization_uuid, variant_uuid, 'needs_review');
    UPDATE public.catalog_import SET status = 'needs_review' WHERE id = import_id;
    RETURN jsonb_build_object('outcome', 'needs_review', 'variant_id', variant_uuid, 'replayed', FALSE);
  END IF;

  SELECT variant.id INTO variant_uuid
  FROM public.product_variant AS variant
  WHERE variant.organization_id = organization_uuid AND variant.sku = sku_value;

  IF variant_uuid IS NOT NULL THEN
    SELECT balance.quantity INTO balance_quantity
    FROM public.inventory_balance AS balance WHERE balance.variant_id = variant_uuid;
    IF COALESCE(balance_quantity, 0) > 0 THEN
      INSERT INTO public.catalog_pending_review (organization_id, import_id, sku, reason)
      VALUES (organization_uuid, import_id, sku_value, 'SKU local possui estoque: vínculo requer revisão humana.');
      INSERT INTO public.catalog_import_operation (operation_id, import_id, organization_id, variant_id, outcome)
      VALUES (operation_id, import_id, organization_uuid, variant_uuid, 'needs_review');
      UPDATE public.catalog_import SET status = 'needs_review' WHERE id = import_id;
      RETURN jsonb_build_object('outcome', 'needs_review', 'variant_id', variant_uuid, 'replayed', FALSE);
    END IF;

    INSERT INTO public.external_variant_mapping (
      organization_id, variant_id, source, external_product_id, external_variant_id, observed_sku, status
    ) VALUES (
      organization_uuid, variant_uuid, 'nuvemshop', external_product, external_variant, sku_value, 'linked'
    );
    INSERT INTO public.catalog_import_operation (operation_id, import_id, organization_id, variant_id, outcome)
    VALUES (operation_id, import_id, organization_uuid, variant_uuid, 'linked');
    RETURN jsonb_build_object('outcome', 'linked', 'variant_id', variant_uuid, 'replayed', FALSE);
  END IF;

  INSERT INTO public.product (organization_id, name, source)
  VALUES (organization_uuid, product_name, 'nuvemshop') RETURNING id INTO product_uuid;
  INSERT INTO public.product_variant (
    organization_id, product_id, sku, attributes, sale_price_in_cents, cost_in_cents,
    requires_cost_review, tracks_inventory
  ) VALUES (
    organization_uuid, product_uuid, sku_value, COALESCE(candidate->'attributes', '[]'::JSONB), sale_price, cost_value,
    needs_cost_review, tracks_stock
  ) RETURNING id INTO variant_uuid;
  INSERT INTO public.inventory_balance (variant_id, organization_id, quantity)
  VALUES (variant_uuid, organization_uuid, 0);
  INSERT INTO public.external_variant_mapping (
    organization_id, variant_id, source, external_product_id, external_variant_id, observed_sku, status
  ) VALUES (
    organization_uuid, variant_uuid, 'nuvemshop', external_product, external_variant, sku_value, 'linked'
  );

  IF tracks_stock AND stock_quantity > 0 THEN
    INSERT INTO public.stock_lot (organization_id, variant_id, unit_cost_in_cents, source_reference)
    VALUES (organization_uuid, variant_uuid, cost_value, 'Importação inicial Nuvemshop') RETURNING id INTO lot_uuid;
    INSERT INTO public.inventory_movement (
      organization_id, variant_id, lot_id, reason, quantity_delta, operation_id
    ) VALUES (
      organization_uuid, variant_uuid, lot_uuid, 'replenishment', stock_quantity, operation_id
    );
    UPDATE public.inventory_balance SET quantity = stock_quantity, updated_at = NOW()
    WHERE variant_id = variant_uuid;
  END IF;

  INSERT INTO public.catalog_import_operation (operation_id, import_id, organization_id, variant_id, outcome)
  VALUES (operation_id, import_id, organization_uuid, variant_uuid, 'imported');
  INSERT INTO public.audit_event (organization_id, actor_id, event_type, payload)
  VALUES (
    organization_uuid, actor_id, 'catalog.nuvemshop_imported',
    jsonb_build_object('import_id', import_id, 'variant_id', variant_uuid, 'external_variant_id', external_variant)
  );
  RETURN jsonb_build_object('outcome', 'imported', 'variant_id', variant_uuid, 'replayed', FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_nuvemshop_catalog_candidate(UUID, JSONB, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_nuvemshop_catalog_candidate(UUID, JSONB, UUID, UUID) TO service_role;
