-- 0005_promo: promo contractors and handoffs (schema §3.8, §9.1, §9.2; SPEC §7.1).
--
-- A collection is a `PRM` object of the catalog: its files are memberships, the files of other
-- objects come in as references (`item_memberships.kind = 'reference'`, 0003). This file adds
-- the recipients of handoffs, the default contractor of a collection and the handoffs
-- themselves. A handoff is prepared from a sealed manifest of versions; its ZIP, names, sizes
-- and hashes are a sealed download receipt; «Передано» only adds the date and the author.
-- Value lists are text + CHECK; the same lists live in `src/values.ts`.
--
-- Bytes: a handoff holds versions through its manifest, and the master of every version is
-- already a reference of its blob (`blob_is_referenced`, 0003); versions are never deleted,
-- so the history of handoffs keeps its masters without a new clause there.

-- ---------------------------------------------------------------------------
-- Contractors (schema §3.8)
-- ---------------------------------------------------------------------------

-- A recipient without sign-in in the context of one model. One format field (решение
-- владельца 30.10.2026): «для заливки» (`upload`: the platform copy and picked frames),
-- «мастер» (`master`), «совместимая для монтажа» (`compat`: H.264). The next handoff takes it.
CREATE TABLE contractors (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7(),
  name text NOT NULL CONSTRAINT contractors_name_filled CHECK (btrim(name) <> ''),
  contact text,
  channel_id uuid,
  format text NOT NULL DEFAULT 'upload' CHECK (format IN ('upload', 'master', 'compat')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  CONSTRAINT contractors_name UNIQUE (model_id, name),
  FOREIGN KEY (model_id, channel_id) REFERENCES promo_channels (model_id, id) ON DELETE RESTRICT
);

-- The contractor a collection is usually handed to (schema §9.1: `promo_packages` became two
-- columns of the `PRM` card; the channel came with 0003).
ALTER TABLE content_items
  ADD COLUMN default_contractor_id uuid,
  ADD FOREIGN KEY (model_id, default_contractor_id) REFERENCES contractors (model_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT content_items_default_contractor
    CHECK (default_contractor_id IS NULL OR type = 'PRM');

-- ---------------------------------------------------------------------------
-- Handoffs (schema §3.8; SPEC §5, §7.1)
-- ---------------------------------------------------------------------------

-- One handoff of chosen files of a collection to a contractor. `preparing` — the export work
-- builds the files (`work_operations.manifest_id` points at the same manifest); `prepared` —
-- the receipt is sealed: ZIP, `manifest.csv` and the summary are ready; `sent` — «Передано»,
-- the record of history, never changed again. Adding to «Промо», preparing and «Передано» are
-- different facts and none of them is a publication: a handoff creates no placement.
-- A new preparation of an unsent handoff replaces it (`corrects_id`, one successor); a handoff
-- after «Передано» is a new row. A past pack from import (SPEC §6.3) is `origin = 'import'`,
-- `sent` without date and author, without format and receipt: the folder date is in `summary`,
-- a claim, not a confirmed sending.
CREATE TABLE promo_deliveries (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  package_item_id uuid NOT NULL,
  -- Type copy (schema §9.2): a handoff belongs to a PRM collection.
  package_item_type text NOT NULL DEFAULT 'PRM' CHECK (package_item_type = 'PRM'),
  channel_id uuid NOT NULL,
  contractor_id uuid NOT NULL,
  -- The contractor's format when the handoff was prepared; it stays with the handoff.
  format text CHECK (format IN ('upload', 'master', 'compat')),
  -- The sealed composition: order, assets and their versions (and so the masters' SHA-256).
  manifest_id uuid NOT NULL,
  -- The sealed issue: file names, sizes and hashes of what went into the ZIP.
  receipt_id uuid,
  state text NOT NULL DEFAULT 'preparing' CHECK (state IN ('preparing', 'prepared', 'sent')),
  prepared_at timestamptz,
  prepared_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  sent_at timestamptz,
  sent_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  recipient_note text,
  -- Counts, sizes and the ZIP name for the summary; the folder date of an imported pack.
  summary jsonb NOT NULL DEFAULT '{}',
  origin text NOT NULL DEFAULT 'product' CHECK (origin IN ('product', 'import')),
  corrects_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  CONSTRAINT promo_deliveries_manifest UNIQUE (model_id, manifest_id),
  CONSTRAINT promo_deliveries_corrects_once UNIQUE (corrects_id),
  CONSTRAINT promo_deliveries_package_fkey FOREIGN KEY (model_id, package_item_id, package_item_type)
    REFERENCES content_items (model_id, id, type) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, channel_id) REFERENCES promo_channels (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, contractor_id) REFERENCES contractors (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, manifest_id) REFERENCES asset_manifests (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, receipt_id) REFERENCES download_receipts (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, corrects_id) REFERENCES promo_deliveries (model_id, id) ON DELETE RESTRICT,
  -- «Передано» only with a date and an author, except past packs from import (schema §4).
  CONSTRAINT promo_deliveries_sent CHECK (
    CASE origin
      WHEN 'import' THEN state = 'sent' AND sent_at IS NULL AND sent_by IS NULL
      ELSE format IS NOT NULL AND (state = 'sent') = (sent_at IS NOT NULL AND sent_by IS NOT NULL)
    END
  ),
  -- A prepared handoff has its receipt; an imported pack was never prepared here.
  CONSTRAINT promo_deliveries_prepared CHECK (
    CASE origin
      WHEN 'import' THEN num_nonnulls(format, prepared_at, prepared_by, receipt_id, corrects_id) = 0
      ELSE prepared_at IS NOT NULL AND prepared_by IS NOT NULL
           AND (state = 'preparing') = (receipt_id IS NULL)
    END
  ),
  CONSTRAINT promo_deliveries_not_self CHECK (corrects_id <> id)
);
CREATE INDEX promo_deliveries_package ON promo_deliveries (model_id, package_item_id, created_at);
CREATE INDEX promo_deliveries_created ON promo_deliveries (model_id, created_at DESC);
CREATE INDEX promo_deliveries_contractor ON promo_deliveries (model_id, contractor_id)
  WHERE state = 'sent';

-- «Готовится» follows the export work of the handoff: found by its manifest.
CREATE INDEX work_operations_manifest ON work_operations (model_id, manifest_id)
  WHERE manifest_id IS NOT NULL;

-- `preparing → prepared → sent`, never back; a sent handoff is frozen by its own trigger.
CREATE FUNCTION promo_delivery_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.state = 'prepared' AND NEW.state = 'preparing')
     OR (OLD.state = 'preparing' AND NEW.state = 'sent') THEN
    RAISE EXCEPTION 'promo handoff % cannot go % → %', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'CO005';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER promo_deliveries_transition BEFORE UPDATE ON promo_deliveries
  FOR EACH ROW EXECUTE FUNCTION promo_delivery_transition();
CREATE TRIGGER promo_deliveries_sent_frozen BEFORE UPDATE OR DELETE ON promo_deliveries
  FOR EACH ROW WHEN (OLD.state = 'sent') EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER promo_deliveries_fixed BEFORE UPDATE ON promo_deliveries
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'package_item_id', 'package_item_type', 'channel_id', 'contractor_id',
    'format', 'manifest_id', 'origin', 'corrects_id', 'prepared_at', 'prepared_by'
  );
CREATE TRIGGER promo_deliveries_receipt_once BEFORE UPDATE ON promo_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_once('receipt_id');
CREATE TRIGGER contractors_fixed BEFORE UPDATE ON contractors
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id');

-- History stays: the app role never deletes a handoff.
REVOKE DELETE ON promo_deliveries FROM contentops_app;

-- ---------------------------------------------------------------------------
-- Journal (schema §9.3)
-- ---------------------------------------------------------------------------

CREATE TRIGGER contractors_journal AFTER INSERT OR UPDATE OR DELETE ON contractors
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER promo_deliveries_journal AFTER INSERT OR UPDATE OR DELETE ON promo_deliveries
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
