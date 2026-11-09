CREATE TABLE public.catalog_manual_operation (
  operation_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  product_id UUID NOT NULL REFERENCES public.product(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.catalog_manual_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_manual_operation FORCE ROW LEVEL SECURITY;
CREATE POLICY "Members read manual catalog operations" ON public.catalog_manual_operation
  FOR SELECT TO authenticated USING (public.is_organization_member(organization_id));

CREATE OR REPLACE FUNCTION public.create_catalog_product(
  product_name TEXT,
  variant_sku TEXT,
  sale_price_in_cents INTEGER,
  cost_in_cents INTEGER,
  initial_quantity INTEGER DEFAULT 0,
  source_reference TEXT DEFAULT NULL,
  operation_id UUID DEFAULT gen_random_uuid()
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  organization_uuid UUID;
  product_uuid UUID;
  variant_uuid UUID;
  lot_uuid UUID;
  balance_quantity INTEGER;
BEGIN
  IF initial_quantity < 0 THEN RAISE EXCEPTION 'Quantidade inicial não pode ser negativa'; END IF;
  IF sale_price_in_cents < 0 OR cost_in_cents < 0 THEN RAISE EXCEPTION 'Valores monetários não podem ser negativos'; END IF;

  SELECT organization_id INTO organization_uuid
  FROM public.organization_member
  WHERE user_id = auth.uid()
  ORDER BY organization_id
  LIMIT 1;
  IF organization_uuid IS NULL THEN RAISE EXCEPTION 'Organização não encontrada'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(operation_id::TEXT, 0));
  SELECT operation.product_id INTO product_uuid
  FROM public.catalog_manual_operation AS operation
  WHERE operation.operation_id = create_catalog_product.operation_id
    AND operation.organization_id = organization_uuid;
  IF product_uuid IS NOT NULL THEN
    SELECT variant.id INTO variant_uuid
    FROM public.product_variant AS variant
    WHERE variant.product_id = product_uuid
    ORDER BY variant.created_at
    LIMIT 1;
    SELECT balance.quantity INTO balance_quantity
    FROM public.inventory_balance AS balance
    WHERE balance.variant_id = variant_uuid;
    RETURN jsonb_build_object('product_id', product_uuid, 'variant_id', variant_uuid, 'quantity', balance_quantity, 'replayed', TRUE);
  END IF;

  INSERT INTO public.product (organization_id, name, source)
  VALUES (organization_uuid, trim(product_name), 'manual')
  RETURNING id INTO product_uuid;

  INSERT INTO public.product_variant (
    organization_id, product_id, sku, sale_price_in_cents, cost_in_cents, requires_cost_review
  ) VALUES (
    organization_uuid, product_uuid, trim(variant_sku), sale_price_in_cents, cost_in_cents, cost_in_cents = 0
  ) RETURNING id INTO variant_uuid;

  INSERT INTO public.inventory_balance (variant_id, organization_id, quantity)
  VALUES (variant_uuid, organization_uuid, 0);

  IF initial_quantity > 0 THEN
    INSERT INTO public.stock_lot (organization_id, variant_id, unit_cost_in_cents, source_reference)
    VALUES (organization_uuid, variant_uuid, cost_in_cents, NULLIF(trim(source_reference), ''))
    RETURNING id INTO lot_uuid;

    INSERT INTO public.inventory_movement (
      organization_id, variant_id, lot_id, reason, quantity_delta, operation_id
    ) VALUES (
      organization_uuid, variant_uuid, lot_uuid, 'replenishment', initial_quantity, operation_id
    );

    UPDATE public.inventory_balance
    SET quantity = initial_quantity, updated_at = NOW()
    WHERE variant_id = variant_uuid
    RETURNING quantity INTO balance_quantity;
  ELSE
    balance_quantity := 0;
  END IF;

  INSERT INTO public.audit_event (organization_id, actor_id, event_type, payload)
  VALUES (
    organization_uuid,
    auth.uid(),
    'catalog.product_created',
    jsonb_build_object('product_id', product_uuid, 'variant_id', variant_uuid, 'initial_quantity', initial_quantity)
  );

  INSERT INTO public.catalog_manual_operation (operation_id, organization_id, product_id)
  VALUES (operation_id, organization_uuid, product_uuid);

  RETURN jsonb_build_object('product_id', product_uuid, 'variant_id', variant_uuid, 'quantity', balance_quantity, 'replayed', FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_inventory_replenishment(
  variant_id UUID,
  quantity INTEGER,
  unit_cost_in_cents INTEGER,
  source_reference TEXT DEFAULT NULL,
  operation_id UUID DEFAULT gen_random_uuid()
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  organization_uuid UUID;
  lot_uuid UUID;
  movement_uuid UUID;
  balance_quantity INTEGER;
BEGIN
  IF quantity <= 0 THEN RAISE EXCEPTION 'Quantidade de reposição deve ser positiva'; END IF;
  IF unit_cost_in_cents < 0 THEN RAISE EXCEPTION 'Custo unitário não pode ser negativo'; END IF;

  SELECT variant.organization_id INTO organization_uuid
  FROM public.product_variant AS variant
  INNER JOIN public.organization_member AS membership
    ON membership.organization_id = variant.organization_id
   AND membership.user_id = auth.uid()
  WHERE variant.id = variant_id
  LIMIT 1;
  IF organization_uuid IS NULL THEN RAISE EXCEPTION 'Variante não encontrada para a organização'; END IF;

  SELECT movement.id INTO movement_uuid
  FROM public.inventory_movement AS movement
  WHERE movement.operation_id = record_inventory_replenishment.operation_id;
  IF movement_uuid IS NOT NULL THEN
    SELECT quantity INTO balance_quantity FROM public.inventory_balance WHERE variant_id = record_inventory_replenishment.variant_id;
    RETURN jsonb_build_object('movement_id', movement_uuid, 'quantity', balance_quantity, 'replayed', TRUE);
  END IF;

  INSERT INTO public.stock_lot (organization_id, variant_id, unit_cost_in_cents, source_reference)
  VALUES (organization_uuid, variant_id, unit_cost_in_cents, NULLIF(trim(source_reference), ''))
  RETURNING id INTO lot_uuid;

  INSERT INTO public.inventory_movement (
    organization_id, variant_id, lot_id, reason, quantity_delta, operation_id
  ) VALUES (
    organization_uuid, variant_id, lot_uuid, 'replenishment', quantity, operation_id
  ) RETURNING id INTO movement_uuid;

  INSERT INTO public.inventory_balance (variant_id, organization_id, quantity)
  VALUES (variant_id, organization_uuid, quantity)
  ON CONFLICT (variant_id) DO UPDATE
  SET quantity = public.inventory_balance.quantity + EXCLUDED.quantity,
      updated_at = NOW()
  RETURNING quantity INTO balance_quantity;

  INSERT INTO public.audit_event (organization_id, actor_id, event_type, payload)
  VALUES (
    organization_uuid,
    auth.uid(),
    'inventory.replenished',
    jsonb_build_object('variant_id', variant_id, 'movement_id', movement_uuid, 'quantity', quantity, 'unit_cost_in_cents', unit_cost_in_cents)
  );

  RETURN jsonb_build_object('movement_id', movement_uuid, 'quantity', balance_quantity, 'replayed', FALSE);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_catalog_product(TEXT, TEXT, INTEGER, INTEGER, INTEGER, TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_inventory_replenishment(UUID, INTEGER, INTEGER, TEXT, UUID) TO authenticated;
