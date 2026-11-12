-- 0022_hub_orders: the custom order's home is Agency Hub (ecosystem plan 12.11.2026, package N;
-- SPEC §8.2, §12.3; schema §3.7, §3.9). Only new tables and one more value of the work kinds:
-- the previous image reads and writes its tables as before and never sees these.
--
-- Since 12.11.2026 an order is born and closed in the hub (`K-<n>`); ContentOps keeps its 300
-- orders as history and shows the hub's orders that are in production with the files it holds
-- for them. What a file means for the order goes back to the hub through an outbox: the hub is
-- the home, so nothing here says «сдано» before the hub has it.
--
--   hub_order_reads       — the last read of the hub's open orders, per model: the orders as the
--                           hub answered them (its agent read, no money), when, and the last
--                           failure. The screen shows the last read with its time when the hub
--                           does not answer (a deploy).
--   hub_order_deliveries  — a file of a hub order: a CUS and the sealed composition of the
--                           versions of its part, as `custom_order_deliveries` keeps one for an
--                           order of the history. Never edited: a wrong link is retracted by a
--                           new row (`retracts_id`), one retraction per delivery.
--   hub_order_reports     — the outbox: what the hub must learn of a delivery or a retraction,
--                           the body as it is sent, its state (`pending` until the hub took it,
--                           `refused` when the hub said no), the attempts and the last error.
--   hub_matters           — the matters ContentOps opened in the hub by reason key (a copy of a
--                           custom outside its folder, a custom in the plan): open until the cause
--                           is gone here, then closed there.
--   backup_checkpoints    — a copy of the database (schema §3.9): for now the nightly copy to the
--                           owner's Mac reports itself (`db_only`); the masters have no copy yet.
--   inbox_groups.hub_order_code — the hub order a custom in «Приехало» is delivered for (◆ «Какой
--                           заказ?», the field «Заказ»): «Принять как сдачу» links it to that order.
--                           Nullable; a group names an order of the hub or of the history, not both.
--
-- `hub_orders` is the work of role `worker` that reads the hub's orders of a model, sends the
-- outbox and keeps the matters (every 5 minutes and right after a delivery).

ALTER TABLE work_operations DROP CONSTRAINT work_operations_kind_check;
ALTER TABLE work_operations ADD CONSTRAINT work_operations_kind_check
  CHECK (kind IN (
    'scan', 'fetch', 'hash', 'unpack_archive', 'import_parse', 'register', 'propose',
    'export', 'hub_sync', 'hub_history', 'hub_publish', 'annotate', 'verify_blobs', 'backup',
    'derive_video', 'encode_master', 'verify_master', 'render', 'uniq_render',
    'render_compat', 'extract_frame', 'derive_image', 'video_print', 'hub_orders'
  ));

-- The hub's orders of the model as last read. `orders` is the hub's agent answer, cut to the
-- orders of this model (by the page, ContentOps' old order, or the model's Telegram chats).
CREATE TABLE hub_order_reads (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  -- The last read that came back whole; null — never.
  read_at timestamptz,
  orders jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(orders) = 'array'),
  -- Open hub orders no model of ContentOps could be told for (no page, no old order, an
  -- unknown chat): the hub's board has them.
  unassigned integer NOT NULL DEFAULT 0 CHECK (unassigned >= 0),
  tried_at timestamptz,
  -- The last failed read in words; null after a read that came back.
  error text,
  PRIMARY KEY (model_id)
);

-- A file of a hub order: one part of a CUS, its sealed composition.
CREATE TABLE hub_order_deliveries (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  order_code text NOT NULL CHECK (order_code ~ '^K-[1-9][0-9]{0,15}$'),
  part text CHECK (part IN ('video', 'photos')),
  -- The part is whole with this delivery (several clips: false until the last one).
  complete boolean,
  item_id uuid,
  item_type text NOT NULL DEFAULT 'CUS' CHECK (item_type = 'CUS'),
  manifest_id uuid,
  -- The Telegram message that brought it (`tg:<chat>/<topic>/<message>`), when known.
  message_ref text CHECK (message_ref ~ '^tg:[a-z0-9_]+/[0-9]+(/[0-9]+)?$'),
  -- When the model delivered: the message, else when the files appeared in the source.
  delivered_at timestamptz,
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  retracts_id uuid,
  retract_reason text,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, order_code, id),
  CONSTRAINT hub_order_deliveries_manifest UNIQUE (model_id, manifest_id),
  CONSTRAINT hub_order_deliveries_retracts_once UNIQUE (retracts_id),
  FOREIGN KEY (model_id, item_id, item_type) REFERENCES content_items (model_id, id, type)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, manifest_id) REFERENCES asset_manifests (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, order_code, retracts_id)
    REFERENCES hub_order_deliveries (model_id, order_code, id) ON DELETE RESTRICT,
  CONSTRAINT hub_order_deliveries_shape CHECK (
    CASE WHEN retracts_id IS NULL
      THEN num_nulls(part, complete, item_id, manifest_id, delivered_at) = 0
           AND retract_reason IS NULL
      ELSE num_nonnulls(part, complete, item_id, manifest_id, delivered_at, message_ref) = 0
           AND retract_reason IS NOT NULL
    END
  ),
  CONSTRAINT hub_order_deliveries_not_self CHECK (retracts_id <> id)
);
CREATE INDEX hub_order_deliveries_order ON hub_order_deliveries (model_id, order_code);
CREATE INDEX hub_order_deliveries_item ON hub_order_deliveries (model_id, item_id)
  WHERE item_id IS NOT NULL;

-- A delivery is a fact: its journal is the `action` row of the command that inserts it.
CREATE TRIGGER hub_order_deliveries_append_only BEFORE UPDATE OR DELETE ON hub_order_deliveries
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
REVOKE UPDATE, DELETE ON hub_order_deliveries FROM contentops_app;

-- What the hub must learn: one report per delivery and per retraction.
CREATE TABLE hub_order_reports (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  order_code text NOT NULL,
  -- The delivery row (a retraction's own row for `retraction`).
  delivery_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('delivery', 'retraction')),
  -- The hub's agent body (`POST /api/v1/agent/custom-orders/<code>`) as it is sent.
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'refused')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  tried_at timestamptz,
  error text,
  sent_at timestamptz,
  -- The hub's answer: created | changed | unchanged, and the order's state after it.
  outcome text,
  hub_state text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, id),
  CONSTRAINT hub_order_reports_once UNIQUE (model_id, delivery_id),
  FOREIGN KEY (model_id, order_code, delivery_id)
    REFERENCES hub_order_deliveries (model_id, order_code, id) ON DELETE RESTRICT,
  CONSTRAINT hub_order_reports_sent CHECK ((state = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX hub_order_reports_pending ON hub_order_reports (model_id, created_at)
  WHERE state = 'pending';

-- The matters ContentOps keeps in the hub (`<kind>:<ref>`), and whether they are open there.
CREATE TABLE hub_matters (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  key text NOT NULL CHECK (key ~ '^contentops\.[a-z_]+:\S+$'),
  kind text NOT NULL,
  title text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  error text,
  PRIMARY KEY (model_id, key)
);

-- A restore point (schema §3.9, SPEC §12.3). The in-product backup of stage 9б fills `run_id`
-- and the manifest of the masters; a copy taken outside (the owner's Mac) reports its dump only.
CREATE TABLE backup_checkpoints (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id uuid,
  db_snapshot_at timestamptz NOT NULL,
  -- Where the dump lies in its repository: `20261112T024500Z/contentops.dump`.
  dump_key text NOT NULL,
  dump_sha256 text CHECK (dump_sha256 ~ '^[0-9a-f]{64}$'),
  dump_bytes bigint CHECK (dump_bytes > 0),
  required_manifest_key text,
  required_count integer CHECK (required_count >= 0),
  missing_count integer CHECK (missing_count >= 0),
  state text NOT NULL CHECK (state IN ('db_only', 'complete', 'expired')),
  -- `mac` — the owner's Mac (`~/Backups/contentops`).
  repository text NOT NULL CHECK (repository ~ '^[a-z][a-z0-9_-]*$'),
  finalized_at timestamptz NOT NULL DEFAULT now(),
  last_restore_test_at timestamptz,
  reported_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  CONSTRAINT backup_checkpoints_dump UNIQUE (repository, dump_key)
);
CREATE INDEX backup_checkpoints_latest ON backup_checkpoints (db_snapshot_at DESC);

-- The hub order of a group in «Приехало»: the accepted CUS becomes its delivery.
ALTER TABLE inbox_groups
  ADD COLUMN hub_order_code text
    CONSTRAINT inbox_groups_hub_order_code_format CHECK (hub_order_code ~ '^K-[1-9][0-9]{0,15}$'),
  ADD CONSTRAINT inbox_groups_one_order CHECK (custom_order_id IS NULL OR hub_order_code IS NULL);
