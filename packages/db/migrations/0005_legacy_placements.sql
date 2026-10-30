-- 0005_legacy_placements: the tables of stage 3 (schema §9.5) — claims of legacy names
-- (`legacy_claims`, `legacy_number_claims`, schema §3.4, §9.7) and placements with their files
-- and evidence (`placements`, `placement_assets`, `placement_evidence`, schema §3.6, §9.2, §9.6).
--
-- A placement is a use of files on a page and surface: a KM mark, a manual confirmation, a
-- legacy claim, later a Hub observation. Its level is computed from the evidence and the plan
-- row; no status is stored (SPEC §5). Evidence is only inserted: a correction or a retraction is
-- a new row pointing at the earlier one, which has at most one successor. The link of a
-- placement to its plan row comes with `0006_plan`, the FK of `hub_observation_id` with
-- `0008_hub`. Value lists are text + CHECK; the same lists live in `src/values.ts`.

-- ---------------------------------------------------------------------------
-- Legacy claims (schema §3.4, §9.7; SPEC §6.3–6.4)
-- ---------------------------------------------------------------------------

-- What a legacy name says (`used3_04.08.26`, `[Set-002]`, `X.X.X`). A pending claim waits in
-- the queue with its source; a resolved one points at exactly one target where the useful part
-- became a fact (a field, an alias, a placement evidence, an order). A claim of an earlier
-- parser version is ignored with a link to its successor: claims never double.
CREATE TABLE legacy_claims (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7(),
  source_object_id uuid NOT NULL,
  source_revision_id uuid,
  parser_version text NOT NULL,
  -- Natural key of the observed input and the position of the fragment (schema §9.7).
  claim_key text NOT NULL,
  raw_fragment text NOT NULL,
  claim_kind text NOT NULL CHECK (claim_kind IN (
    'number', 'used', 'posted', 'date', 'role', 'registry_row', 'duration', 'unknown'
  )),
  payload jsonb NOT NULL DEFAULT '{}',
  parse_work_id uuid NOT NULL,
  resolution text NOT NULL DEFAULT 'pending' CHECK (resolution IN ('pending', 'resolved', 'ignored')),
  superseded_by_id uuid,
  resolved_item_id uuid,
  resolved_asset_id uuid,
  resolved_version_id uuid,
  resolved_alias_id uuid,
  resolved_evidence_id uuid,
  resolved_order_id uuid,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  CONSTRAINT legacy_claims_key UNIQUE (model_id, source_object_id, parser_version, claim_key),
  FOREIGN KEY (model_id, source_object_id) REFERENCES source_objects (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, source_revision_id) REFERENCES source_revisions (model_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, parse_work_id) REFERENCES work_operations (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, superseded_by_id) REFERENCES legacy_claims (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, resolved_item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, resolved_asset_id, resolved_version_id)
    REFERENCES asset_versions (model_id, asset_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, resolved_alias_id) REFERENCES aliases (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, resolved_order_id) REFERENCES custom_orders (model_id, id) ON DELETE RESTRICT,
  -- A version is named with its file.
  CONSTRAINT legacy_claims_resolved_version
    CHECK ((resolved_asset_id IS NULL) = (resolved_version_id IS NULL)),
  -- Resolved — exactly one target and the time; otherwise no target at all.
  CONSTRAINT legacy_claims_resolved CHECK (
    CASE WHEN resolution = 'resolved'
      THEN num_nonnulls(resolved_item_id, resolved_version_id, resolved_alias_id,
                        resolved_evidence_id, resolved_order_id) = 1
           AND resolved_at IS NOT NULL
      ELSE num_nonnulls(resolved_item_id, resolved_version_id, resolved_alias_id,
                        resolved_evidence_id, resolved_order_id, resolved_at, resolved_by) = 0
    END
  ),
  CONSTRAINT legacy_claims_superseded CHECK (superseded_by_id IS NULL OR resolution = 'ignored'),
  CONSTRAINT legacy_claims_not_self CHECK (superseded_by_id <> id)
);
-- The queue of «Неразобранное».
CREATE INDEX legacy_claims_pending ON legacy_claims (model_id, claim_kind, created_at)
  WHERE resolution = 'pending';
CREATE INDEX legacy_claims_source ON legacy_claims (model_id, source_object_id);

-- A legacy number claimed by a folder or a registry row (SPEC §6.4). No uniqueness by number:
-- `PPV-032` was claimed by three folders. The metadata pass records every claim and lifts the
-- counter above the maximum before any bytes are accepted.
CREATE TABLE legacy_number_claims (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7(),
  type text NOT NULL CHECK (type IN ('PPV', 'SET', 'SXT', 'CUS', 'FYP', 'LIFE', 'RAW', 'PRM')),
  claimed_number integer NOT NULL
    CONSTRAINT legacy_number_claims_number_range CHECK (claimed_number BETWEEN 1 AND 999999),
  source_object_id uuid NOT NULL,
  -- The claim of the name this number comes from: its natural key (schema §9.7).
  claim_id uuid NOT NULL,
  registry_claim_id uuid,
  decision text CHECK (decision IN ('keep', 'renumber', 'typo', 'unclear')),
  assigned_number integer
    CONSTRAINT legacy_number_claims_assigned_range CHECK (assigned_number BETWEEN 1 AND 999999),
  target_item_id uuid,
  decided_at timestamptz,
  decided_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  CONSTRAINT legacy_number_claims_claim UNIQUE (model_id, claim_id),
  FOREIGN KEY (model_id, source_object_id) REFERENCES source_objects (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, claim_id) REFERENCES legacy_claims (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, registry_claim_id) REFERENCES legacy_claims (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, target_item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT legacy_number_claims_decided CHECK ((decision IS NULL) = (decided_at IS NULL))
);
CREATE INDEX legacy_number_claims_number ON legacy_number_claims (model_id, type, claimed_number);

-- ---------------------------------------------------------------------------
-- Placements (schema §3.6, §9.2, §9.6; SPEC §5, §7)
-- ---------------------------------------------------------------------------

-- A use of files on a page and surface with its date: a post on the wall or FYP, a file in a
-- named vault album, a story or a mass message marked by hand. No empty placement «for the
-- plan»: until an observation or a mark there is only the plan row. A publication found twice
-- or bound to a plan later stays one placement (unique external IDs per surface); a placement
-- without an external ID (a KM mark, «Отметить и подтвердить», a legacy claim) has its own key
-- `manual_key` and later receives the external IDs.
CREATE TABLE placements (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  account_id uuid NOT NULL,
  surface_id uuid NOT NULL,
  occurrence_kind text NOT NULL CHECK (occurrence_kind IN ('post', 'vault_member', 'manual')),
  external_post_ref text,
  external_album_ref text,
  external_media_ref text,
  manual_key text,
  -- A found publication gets its object later; «Вне каталога» never does.
  item_id uuid,
  -- Type copy (schema §9.2), in a pair with `item_id`.
  item_type text,
  planned_at timestamptz,
  occurred_at timestamptz,
  -- How well the time is known: a legacy claim may carry no date at all (schema §9.2).
  event_precision text NOT NULL DEFAULT 'exact' CHECK (event_precision IN ('exact', 'day', 'unknown')),
  occurred_source text CHECK (occurred_source IN ('hub', 'km', 'import')),
  -- Where the surface comes from (schema §9.6): Hub, the KM mark on a plan row, a KM decision,
  -- the plan, the legacy import. Rows with an unproven surface stay out of surface norms.
  surface_source text NOT NULL CHECK (surface_source IN ('hub', 'km_mark', 'km', 'plan', 'import')),
  -- The caption from the platform; stats are Fansly sums over the files (from 22.10.2026).
  caption text,
  views bigint CHECK (views >= 0),
  likes bigint CHECK (likes >= 0),
  stats_at timestamptz,
  out_of_catalog boolean NOT NULL DEFAULT false,
  origin text NOT NULL CHECK (origin IN ('plan', 'hub', 'manual', 'import')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  FOREIGN KEY (model_id, account_id, surface_id) REFERENCES surfaces (model_id, account_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, item_id, item_type) REFERENCES content_items (model_id, id, type)
    ON DELETE RESTRICT,
  CONSTRAINT placements_item_type CHECK ((item_id IS NULL) = (item_type IS NULL)),
  CONSTRAINT placements_out_of_catalog CHECK (NOT out_of_catalog OR item_id IS NULL),
  CONSTRAINT placements_time
    CHECK (planned_at IS NOT NULL OR occurred_at IS NOT NULL OR event_precision = 'unknown'),
  CONSTRAINT placements_occurred_source CHECK (occurred_at IS NULL OR occurred_source IS NOT NULL)
);
-- One publication — one placement per surface (schema §4): a repeated poll and a later binding
-- write into the same row; a post on the wall and in FYP is two placements with one post ref.
CREATE UNIQUE INDEX placements_post ON placements (model_id, surface_id, external_post_ref)
  WHERE external_post_ref IS NOT NULL;
CREATE UNIQUE INDEX placements_vault_member
  ON placements (model_id, surface_id, external_album_ref, external_media_ref)
  WHERE external_media_ref IS NOT NULL;
CREATE UNIQUE INDEX placements_manual_key ON placements (model_id, surface_id, manual_key)
  WHERE manual_key IS NOT NULL;
CREATE INDEX placements_item ON placements (model_id, item_id, occurred_at DESC);
CREATE INDEX placements_page ON placements (model_id, account_id, surface_id, occurred_at DESC);
-- «Пост без плана — привяжите».
CREATE INDEX placements_unbound ON placements (model_id, created_at)
  WHERE item_id IS NULL AND NOT out_of_catalog;

-- The files of a placement by version: a post of twelve frames is one placement with twelve
-- rows. One file of twelve matching is a partial result: the level counts every row.
CREATE TABLE placement_assets (
  model_id uuid NOT NULL,
  -- Subject of the journal; the key is (placement, version).
  id uuid NOT NULL DEFAULT uuidv7(),
  placement_id uuid NOT NULL,
  asset_id uuid NOT NULL,
  asset_version_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  match_strength text NOT NULL DEFAULT 'none' CHECK (match_strength IN ('none', 'candidate', 'exact')),
  matched_media_ref text,
  -- Which issued file matched (the name of a ContentOps download, SPEC §7).
  receipt_entry_id uuid,
  bound_at timestamptz NOT NULL DEFAULT now(),
  bound_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, placement_id, asset_version_id),
  UNIQUE (model_id, id),
  CONSTRAINT placement_assets_position UNIQUE (model_id, placement_id, position),
  FOREIGN KEY (model_id, placement_id) REFERENCES placements (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, asset_id, asset_version_id) REFERENCES asset_versions (model_id, asset_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, receipt_entry_id) REFERENCES download_receipt_entries (model_id, id)
    ON DELETE RESTRICT
);
CREATE INDEX placement_assets_version ON placement_assets (model_id, asset_version_id);

-- Evidence on a placement: what Hub saw, what a person confirmed, rejected or retracted, what a
-- legacy name claims. Only inserted; a correction points at the earlier row of the same
-- placement, one successor each. The source is where the evidence came from, the strength what
-- it asserts; denying kinds assert nothing (schema §9.2):
--   hub    — `observed`, candidate or exact, always with its observation;
--   manual — `manual_confirm` and `reused_pair` are exact; `manual_reject`, `retract`,
--            `outside_catalog` have no strength (a «Не то» is never a weak «да»);
--   import — `legacy_claim`, always a claim.
CREATE TABLE placement_evidence (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  placement_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('hub', 'manual', 'import')),
  kind text NOT NULL CHECK (kind IN (
    'observed', 'manual_confirm', 'reused_pair', 'manual_reject', 'legacy_claim',
    'outside_catalog', 'retract'
  )),
  strength text CHECK (strength IN ('claim', 'candidate', 'exact')),
  -- The FK to `hub_observations` comes with `0008_hub`.
  hub_observation_id uuid,
  external_ref text,
  matched_asset_id uuid,
  matched_version_id uuid,
  legacy_claim_id uuid,
  -- Candidate signals, the basis of a manual confirmation (`inspected_pair | execution_report`).
  payload jsonb NOT NULL DEFAULT '{}',
  event_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  corrects_id uuid,
  -- `exact:<media_ref>:<observation>`, `cand:<row>:<manifest>:<observation>`, `manual:<id>`.
  dedup_key text NOT NULL,
  PRIMARY KEY (model_id, id),
  -- Target of FK (model_id, placement_id, corrects_id): a correction stays on its placement.
  UNIQUE (model_id, placement_id, id),
  -- The same observation twice gives no second row; a changed one (another caption) does.
  CONSTRAINT placement_evidence_dedup UNIQUE (model_id, placement_id, source, dedup_key),
  -- A correction has one successor.
  CONSTRAINT placement_evidence_corrects_once UNIQUE (corrects_id),
  FOREIGN KEY (model_id, placement_id) REFERENCES placements (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, placement_id, corrects_id)
    REFERENCES placement_evidence (model_id, placement_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, matched_asset_id, matched_version_id)
    REFERENCES asset_versions (model_id, asset_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, legacy_claim_id) REFERENCES legacy_claims (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT placement_evidence_matched_version
    CHECK ((matched_asset_id IS NULL) = (matched_version_id IS NULL)),
  -- The triple (source, kind, strength) of schema §9.2; written without value lists.
  CONSTRAINT placement_evidence_triple CHECK (
    CASE kind
      WHEN 'observed' THEN source = 'hub' AND hub_observation_id IS NOT NULL
        AND strength IS NOT NULL AND strength <> 'claim'
      WHEN 'manual_confirm' THEN source = 'manual' AND strength IS NOT NULL AND strength = 'exact'
      WHEN 'reused_pair' THEN source = 'manual' AND strength IS NOT NULL AND strength = 'exact'
      WHEN 'legacy_claim' THEN source = 'import' AND strength IS NOT NULL AND strength = 'claim'
        AND legacy_claim_id IS NOT NULL
      ELSE source = 'manual' AND strength IS NULL
    END
  ),
  -- A retraction always names the confirmation it takes back.
  CONSTRAINT placement_evidence_retract CHECK (kind <> 'retract' OR corrects_id IS NOT NULL),
  CONSTRAINT placement_evidence_not_self CHECK (corrects_id <> id)
);
CREATE INDEX placement_evidence_placement ON placement_evidence (model_id, placement_id, recorded_at);

ALTER TABLE legacy_claims
  ADD FOREIGN KEY (model_id, resolved_evidence_id) REFERENCES placement_evidence (model_id, id)
    ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Append-only evidence, fixed columns and the journal (schema §9.3, §9.4)
-- ---------------------------------------------------------------------------

-- Evidence is a fact: its journal is the `action` row of the command that inserts it.
CREATE TRIGGER placement_evidence_append_only BEFORE UPDATE OR DELETE ON placement_evidence
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
REVOKE UPDATE, DELETE ON placement_evidence FROM contentops_app;

CREATE TRIGGER legacy_claims_fixed BEFORE UPDATE ON legacy_claims
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'source_object_id', 'source_revision_id', 'parser_version', 'claim_key',
    'raw_fragment', 'claim_kind'
  );
CREATE TRIGGER legacy_number_claims_fixed BEFORE UPDATE ON legacy_number_claims
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'type', 'claimed_number', 'source_object_id', 'claim_id'
  );
CREATE TRIGGER placements_fixed BEFORE UPDATE ON placements
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'account_id', 'surface_id');
CREATE TRIGGER placement_assets_fixed BEFORE UPDATE ON placement_assets
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'placement_id', 'asset_id', 'asset_version_id'
  );

CREATE TRIGGER legacy_claims_journal AFTER INSERT OR UPDATE OR DELETE ON legacy_claims
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER legacy_number_claims_journal AFTER INSERT OR UPDATE OR DELETE ON legacy_number_claims
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER placements_journal AFTER INSERT OR UPDATE OR DELETE ON placements
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER placement_assets_journal AFTER INSERT OR UPDATE OR DELETE ON placement_assets
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
