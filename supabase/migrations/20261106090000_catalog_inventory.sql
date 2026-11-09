CREATE TABLE public.product (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 180),
  description TEXT,
  category TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL CHECK (source IN ('manual', 'nuvemshop')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.product_variant (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  product_id UUID NOT NULL REFERENCES public.product(id),
  sku TEXT NOT NULL,
  barcode TEXT,
  attributes JSONB NOT NULL DEFAULT '[]'::JSONB,
  sale_price_in_cents INTEGER NOT NULL CHECK (sale_price_in_cents >= 0),
  cost_in_cents INTEGER NOT NULL CHECK (cost_in_cents >= 0),
  requires_cost_review BOOLEAN NOT NULL DEFAULT FALSE,
  tracks_inventory BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, sku)
);

CREATE TABLE public.catalog_import (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  operation_id UUID NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source = 'nuvemshop'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'recoverable_failure', 'needs_review')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.catalog_pending_review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  import_id UUID NOT NULL REFERENCES public.catalog_import(id),
  sku TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.external_variant_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  variant_id UUID NOT NULL REFERENCES public.product_variant(id),
  source TEXT NOT NULL CHECK (source = 'nuvemshop'),
  external_product_id TEXT NOT NULL,
  external_variant_id TEXT NOT NULL,
  observed_sku TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('linked', 'needs_review')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, source, external_variant_id)
);

CREATE TABLE public.stock_lot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  variant_id UUID NOT NULL REFERENCES public.product_variant(id),
  unit_cost_in_cents INTEGER NOT NULL CHECK (unit_cost_in_cents >= 0),
  source_reference TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.inventory_movement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  variant_id UUID NOT NULL REFERENCES public.product_variant(id),
  lot_id UUID REFERENCES public.stock_lot(id),
  reason TEXT NOT NULL CHECK (reason IN ('replenishment', 'adjustment', 'physical_sale', 'sale_cancellation', 'online_order', 'online_order_cancellation', 'return_received')),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  reference_id UUID,
  operation_id UUID UNIQUE,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.inventory_balance (
  variant_id UUID PRIMARY KEY REFERENCES public.product_variant(id),
  organization_id UUID NOT NULL REFERENCES public.organization(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.product ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product FORCE ROW LEVEL SECURITY;
ALTER TABLE public.product_variant ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variant FORCE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_import FORCE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_pending_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_pending_review FORCE ROW LEVEL SECURITY;
ALTER TABLE public.external_variant_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_variant_mapping FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stock_lot ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_lot FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movement FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_balance FORCE ROW LEVEL SECURITY;

CREATE POLICY "Members read organization products" ON public.product FOR SELECT TO authenticated USING (public.is_organization_member(organization_id));
CREATE POLICY "Members read organization variants" ON public.product_variant FOR SELECT TO authenticated USING (public.is_organization_member(organization_id));
CREATE POLICY "Members read organization imports" ON public.catalog_import FOR SELECT TO authenticated USING (public.is_organization_member(organization_id));
CREATE POLICY "Members read organization reviews" ON public.catalog_pending_review FOR SELECT TO authenticated USING (public.is_organization_member(organization_id));
CREATE POLICY "Members read organization mappings" ON public.external_variant_mapping FOR SELECT TO authenticated USING (public.is_organization_member(organization_id));
CREATE POLICY "Members read organization lots" ON public.stock_lot FOR SELECT TO authenticated USING (public.is_organization_member(organization_id));
CREATE POLICY "Members read organization movements" ON public.inventory_movement FOR SELECT TO authenticated USING (public.is_organization_member(organization_id));
CREATE POLICY "Members read organization balances" ON public.inventory_balance FOR SELECT TO authenticated USING (public.is_organization_member(organization_id));

CREATE FUNCTION public.create_catalog_product(product_name TEXT, variant_sku TEXT, sale_price_in_cents INTEGER, cost_in_cents INTEGER)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE organization_uuid UUID; product_uuid UUID; variant_uuid UUID;
BEGIN
  SELECT organization_id INTO organization_uuid FROM public.organization_member WHERE user_id = auth.uid() LIMIT 1;
  IF organization_uuid IS NULL THEN RAISE EXCEPTION 'Organização não encontrada'; END IF;
  INSERT INTO public.product (organization_id, name, source) VALUES (organization_uuid, trim(product_name), 'manual') RETURNING id INTO product_uuid;
  INSERT INTO public.product_variant (organization_id, product_id, sku, sale_price_in_cents, cost_in_cents, requires_cost_review)
  VALUES (organization_uuid, product_uuid, trim(variant_sku), sale_price_in_cents, cost_in_cents, cost_in_cents = 0) RETURNING id INTO variant_uuid;
  INSERT INTO public.inventory_balance (variant_id, organization_id) VALUES (variant_uuid, organization_uuid);
  RETURN product_uuid;
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_catalog_product(TEXT, TEXT, INTEGER, INTEGER) TO authenticated;
