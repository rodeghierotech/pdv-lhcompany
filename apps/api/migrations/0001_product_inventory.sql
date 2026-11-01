CREATE TABLE product (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE product_variant (
  id UUID PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES product(id),
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT UNIQUE,
  attributes JSONB NOT NULL DEFAULT '[]'::JSONB,
  sale_price_in_cents INTEGER NOT NULL CHECK (sale_price_in_cents >= 0),
  cost_in_cents INTEGER NOT NULL CHECK (cost_in_cents >= 0),
  tracks_inventory BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stock_lot (
  id UUID PRIMARY KEY,
  variant_id UUID NOT NULL REFERENCES product_variant(id),
  received_at TIMESTAMPTZ NOT NULL,
  unit_cost_in_cents INTEGER NOT NULL CHECK (unit_cost_in_cents >= 0),
  source_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE inventory_movement (
  id UUID PRIMARY KEY,
  variant_id UUID NOT NULL REFERENCES product_variant(id),
  lot_id UUID REFERENCES stock_lot(id),
  reason TEXT NOT NULL CHECK (reason IN (
    'replenishment',
    'adjustment',
    'physical_sale',
    'sale_cancellation',
    'online_order',
    'online_order_cancellation',
    'return_received'
  )),
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  reference_id UUID,
  operation_id UUID UNIQUE,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE inventory_balance (
  variant_id UUID PRIMARY KEY REFERENCES product_variant(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX product_variant_product_id_idx ON product_variant(product_id);
CREATE INDEX stock_lot_variant_id_idx ON stock_lot(variant_id);
CREATE INDEX inventory_movement_variant_occurred_at_idx
  ON inventory_movement(variant_id, occurred_at DESC);
CREATE INDEX inventory_movement_reference_id_idx ON inventory_movement(reference_id);
