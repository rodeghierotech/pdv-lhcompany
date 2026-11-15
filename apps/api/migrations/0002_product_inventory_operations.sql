ALTER TABLE product
  ADD COLUMN operation_id UUID UNIQUE,
  ADD COLUMN operation_fingerprint TEXT;

ALTER TABLE inventory_movement
  ADD COLUMN operation_fingerprint TEXT;

ALTER TABLE product_variant
  ADD COLUMN minimum_stock_quantity INTEGER NOT NULL DEFAULT 3
    CHECK (minimum_stock_quantity >= 0);

CREATE INDEX product_name_id_idx ON product(name, id);
CREATE INDEX product_variant_sku_id_idx ON product_variant(sku, id);
