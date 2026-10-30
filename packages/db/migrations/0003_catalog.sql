-- 0003_catalog: the catalog (schema §3.2), intake (§3.4), issue receipts (§3.5), the work
-- targets that now exist, the blob reference contract, search and the view `catalog_index`.
--
-- Columns pointing at order tables (`inbox_groups.custom_order_id`, the FK of
-- `inbox_draft_candidates.order_id`) come with `0004_orders`; plan rows, promo deliveries and
-- annotation runs with their own stages (schema §9.5).
-- Value lists are text + CHECK; the same lists live in `src/values.ts`.

-- ---------------------------------------------------------------------------
-- Functions used by constraints
-- ---------------------------------------------------------------------------

-- Roles a file may own in an object of the type (naming §3). `cap` is a download sidecar and
-- fits no type. References in a `PRM` collection are not checked.
CREATE FUNCTION role_fits_type(item_type text, role text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN coalesce(CASE item_type
    WHEN 'PPV' THEN role IN ('master', 'teaser', 'pic', 'thumb')
    WHEN 'SET' THEN role IN ('raw', 'ed')
    WHEN 'SXT' THEN role IN ('pic', 'clip')
    WHEN 'CUS' THEN role IN ('master', 'pic')
    WHEN 'FYP' THEN role = 'master'
    WHEN 'LIFE' THEN role IN ('pic', 'clip')
    WHEN 'RAW' THEN role = 'raw'
    WHEN 'PRM' THEN role IN ('pic', 'clip')
  END, false);

-- Public ID with the minimal padding of SPEC §4.1: `PPV-073`, `FYP-0412`, `PPV-1000`.
CREATE FUNCTION public_item_id(item_type text, item_number integer) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN item_type || '-' || lpad(
    item_number::text,
    greatest(CASE WHEN item_type IN ('FYP', 'RAW') THEN 4 ELSE 3 END, length(item_number::text)),
    '0'
  );

-- A sealed composition (manifest, receipt) is inserted whole in one transaction: at commit
-- the header's `entry_count` equals the number of rows and their positions are 1..N.
-- Arguments: parent table, child table, child FK column. A late row fails its transaction.
CREATE FUNCTION check_sealed_count() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  parent_table text := TG_ARGV[0];
  child_table text := TG_ARGV[1];
  fk_column text := TG_ARGV[2];
  parent_id uuid;
  expected integer;
  actual integer;
  top integer;
BEGIN
  IF TG_TABLE_NAME = parent_table THEN
    parent_id := NEW.id;
  ELSE
    parent_id := (to_jsonb(NEW) ->> fk_column)::uuid;
  END IF;
  EXECUTE format('SELECT entry_count FROM %I WHERE model_id = $1 AND id = $2', parent_table)
    INTO expected USING NEW.model_id, parent_id;
  EXECUTE format('SELECT count(*), max(position) FROM %I WHERE model_id = $1 AND %I = $2',
                 child_table, fk_column)
    INTO actual, top USING NEW.model_id, parent_id;
  IF actual IS DISTINCT FROM expected OR top IS DISTINCT FROM expected THEN
    RAISE EXCEPTION '% %: % rows up to position %, sealed with %',
      parent_table, parent_id, actual, top, expected
      USING ERRCODE = 'CO004';
  END IF;
  RETURN NULL;
END
$$;

-- A tag is shared (`model_id IS NULL`) or of the item's own model (schema §9.2): a composite
-- FK cannot express it, the referencing columns are NOT NULL.
CREATE FUNCTION check_tag_scope() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tags WHERE id = NEW.tag_id AND model_id IS NOT NULL
                                    AND model_id <> NEW.model_id) THEN
    RAISE EXCEPTION 'tag % belongs to another model', NEW.tag_id
      USING ERRCODE = 'CO006';
  END IF;
  RETURN NEW;
END
$$;

-- A resolved draft reopens only from `rejected`, into `ready`, and only while its bytes are
-- present (schema §9.2, §9.3): the row lock on the blob serialises with the owner's purge,
-- which checks references under the same lock. Accepted, appended and alias drafts stay closed.
CREATE FUNCTION inbox_draft_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'resolved'
     AND (NEW.state, NEW.outcome) IS DISTINCT FROM (OLD.state, OLD.outcome) THEN
    IF OLD.outcome <> 'rejected' OR NEW.state <> 'ready' THEN
      RAISE EXCEPTION 'draft %: % (%) → % is not allowed', OLD.id, OLD.state, OLD.outcome, NEW.state
        USING ERRCODE = 'CO005';
    END IF;
    PERFORM 1 FROM blobs WHERE sha256 IN (OLD.master_sha256, OLD.source_blob_sha256) FOR SHARE;
    IF EXISTS (SELECT 1 FROM blobs WHERE sha256 IN (OLD.master_sha256, OLD.source_blob_sha256)
                                     AND state <> 'present') THEN
      RAISE EXCEPTION 'draft %: its bytes were removed, it cannot reopen', OLD.id
        USING ERRCODE = 'CO005';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Tags (schema §3.2, §9.2)
-- ---------------------------------------------------------------------------

-- Dictionary: `model_id IS NULL` — a shared known tag; a free tag lives in its model.
CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  model_id uuid REFERENCES models (id) ON DELETE RESTRICT,
  slug text NOT NULL,
  label_ru text NOT NULL,
  tag_group text CHECK (tag_group IN ('action', 'attribute', 'mood')),
  merged_into_tag_id uuid REFERENCES tags (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  CONSTRAINT tags_slug UNIQUE NULLS NOT DISTINCT (model_id, slug)
);

-- ---------------------------------------------------------------------------
-- Intake groups (schema §3.4): a folder or cluster as the unit of acceptance
-- ---------------------------------------------------------------------------

CREATE TABLE inbox_groups (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  source_id uuid NOT NULL,
  -- Always by the source's folder ID, never by path: `folder:<id>`, `exif-day:<id>:<day>`,
  -- `upload-window:<id>:…`, `single:<file id>`, `split:<uuid>`.
  group_key text NOT NULL,
  grouping text NOT NULL CHECK (grouping IN ('folder', 'exif_day', 'upload_cluster', 'single', 'manual')),
  folder_object_id uuid,
  evidence jsonb,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  -- Fields of the future object, edited before acceptance (sample 1b); statuses in
  -- `annotation_fields` with `group_id`, moved to the object on acceptance.
  proposed_type text CHECK (proposed_type IN ('PPV', 'SET', 'SXT', 'CUS', 'FYP', 'LIFE', 'RAW', 'PRM')),
  proposed_title text,
  proposed_title_en text,
  proposed_description text,
  proposed_tags jsonb,
  proposed_ppv_kind text CHECK (proposed_ppv_kind IN ('bundle', 'dm')),
  proposed_purpose text CHECK (proposed_purpose IN ('fyp', 'ppv', 'mass_dm', 'unknown')),
  has_second_person boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, source_id, group_key),
  FOREIGN KEY (model_id, source_id) REFERENCES sources (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, folder_object_id) REFERENCES source_objects (model_id, id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- Catalog (schema §3.2, §9.2)
-- ---------------------------------------------------------------------------

-- An object of the catalog. `(model_id, type, number)` is the business key and holds a
-- tombstone too: a number is never reused. Type and number never change: a reclassification
-- is a new object with a new number and an alias.
CREATE TABLE content_items (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7(),
  type text NOT NULL CHECK (type IN ('PPV', 'SET', 'SXT', 'CUS', 'FYP', 'LIFE', 'RAW', 'PRM')),
  number integer NOT NULL CONSTRAINT content_items_number_range CHECK (number BETWEEN 1 AND 999999),
  title text,
  title_en text,
  description text,
  ppv_kind text CHECK (ppv_kind IN ('bundle', 'dm')),
  raw_purpose text CHECK (raw_purpose IN ('fyp', 'ppv', 'mass_dm', 'unknown')),
  shot_on date,
  cover_membership_id uuid,
  -- Empty means «not checked» (legacy import); asked once, at the first OnlyFans placement.
  has_second_person boolean,
  -- «Имя есть / нет» of a CUS without an order; with an order the value is the order's.
  name_in_media text CHECK (name_in_media IN ('yes', 'no', 'unknown')),
  created_from_group_id uuid,
  origin text NOT NULL CHECK (origin IN ('intake', 'import', 'manual')),
  promo_channel_id uuid,
  merged_into_item_id uuid,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  delete_reason text,
  -- Russian title and description, English short title (SPEC §12.0 «Поиск»).
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('russian'::regconfig, coalesce(title, '')), 'A')
    || setweight(to_tsvector('english'::regconfig, coalesce(title_en, '')), 'A')
    || setweight(to_tsvector('russian'::regconfig, coalesce(description, '')), 'B')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  CONSTRAINT content_items_number UNIQUE (model_id, type, number),
  -- One intake group creates at most one object.
  CONSTRAINT content_items_created_from_group UNIQUE (model_id, created_from_group_id),
  -- Target of the type copy (model_id, item_id, item_type) in child tables.
  UNIQUE (model_id, id, type),
  FOREIGN KEY (model_id, created_from_group_id) REFERENCES inbox_groups (model_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, promo_channel_id) REFERENCES promo_channels (model_id, id)
    ON DELETE RESTRICT,
  -- A merge stays inside the model.
  FOREIGN KEY (model_id, merged_into_item_id) REFERENCES content_items (model_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT content_items_ppv_kind CHECK ((type = 'PPV') = (ppv_kind IS NOT NULL)),
  CONSTRAINT content_items_raw_purpose CHECK ((type = 'RAW') = (raw_purpose IS NOT NULL)),
  CONSTRAINT content_items_promo_channel CHECK ((type = 'PRM') = (promo_channel_id IS NOT NULL)),
  CONSTRAINT content_items_name_in_media CHECK (name_in_media IS NULL OR type = 'CUS'),
  CONSTRAINT content_items_merged_deleted CHECK (merged_into_item_id IS NULL OR deleted_at IS NOT NULL)
);
CREATE INDEX content_items_updated ON content_items (model_id, updated_at DESC);
CREATE INDEX content_items_live_type ON content_items (model_id, type) WHERE deleted_at IS NULL;
CREATE INDEX content_items_shot_on ON content_items (model_id, shot_on);
CREATE INDEX content_items_search ON content_items USING gin (search_tsv);
CREATE INDEX content_items_title_trgm ON content_items
  USING gin (title gin_trgm_ops, title_en gin_trgm_ops);

-- A logical file: «master of PPV-073», «frame ed07». A unique version of a FYP (`u2`) is an
-- asset of its own with `variant_no > 0` (naming §3, §5).
CREATE TABLE assets (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  created_in_item_id uuid NOT NULL,
  media_kind text NOT NULL CHECK (media_kind IN ('video', 'image')),
  current_version_id uuid NOT NULL,
  variant_kind text NOT NULL DEFAULT 'none' CHECK (variant_kind IN ('none', 'uniq')),
  variant_no integer NOT NULL DEFAULT 0 CHECK (variant_no >= 0),
  uniq_level text CHECK (uniq_level IN ('soft', 'trim', 'mirror')),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, id),
  -- Target of FK (model_id, asset_id, variant_no): a membership copies the variant number.
  UNIQUE (model_id, id, variant_no),
  FOREIGN KEY (model_id, created_in_item_id) REFERENCES content_items (model_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT assets_variant_no CHECK ((variant_kind = 'uniq') = (variant_no > 0)),
  CONSTRAINT assets_uniq_level CHECK ((variant_kind = 'uniq') = (uniq_level IS NOT NULL))
);
-- `FYP-0012/u2` is unique inside its object.
CREATE UNIQUE INDEX assets_uniq_variant ON assets (model_id, created_in_item_id, variant_no)
  WHERE variant_kind = 'uniq';

-- An immutable edition of an asset with the hash of its master. An edit is a new version;
-- re-accepting earlier bytes is a lawful new edition, so there is no uniqueness by hash.
CREATE TABLE asset_versions (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  asset_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  master_sha256 bytea NOT NULL REFERENCES blobs (sha256) ON DELETE RESTRICT,
  source_sha256 bytea CONSTRAINT asset_versions_source_sha256_check
    CHECK (octet_length(source_sha256) = 32),
  source_revision_id uuid,
  work_id uuid,
  duration_ms bigint,
  width integer,
  height integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, asset_id, version_no),
  -- Target of every version reference: a version always belongs to its file.
  UNIQUE (model_id, asset_id, id),
  FOREIGN KEY (model_id, asset_id) REFERENCES assets (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, source_revision_id) REFERENCES source_revisions (model_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, work_id) REFERENCES work_operations (model_id, id) ON DELETE RESTRICT
);
-- «Which versions hold this blob».
CREATE INDEX asset_versions_master ON asset_versions (master_sha256);

-- The current version is a version of this asset; the asset and its first version are
-- inserted in one transaction.
ALTER TABLE assets
  ADD CONSTRAINT assets_current_version_fkey FOREIGN KEY (model_id, id, current_version_id)
    REFERENCES asset_versions (model_id, asset_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

-- Participation of a file in an object: role, number, order, selection, purpose. A file has
-- one owner; a `PRM` collection holds references. The handle (`ed07`, `u2`) is computed.
CREATE TABLE item_memberships (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  item_id uuid NOT NULL,
  item_type text NOT NULL,
  asset_id uuid NOT NULL,
  variant_no integer NOT NULL DEFAULT 0,
  kind text NOT NULL CHECK (kind IN ('owned', 'reference')),
  role text NOT NULL CHECK (role IN ('master', 'teaser', 'pic', 'raw', 'ed', 'clip', 'thumb', 'cap')),
  ordinal integer CONSTRAINT item_memberships_ordinal_range CHECK (ordinal BETWEEN 1 AND 999),
  display_position integer,
  selected boolean NOT NULL DEFAULT false,
  -- LIFE only: the frame goes to the feed, to chats or both; the status of the `purpose`
  -- field is on the version.
  life_use text CHECK (life_use IN ('feed', 'chats', 'both')),
  -- A reference only: NULL follows the current version.
  pinned_version_id uuid,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  removed_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, item_id, asset_id),
  -- Target of the cover FK: the cover is a membership of its own object.
  UNIQUE (model_id, item_id, id),
  -- Reordering is one transaction.
  CONSTRAINT item_memberships_display_position UNIQUE (model_id, item_id, display_position)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (model_id, item_id, item_type) REFERENCES content_items (model_id, id, type)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, asset_id, variant_no) REFERENCES assets (model_id, id, variant_no)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, asset_id, pinned_version_id) REFERENCES asset_versions (model_id, asset_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT item_memberships_ordinal CHECK ((role IN ('pic', 'raw', 'ed', 'clip')) = (ordinal IS NOT NULL)),
  CONSTRAINT item_memberships_reference_in_prm CHECK (kind = 'owned' OR item_type = 'PRM'),
  CONSTRAINT item_memberships_role_fits_type CHECK (kind = 'reference' OR role_fits_type(item_type, role)),
  -- `_uN` only on the master of a FYP (naming §3, §5).
  CONSTRAINT item_memberships_variant
    CHECK (kind = 'reference' OR variant_no = 0 OR (item_type = 'FYP' AND role = 'master')),
  CONSTRAINT item_memberships_life_use CHECK (life_use IS NULL OR item_type = 'LIFE'),
  CONSTRAINT item_memberships_pinned CHECK (pinned_version_id IS NULL OR kind = 'reference'),
  CONSTRAINT item_memberships_removed_position CHECK (removed_at IS NULL OR display_position IS NULL)
);
-- A sub-handle never goes to another file: the key holds removed memberships too, and NULL
-- ordinals are equal (`master`, `u1`, `u2` live side by side).
CREATE UNIQUE INDEX item_memberships_handle
  ON item_memberships (model_id, item_id, role, ordinal, variant_no) NULLS NOT DISTINCT
  WHERE kind = 'owned';
-- One owner per file.
CREATE UNIQUE INDEX item_memberships_one_owner ON item_memberships (model_id, asset_id)
  WHERE kind = 'owned' AND removed_at IS NULL;
CREATE INDEX item_memberships_item ON item_memberships (model_id, item_id, removed_at, display_position);
-- «Where else is this frame».
CREATE INDEX item_memberships_asset ON item_memberships (model_id, asset_id, removed_at);

ALTER TABLE content_items
  ADD CONSTRAINT content_items_cover_fkey FOREIGN KEY (model_id, id, cover_membership_id)
    REFERENCES item_memberships (model_id, item_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

-- A sealed composition of versions: plan row, download, delivery, submission (schema §9.2).
-- Inserted whole by one short transaction; never updated or deleted; a change is a new one.
CREATE TABLE asset_manifests (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  purpose text NOT NULL CHECK (purpose IN ('plan', 'download', 'delivery', 'submission')),
  origin_item_id uuid,
  entry_count integer NOT NULL CHECK (entry_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, id),
  FOREIGN KEY (model_id, origin_item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT
);

CREATE TABLE asset_manifest_entries (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  manifest_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  item_id uuid NOT NULL,
  membership_id uuid,
  asset_id uuid NOT NULL,
  asset_version_id uuid NOT NULL,
  handle_snapshot text NOT NULL,
  selected_snapshot boolean,
  life_use_snapshot text CHECK (life_use_snapshot IN ('feed', 'chats', 'both')),
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, manifest_id, position),
  FOREIGN KEY (model_id, manifest_id) REFERENCES asset_manifests (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, membership_id) REFERENCES item_memberships (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, asset_id, asset_version_id) REFERENCES asset_versions (model_id, asset_id, id)
    ON DELETE RESTRICT
);
CREATE INDEX asset_manifest_entries_version ON asset_manifest_entries (model_id, asset_version_id);

-- A historical reference: old ID, name, path (naming §9). No uniqueness by value: an old
-- `PPV-032` named three folders; a repeated import adds no rows.
CREATE TABLE aliases (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN (
    'legacy_path', 'legacy_name', 'legacy_id', 'sub_handle', 'merged_id', 'vault_album',
    'tg_card', 'resource_id', 'registry_row'
  )),
  value_raw text NOT NULL,
  value_norm text NOT NULL GENERATED ALWAYS AS (lower(normalize(value_raw, NFC))) STORED,
  item_id uuid,
  asset_id uuid,
  source_object_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, id),
  CONSTRAINT aliases_value UNIQUE NULLS NOT DISTINCT (model_id, kind, value_norm, item_id, asset_id),
  FOREIGN KEY (model_id, item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, asset_id) REFERENCES assets (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, source_object_id) REFERENCES source_objects (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT aliases_one_target CHECK (num_nonnulls(item_id, asset_id) = 1)
);
CREATE INDEX aliases_value_norm ON aliases (model_id, value_norm);
CREATE INDEX aliases_value_trgm ON aliases USING gin (value_norm gin_trgm_ops);

-- Directed provenance between objects (`PPV ← CUS`) or versions (`ed07 v1 ← raw07 v1`).
-- A cycle is checked by the command under the object locks.
CREATE TABLE provenance (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  relation text NOT NULL CHECK (relation IN (
    'montage_from', 'uniq_from', 'teaser_from', 'frame_from', 'processed_from', 'ppv_from_custom',
    'extracted_from', 'remaster_from', 'split_from', 'merged_from', 'reencoded_from'
  )),
  child_item_id uuid,
  child_version_id uuid,
  parent_item_id uuid,
  parent_version_id uuid,
  params jsonb,
  basis text,
  work_id uuid,
  voided_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, id),
  CONSTRAINT provenance_link UNIQUE NULLS NOT DISTINCT
    (model_id, relation, child_item_id, child_version_id, parent_item_id, parent_version_id),
  FOREIGN KEY (model_id, child_item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, child_version_id) REFERENCES asset_versions (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, parent_item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, parent_version_id) REFERENCES asset_versions (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, work_id) REFERENCES work_operations (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, voided_by_id) REFERENCES provenance (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT provenance_one_child CHECK (num_nonnulls(child_item_id, child_version_id) = 1),
  CONSTRAINT provenance_one_parent CHECK (num_nonnulls(parent_item_id, parent_version_id) = 1),
  CONSTRAINT provenance_not_self
    CHECK (NOT (child_item_id = parent_item_id) AND NOT (child_version_id = parent_version_id))
);
CREATE INDEX provenance_child_item ON provenance (model_id, child_item_id);
CREATE INDEX provenance_child_version ON provenance (model_id, child_version_id);
CREATE INDEX provenance_parent_item ON provenance (model_id, parent_item_id);
CREATE INDEX provenance_parent_version ON provenance (model_id, parent_version_id);
-- The badge «готов для PPV» / «PPV из кастома сделан».
CREATE INDEX provenance_ppv_from_custom ON provenance (model_id, parent_item_id)
  WHERE relation = 'ppv_from_custom';
-- A correction has one successor.
CREATE UNIQUE INDEX provenance_voided_by ON provenance (model_id, voided_by_id)
  WHERE voided_by_id IS NOT NULL;

-- Tags of an object. `id` is the journal subject; the key is (model, item, tag).
CREATE TABLE item_tags (
  model_id uuid NOT NULL,
  item_id uuid NOT NULL,
  tag_id uuid NOT NULL REFERENCES tags (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7() UNIQUE,
  source text NOT NULL CHECK (source IN ('ai', 'human', 'import')),
  group_at_import text CHECK (group_at_import IN ('action', 'attribute', 'mood')),
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, item_id, tag_id),
  FOREIGN KEY (model_id, item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT
);
-- Combinations of tags.
CREATE INDEX item_tags_tag ON item_tags (model_id, tag_id);

-- Chronology by minutes of a version (SPEC §8.3). Its status is the `chronology` field of the
-- version: a re-edit keeps the confirmed chronology with the earlier version.
CREATE TABLE chronology_entries (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  item_id uuid NOT NULL,
  asset_version_id uuid NOT NULL,
  at_ms bigint NOT NULL CHECK (at_ms >= 0),
  end_ms bigint,
  text text NOT NULL,
  source text NOT NULL CHECK (source IN ('ai', 'human', 'import')),
  -- A frame that may become a teaser.
  frame_artifact_id uuid REFERENCES rendition_artifacts (id) ON DELETE RESTRICT,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('russian'::regconfig, text)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, asset_version_id, at_ms),
  FOREIGN KEY (model_id, item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, asset_version_id) REFERENCES asset_versions (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT chronology_entries_span CHECK (end_ms IS NULL OR end_ms > at_ms)
);
CREATE INDEX chronology_entries_item ON chronology_entries (model_id, item_id, at_ms);
CREATE INDEX chronology_entries_search ON chronology_entries USING gin (tsv);

-- Selling texts and `platform_title` (PRD §5, naming §4): `generic/en/1`, `generic/en/2`; a
-- page variant is its own row. Never in file names or vault albums.
CREATE TABLE platform_texts (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  item_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('generic', 'fansly', 'onlyfans')),
  account_id uuid,
  locale text NOT NULL CONSTRAINT platform_texts_locale_format CHECK (locale ~ '^[a-z]{2}$'),
  variant_no integer NOT NULL DEFAULT 1 CHECK (variant_no >= 1),
  title text,
  body text,
  value_version bigint NOT NULL DEFAULT 1 CHECK (value_version >= 0),
  confirmed_value_version bigint,
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('ai', 'human', 'import')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, id),
  CONSTRAINT platform_texts_variant UNIQUE NULLS NOT DISTINCT
    (model_id, item_id, platform, account_id, locale, variant_no),
  FOREIGN KEY (model_id, item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, account_id) REFERENCES accounts (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT platform_texts_account CHECK (account_id IS NULL OR platform <> 'generic'),
  CONSTRAINT platform_texts_confirmed CHECK (
    (confirmed_at IS NULL) = (confirmed_value_version IS NULL)
    AND (confirmed_value_version IS NULL OR confirmed_value_version <= value_version)
  )
);

-- ---------------------------------------------------------------------------
-- Intake (schema §3.4, §9.2, §9.7)
-- ---------------------------------------------------------------------------

-- A web upload (tus): received and checked, it becomes a blob, then a draft of the usual
-- intake (`inbox_drafts.web_upload_id`, one draft per upload).
CREATE TABLE web_uploads (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  upload_id text NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals (id) ON DELETE RESTRICT,
  client_filename text NOT NULL,
  declared_kind text NOT NULL CHECK (declared_kind IN (
    'fyp_edit', 'teaser', 'processed_frames', 'master_version', 'other'
  )),
  target_item_id uuid,
  size_expected bigint NOT NULL CHECK (size_expected >= 0),
  bytes_received bigint NOT NULL DEFAULT 0 CHECK (bytes_received >= 0),
  sha256 bytea REFERENCES blobs (sha256) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'receiving' CHECK (state IN (
    'receiving', 'received', 'verified', 'registered', 'failed', 'abandoned'
  )),
  tmp_key text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, upload_id),
  FOREIGN KEY (model_id, target_item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT web_uploads_progress CHECK (bytes_received <= size_expected),
  CONSTRAINT web_uploads_registered CHECK (state <> 'registered' OR sha256 IS NOT NULL)
);
CREATE INDEX web_uploads_unfinished ON web_uploads (model_id, created_at)
  WHERE state IN ('receiving', 'received', 'verified');
CREATE INDEX web_uploads_sha256 ON web_uploads (sha256) WHERE sha256 IS NOT NULL;

-- A draft of intake from the moment of discovery (SPEC §5, §6.1). Never deleted: objects
-- and versions point at it. A background error and a person's refusal are different fields.
CREATE TABLE inbox_drafts (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  -- A single file is a group of one draft.
  group_id uuid NOT NULL,
  source_revision_id uuid,
  web_upload_id uuid,
  -- «PPV из кастома как есть», «мастер PPV», «исходник фупа» from an accepted version.
  from_version_id uuid,
  origin text NOT NULL CHECK (origin IN ('disk_scan', 'web_upload', 'legacy_import', 'archive', 'derived')),
  state text NOT NULL DEFAULT 'discovered' CHECK (state IN ('discovered', 'processing', 'ready', 'resolved')),
  outcome text CHECK (outcome IN ('new_item', 'append', 'alias', 'rejected')),
  priority integer NOT NULL DEFAULT 0,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  decided_at timestamptz,
  decided_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  -- What the source says, for «Приехало» before download.
  md5 bytea CONSTRAINT inbox_drafts_md5_check CHECK (octet_length(md5) = 16),
  byte_size bigint CHECK (byte_size >= 0),
  path text,
  preview_url_at timestamptz,
  -- Steps 1 and 3 of the background chain.
  source_sha256 bytea CONSTRAINT inbox_drafts_source_sha256_check CHECK (octet_length(source_sha256) = 32),
  source_blob_sha256 bytea REFERENCES blobs (sha256) ON DELETE RESTRICT,
  master_sha256 bytea REFERENCES blobs (sha256) ON DELETE RESTRICT,
  master_verified_at timestamptz,
  master_is_source boolean NOT NULL DEFAULT false,
  -- Step 4 for the file; fields of the future object live on the group.
  proposed_role text CHECK (proposed_role IN ('master', 'teaser', 'pic', 'raw', 'ed', 'clip', 'thumb', 'cap')),
  proposed_ordinal integer CHECK (proposed_ordinal BETWEEN 1 AND 999),
  proposed_life_use text CHECK (proposed_life_use IN ('feed', 'chats', 'both')),
  target_item_id uuid,
  target_asset_id uuid,
  duplicate_of_version_id uuid,
  blocked_reason text CHECK (blocked_reason IN (
    'ambiguous_order', 'video_in_set', 'id_collision', 'cross_model_dup', 'master_failed',
    'needs_type', 'source_unavailable', 'deferred', 'which_frame'
  )),
  applied_item_id uuid,
  applied_version_id uuid,
  reject_reason text,
  rejected_at timestamptz,
  reopened_at timestamptz,
  reopen_count integer NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  error text,
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('russian'::regconfig, translate(coalesce(path, ''), '/._-', '    '))
  ) STORED,
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  -- One source revision, one draft; one upload, one draft.
  CONSTRAINT inbox_drafts_source_revision UNIQUE (model_id, source_revision_id),
  CONSTRAINT inbox_drafts_web_upload UNIQUE (model_id, web_upload_id),
  FOREIGN KEY (model_id, group_id) REFERENCES inbox_groups (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, source_revision_id) REFERENCES source_revisions (model_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, web_upload_id) REFERENCES web_uploads (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, from_version_id) REFERENCES asset_versions (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, target_item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, target_asset_id) REFERENCES assets (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, duplicate_of_version_id) REFERENCES asset_versions (model_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, applied_item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, applied_version_id) REFERENCES asset_versions (model_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT inbox_drafts_one_input
    CHECK (num_nonnulls(source_revision_id, web_upload_id, from_version_id) = 1),
  CONSTRAINT inbox_drafts_outcome CHECK ((state = 'resolved') = (outcome IS NOT NULL)),
  -- Accept only with a verified master (SPEC §6.1); a duplicate or a refusal needs none.
  CONSTRAINT inbox_drafts_accept_verified
    CHECK (outcome NOT IN ('new_item', 'append') OR master_verified_at IS NOT NULL),
  CONSTRAINT inbox_drafts_accept_applied
    CHECK (outcome NOT IN ('new_item', 'append') OR applied_item_id IS NOT NULL),
  CONSTRAINT inbox_drafts_verified_master CHECK (master_verified_at IS NULL OR master_sha256 IS NOT NULL),
  CONSTRAINT inbox_drafts_alias_target CHECK (outcome <> 'alias' OR duplicate_of_version_id IS NOT NULL),
  CONSTRAINT inbox_drafts_rejected_at CHECK (outcome <> 'rejected' OR rejected_at IS NOT NULL)
);
CREATE INDEX inbox_drafts_queue ON inbox_drafts (model_id, state, priority DESC, discovered_at);
CREATE INDEX inbox_drafts_group ON inbox_drafts (model_id, group_id);
CREATE INDEX inbox_drafts_blocked ON inbox_drafts (model_id, blocked_reason)
  WHERE blocked_reason IS NOT NULL;
CREATE INDEX inbox_drafts_master ON inbox_drafts (master_sha256);
CREATE INDEX inbox_drafts_source_blob ON inbox_drafts (source_blob_sha256);
CREATE INDEX inbox_drafts_source_sha256 ON inbox_drafts (source_sha256);
-- A draft is in search at once (PRD §5).
CREATE INDEX inbox_drafts_search ON inbox_drafts USING gin (search_tsv);

-- The status of each markup field (SPEC §5, §8.3): `confirmed` ⇔ the confirmed version is the
-- current one. The target is exactly one of an object, a version, a group or a draft; group
-- and draft statuses move to the object and versions on acceptance (UPDATE of the target).
CREATE TABLE annotation_fields (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  item_id uuid,
  version_id uuid,
  group_id uuid,
  draft_id uuid,
  field text NOT NULL CHECK (field IN (
    'title', 'title_en', 'description', 'tags', 'chronology', 'purpose', 'second_person'
  )),
  value_version bigint NOT NULL DEFAULT 0 CHECK (value_version >= 0),
  confirmed_value_version bigint,
  confirmed_at timestamptz,
  confirmed_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, id),
  CONSTRAINT annotation_fields_target UNIQUE NULLS NOT DISTINCT
    (model_id, item_id, version_id, group_id, draft_id, field),
  FOREIGN KEY (model_id, item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, version_id) REFERENCES asset_versions (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, group_id) REFERENCES inbox_groups (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, draft_id) REFERENCES inbox_drafts (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT annotation_fields_one_target CHECK (num_nonnulls(item_id, version_id, group_id, draft_id) = 1),
  CONSTRAINT annotation_fields_confirmed CHECK (
    (confirmed_at IS NULL) = (confirmed_value_version IS NULL)
    AND (confirmed_value_version IS NULL OR confirmed_value_version <= value_version)
  )
);
CREATE INDEX annotation_fields_version ON annotation_fields (model_id, version_id)
  WHERE version_id IS NOT NULL;

-- Candidate links of a draft with evidence (SPEC §6.1, §6.2, §8.2). A match by duration and
-- date alone is never chosen automatically. `order_id` gets its FK with `0004_orders`.
CREATE TABLE inbox_draft_candidates (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  draft_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'order', 'existing_item', 'exact_duplicate', 'similar_photo', 'legacy_id', 'source_parent',
    'content_type'
  )),
  order_id uuid,
  item_id uuid,
  version_id uuid,
  score double precision,
  signals jsonb,
  evidence_refs jsonb,
  conflicts_with uuid[],
  chosen boolean NOT NULL DEFAULT false,
  chosen_at timestamptz,
  chosen_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, id),
  CONSTRAINT inbox_draft_candidates_link UNIQUE NULLS NOT DISTINCT
    (model_id, draft_id, kind, order_id, item_id, version_id),
  FOREIGN KEY (model_id, draft_id) REFERENCES inbox_drafts (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, version_id) REFERENCES asset_versions (model_id, id) ON DELETE RESTRICT
);
-- One chosen candidate per kind.
CREATE UNIQUE INDEX inbox_draft_candidates_chosen ON inbox_draft_candidates (model_id, draft_id, kind)
  WHERE chosen;

-- A disputed case whose decision must be recorded (SPEC §6.3). Not what evidence computes,
-- not what lives elsewhere (number disputes, order choice).
CREATE TABLE review_cases (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN (
    'cross_model_duplicate', 'legacy_unparsed', 'merge_split', 'unreadable_input'
  )),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'dismissed')),
  dedup_key text NOT NULL,
  draft_id uuid,
  item_id uuid,
  version_id uuid,
  source_object_id uuid,
  -- A fingerprint, not a reference: a case never holds bytes.
  blob_sha256 bytea CONSTRAINT review_cases_blob_sha256_check CHECK (octet_length(blob_sha256) = 32),
  -- Visible only to whoever has rights on both models.
  counterpart_model_id uuid REFERENCES models (id) ON DELETE RESTRICT,
  details jsonb,
  resolution jsonb,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, kind, dedup_key),
  FOREIGN KEY (model_id, draft_id) REFERENCES inbox_drafts (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, version_id) REFERENCES asset_versions (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, source_object_id) REFERENCES source_objects (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT review_cases_resolved CHECK ((state = 'open') = (resolved_at IS NULL))
);

-- ---------------------------------------------------------------------------
-- Issue receipts (schema §3.5, §9.2): what exactly was issued, sealed like a manifest
-- ---------------------------------------------------------------------------

-- Inserted whole when bytes, names and hashes are known; the source is always a sealed
-- manifest (a single download from the card is a manifest of one). A correction is a new
-- receipt with `corrects_id`. Plan row and promo delivery links arrive with their stages.
CREATE TABLE download_receipts (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  principal_id uuid NOT NULL REFERENCES principals (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('master', 'platform', 'edit', 'promo')),
  manifest_id uuid NOT NULL,
  account_code_snapshot text,
  slot_date_snapshot date,
  meta_stripped boolean NOT NULL,
  zip_key text,
  entry_count integer NOT NULL CHECK (entry_count > 0),
  corrects_id uuid,
  issued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, id),
  FOREIGN KEY (model_id, manifest_id) REFERENCES asset_manifests (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, corrects_id) REFERENCES download_receipts (model_id, id) ON DELETE RESTRICT
);
CREATE INDEX download_receipts_issued ON download_receipts (model_id, issued_at DESC);
CREATE UNIQUE INDEX download_receipts_corrects ON download_receipts (model_id, corrects_id)
  WHERE corrects_id IS NOT NULL;

-- One issued file: exactly one of a derivative artifact, the master as is, or a file in the
-- exports folder. The hash stays even when the derivative is gone.
CREATE TABLE download_receipt_entries (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  receipt_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  asset_id uuid NOT NULL,
  asset_version_id uuid NOT NULL,
  rendition_artifact_id uuid,
  issued_master boolean NOT NULL DEFAULT false,
  export_key text,
  file_name text NOT NULL,
  file_name_norm text NOT NULL GENERATED ALWAYS AS (lower(normalize(file_name, NFC))) STORED,
  output_sha256 bytea NOT NULL CONSTRAINT download_receipt_entries_output_sha256_check
    CHECK (octet_length(output_sha256) = 32),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  duration_ms bigint,
  width integer,
  height integer,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, receipt_id, position),
  -- Target of FK (model_id, matched_version_id, receipt_entry_id) from Hub matches (schema §9.6).
  UNIQUE (model_id, asset_version_id, id),
  FOREIGN KEY (model_id, receipt_id) REFERENCES download_receipts (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, asset_id, asset_version_id) REFERENCES asset_versions (model_id, asset_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (rendition_artifact_id, output_sha256) REFERENCES rendition_artifacts (id, output_sha256)
    ON DELETE RESTRICT,
  CONSTRAINT download_receipt_entries_one_file
    CHECK (num_nonnulls(rendition_artifact_id, export_key) + issued_master::integer = 1)
);
-- The download name of ContentOps is exact evidence on Hub (SPEC §7).
CREATE INDEX download_receipt_entries_name ON download_receipt_entries (model_id, file_name_norm);
CREATE INDEX download_receipt_entries_version ON download_receipt_entries (model_id, asset_version_id, receipt_id);

-- ---------------------------------------------------------------------------
-- Typed targets of background work (schema §3.4): composite FKs inside the model
-- ---------------------------------------------------------------------------

ALTER TABLE work_operations
  ADD COLUMN draft_id uuid,
  ADD COLUMN source_revision_id uuid,
  ADD COLUMN asset_version_id uuid,
  ADD COLUMN manifest_id uuid,
  ADD COLUMN receipt_id uuid,
  ADD COLUMN generation_id uuid REFERENCES rendition_generations (id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (model_id, draft_id) REFERENCES inbox_drafts (model_id, id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (model_id, source_revision_id) REFERENCES source_revisions (model_id, id)
    ON DELETE RESTRICT,
  ADD FOREIGN KEY (model_id, asset_version_id) REFERENCES asset_versions (model_id, id)
    ON DELETE RESTRICT,
  ADD FOREIGN KEY (model_id, manifest_id) REFERENCES asset_manifests (model_id, id) ON DELETE RESTRICT,
  ADD FOREIGN KEY (model_id, receipt_id) REFERENCES download_receipts (model_id, id) ON DELETE RESTRICT,
  -- A row without a model carries no model targets (a composite FK skips a NULL model).
  DROP CONSTRAINT work_operations_model_targets,
  ADD CONSTRAINT work_operations_model_targets CHECK (
    model_id IS NOT NULL
    OR num_nonnulls(account_id, draft_id, source_revision_id, asset_version_id, manifest_id, receipt_id) = 0
  );
CREATE INDEX work_operations_draft ON work_operations (model_id, draft_id) WHERE draft_id IS NOT NULL;

DROP TRIGGER work_operations_inputs_fixed ON work_operations;
CREATE TRIGGER work_operations_inputs_fixed
  BEFORE UPDATE ON work_operations
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'kind', 'work_key', 'account_id', 'dataset', 'scope', 'window_from', 'window_to',
    'draft_id', 'source_revision_id', 'asset_version_id', 'manifest_id', 'receipt_id', 'generation_id'
  );

-- ---------------------------------------------------------------------------
-- Sealed compositions, append-only tables and fixed columns (schema §9.4)
-- ---------------------------------------------------------------------------

CREATE CONSTRAINT TRIGGER asset_manifests_sealed AFTER INSERT ON asset_manifests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION check_sealed_count('asset_manifests', 'asset_manifest_entries', 'manifest_id');
CREATE CONSTRAINT TRIGGER asset_manifest_entries_sealed AFTER INSERT ON asset_manifest_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION check_sealed_count('asset_manifests', 'asset_manifest_entries', 'manifest_id');
CREATE CONSTRAINT TRIGGER download_receipts_sealed AFTER INSERT ON download_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION check_sealed_count('download_receipts', 'download_receipt_entries', 'receipt_id');
CREATE CONSTRAINT TRIGGER download_receipt_entries_sealed AFTER INSERT ON download_receipt_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION check_sealed_count('download_receipts', 'download_receipt_entries', 'receipt_id');

CREATE TRIGGER asset_versions_append_only BEFORE UPDATE OR DELETE ON asset_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER asset_manifests_append_only BEFORE UPDATE OR DELETE ON asset_manifests
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER asset_manifest_entries_append_only BEFORE UPDATE OR DELETE ON asset_manifest_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER download_receipts_append_only BEFORE UPDATE OR DELETE ON download_receipts
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER download_receipt_entries_append_only BEFORE UPDATE OR DELETE ON download_receipt_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

REVOKE UPDATE, DELETE ON asset_versions, asset_manifests, asset_manifest_entries, download_receipts,
  download_receipt_entries FROM contentops_app;

CREATE TRIGGER tags_fixed BEFORE UPDATE ON tags
  FOR EACH ROW EXECUTE FUNCTION forbid_change('id', 'model_id');
CREATE TRIGGER inbox_groups_fixed BEFORE UPDATE ON inbox_groups
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'source_id', 'group_key');
CREATE TRIGGER content_items_fixed BEFORE UPDATE ON content_items
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'type', 'number');
CREATE TRIGGER assets_fixed BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'created_in_item_id', 'media_kind', 'variant_kind', 'variant_no', 'uniq_level'
  );
CREATE TRIGGER item_memberships_fixed BEFORE UPDATE ON item_memberships
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'item_id', 'item_type', 'asset_id', 'variant_no', 'kind'
  );
CREATE TRIGGER aliases_fixed BEFORE UPDATE ON aliases
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'kind', 'value_raw');
CREATE TRIGGER provenance_fixed BEFORE UPDATE ON provenance
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'relation', 'child_item_id', 'child_version_id', 'parent_item_id',
    'parent_version_id'
  );
CREATE TRIGGER item_tags_fixed BEFORE UPDATE ON item_tags
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'item_id', 'tag_id', 'id');
CREATE TRIGGER chronology_entries_fixed BEFORE UPDATE ON chronology_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'item_id', 'asset_version_id');
CREATE TRIGGER platform_texts_fixed BEFORE UPDATE ON platform_texts
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'item_id', 'platform', 'account_id', 'locale', 'variant_no'
  );
CREATE TRIGGER web_uploads_fixed BEFORE UPDATE ON web_uploads
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'upload_id', 'principal_id', 'size_expected');
CREATE TRIGGER inbox_drafts_fixed BEFORE UPDATE ON inbox_drafts
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'source_revision_id', 'web_upload_id', 'from_version_id', 'origin'
  );
CREATE TRIGGER inbox_drafts_transition BEFORE UPDATE ON inbox_drafts
  FOR EACH ROW EXECUTE FUNCTION inbox_draft_transition();
CREATE TRIGGER annotation_fields_fixed BEFORE UPDATE ON annotation_fields
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'field');
CREATE TRIGGER inbox_draft_candidates_fixed BEFORE UPDATE ON inbox_draft_candidates
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'draft_id', 'kind', 'order_id', 'item_id', 'version_id'
  );
CREATE TRIGGER review_cases_fixed BEFORE UPDATE ON review_cases
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'kind', 'dedup_key');

CREATE TRIGGER item_tags_tag_scope BEFORE INSERT ON item_tags
  FOR EACH ROW EXECUTE FUNCTION check_tag_scope();

-- ---------------------------------------------------------------------------
-- Journal: every mutable table of this file (schema §9.3)
-- ---------------------------------------------------------------------------

CREATE TRIGGER tags_journal AFTER INSERT OR UPDATE OR DELETE ON tags
  FOR EACH ROW EXECUTE FUNCTION log_row_change('id');
CREATE TRIGGER inbox_groups_journal AFTER INSERT OR UPDATE OR DELETE ON inbox_groups
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER content_items_journal AFTER INSERT OR UPDATE OR DELETE ON content_items
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER assets_journal AFTER INSERT OR UPDATE OR DELETE ON assets
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER item_memberships_journal AFTER INSERT OR UPDATE OR DELETE ON item_memberships
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER aliases_journal AFTER INSERT OR UPDATE OR DELETE ON aliases
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER provenance_journal AFTER INSERT OR UPDATE OR DELETE ON provenance
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER item_tags_journal AFTER INSERT OR UPDATE OR DELETE ON item_tags
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'item_id', 'tag_id');
CREATE TRIGGER chronology_entries_journal AFTER INSERT OR UPDATE OR DELETE ON chronology_entries
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER platform_texts_journal AFTER INSERT OR UPDATE OR DELETE ON platform_texts
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER web_uploads_journal AFTER INSERT OR UPDATE OR DELETE ON web_uploads
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER inbox_drafts_journal AFTER INSERT OR UPDATE OR DELETE ON inbox_drafts
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER annotation_fields_journal AFTER INSERT OR UPDATE OR DELETE ON annotation_fields
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER inbox_draft_candidates_journal AFTER INSERT OR UPDATE OR DELETE ON inbox_draft_candidates
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER review_cases_journal AFTER INSERT OR UPDATE OR DELETE ON review_cases
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');

-- ---------------------------------------------------------------------------
-- Reference contract of bytes (schema §1 p. 6, §5, §9.4)
-- ---------------------------------------------------------------------------

-- True while something in the database holds the blob: the master of any version (old ones
-- too), the hashes of an unresolved draft, an upload still in progress, the output of an
-- unfinished work. Derivatives are not references. The owner's purge calls it under the row
-- lock of the blob; a test compares this list with every FK on `blobs (sha256)`.
CREATE FUNCTION blob_is_referenced(sha bytea) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN EXISTS (SELECT 1 FROM asset_versions v WHERE v.master_sha256 = sha)
    OR EXISTS (SELECT 1 FROM inbox_drafts d WHERE d.master_sha256 = sha AND d.state <> 'resolved')
    OR EXISTS (SELECT 1 FROM inbox_drafts d WHERE d.source_blob_sha256 = sha AND d.state <> 'resolved')
    OR EXISTS (SELECT 1 FROM web_uploads u WHERE u.sha256 = sha
                                            AND u.state IN ('receiving', 'received', 'verified'))
    OR EXISTS (SELECT 1 FROM work_operations w WHERE w.output_sha256 = sha
                                                AND w.state IN ('pending', 'running', 'retry_wait'));

-- ---------------------------------------------------------------------------
-- Search (SPEC §11.2, §12.0 «Поиск»)
-- ---------------------------------------------------------------------------

-- The query of the words the shared parser left for full-text search: Russian and English
-- stemming (`russian` also stems ASCII words as English).
CREATE FUNCTION catalog_tsquery(q text) RETURNS tsquery
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN websearch_to_tsquery('russian'::regconfig, q) || websearch_to_tsquery('english'::regconfig, q);

-- Objects of a model found by title, English title and description, by an alias (old ID,
-- name, path; a substring, case and NFC ignored) and by chronology. Tombstones stay out.
CREATE FUNCTION catalog_search(p_model_id uuid, q text)
  RETURNS TABLE (item_id uuid, rank real)
  LANGUAGE sql STABLE PARALLEL SAFE
BEGIN ATOMIC
  WITH query AS (
    SELECT catalog_tsquery(q) AS ts,
           lower(normalize(q, NFC)) AS norm,
           '%' || replace(replace(replace(lower(normalize(q, NFC)), '\', '\\'), '%', '\%'), '_', '\_')
             || '%' AS pattern
  ), hits AS (
    SELECT i.id AS item_id, ts_rank(i.search_tsv, query.ts) AS rank
      FROM content_items i, query
     WHERE i.model_id = p_model_id AND i.search_tsv @@ query.ts
    UNION ALL
    SELECT coalesce(a.item_id, owner.item_id), CASE WHEN a.value_norm = query.norm THEN 1.0 ELSE 0.5 END
      FROM aliases a
      CROSS JOIN query
      LEFT JOIN item_memberships owner
        ON owner.model_id = a.model_id AND owner.asset_id = a.asset_id
       AND owner.kind = 'owned' AND owner.removed_at IS NULL
     WHERE a.model_id = p_model_id AND query.norm <> '' AND a.value_norm LIKE query.pattern
    UNION ALL
    SELECT c.item_id, ts_rank(c.tsv, query.ts)
      FROM chronology_entries c, query
     WHERE c.model_id = p_model_id AND c.tsv @@ query.ts
  )
  SELECT h.item_id, max(h.rank)::real
    FROM hits h
    JOIN content_items i ON i.model_id = p_model_id AND i.id = h.item_id
   WHERE i.deleted_at IS NULL
   GROUP BY h.item_id
   ORDER BY 2 DESC, 1;
END;

-- ---------------------------------------------------------------------------
-- Compact catalog index of a model (SPEC §12.0 «Интерфейс», DESIGN §10.2)
-- ---------------------------------------------------------------------------

-- One row per live object with what instant filters and sorts need. Not here until their
-- stage: the order date and link of a custom (`0004_orders`), placements (stage 3+).
-- Counts and sizes are over live memberships (owned and references), variants `uN` aside.
CREATE VIEW catalog_index WITH (security_invoker = true) AS
SELECT
  i.model_id,
  i.id AS item_id,
  public_item_id(i.type, i.number) AS public_id,
  i.type,
  i.number,
  i.title,
  i.title_en,
  coalesce(tg.slugs, '{}'::text[]) AS tags,
  CASE
    WHEN af.confirmed > 0 AND af.confirmed = af.total THEN 'confirmed'
    WHEN af.confirmed > 0 THEN 'partial'
    ELSE 'draft'
  END AS markup_state,
  cv.version_id AS cover_version_id,
  cv.width AS cover_width,
  cv.height AS cover_height,
  cv.thumb320_generation_id AS cover_thumb320_generation_id,
  cv.thumb640_generation_id AS cover_thumb640_generation_id,
  m.duration_ms,
  m.photo_count,
  m.video_count,
  m.version_count,
  coalesce(m.has_teaser, false) AS has_teaser,
  m.size_bytes,
  coalesce(arrival.arrived_at, i.created_at) AS arrived_at,
  i.shot_on,
  i.ppv_kind,
  i.raw_purpose,
  ppv.public_id AS ppv_made_as,
  i.name_in_media,
  i.has_second_person,
  CASE WHEN i.type = 'SET' THEN coalesce(m.selected_count, 0) END AS selected_count,
  CASE WHEN i.type = 'SET' THEN coalesce(m.processed_count, 0) END AS processed_count,
  CASE WHEN i.type = 'LIFE' THEN coalesce(m.life_unassigned, 0) END AS life_unassigned,
  CASE WHEN i.type = 'LIFE' THEN coalesce(m.life_chat_count, 0) END AS life_chat_count,
  CASE WHEN i.type = 'LIFE' THEN coalesce(m.life_feed_count, 0) END AS life_feed_count,
  (i.type = 'CUS' AND coalesce(m.video_count, 0) = 0 AND coalesce(m.photo_count, 0) > 0) AS photo_custom,
  coalesce(al.aliases, '{}'::text[]) AS aliases,
  pc.code AS promo_channel_code,
  i.created_at,
  i.updated_at
FROM content_items i
LEFT JOIN promo_channels pc ON pc.model_id = i.model_id AND pc.id = i.promo_channel_id
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT coalesce(merged.slug, t.slug) ORDER BY coalesce(merged.slug, t.slug)) AS slugs
    FROM item_tags it
    JOIN tags t ON t.id = it.tag_id
    LEFT JOIN tags merged ON merged.id = t.merged_into_tag_id
   WHERE it.model_id = i.model_id AND it.item_id = i.id
) tg ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS total,
         count(*) FILTER (WHERE f.confirmed_value_version = f.value_version) AS confirmed
    FROM annotation_fields f
   WHERE f.model_id = i.model_id
     AND (f.item_id = i.id OR f.version_id IN (
       SELECT a.current_version_id
         FROM item_memberships im
         JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
        WHERE im.model_id = i.model_id AND im.item_id = i.id
          AND im.kind = 'owned' AND im.removed_at IS NULL
     ))
) af ON true
LEFT JOIN LATERAL (
  SELECT v.id AS version_id, v.width, v.height,
         (SELECT g.id FROM rendition_generations g
           WHERE g.master_sha256 = v.master_sha256 AND g.kind = 'thumb320' AND g.is_active
             AND g.state = 'ready' AND NOT g.meta_stripped
           ORDER BY g.ready_at DESC LIMIT 1) AS thumb320_generation_id,
         (SELECT g.id FROM rendition_generations g
           WHERE g.master_sha256 = v.master_sha256 AND g.kind = 'thumb640' AND g.is_active
             AND g.state = 'ready' AND NOT g.meta_stripped
           ORDER BY g.ready_at DESC LIMIT 1) AS thumb640_generation_id
    FROM item_memberships im
    JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
    JOIN asset_versions v ON v.model_id = a.model_id
                         AND v.id = coalesce(im.pinned_version_id, a.current_version_id)
   WHERE im.model_id = i.model_id AND im.item_id = i.id
     AND (im.id = i.cover_membership_id OR (i.cover_membership_id IS NULL AND im.removed_at IS NULL))
   ORDER BY im.display_position NULLS LAST, im.added_at, im.id
   LIMIT 1
) cv ON true
LEFT JOIN LATERAL (
  SELECT (count(*) FILTER (WHERE a.media_kind = 'image' AND im.variant_no = 0))::integer AS photo_count,
         (count(*) FILTER (WHERE a.media_kind = 'video' AND im.variant_no = 0))::integer AS video_count,
         max(v.version_no) FILTER (WHERE im.kind = 'owned') AS version_count,
         bool_or(im.kind = 'owned' AND im.role = 'teaser') AS has_teaser,
         coalesce(
           max(v.duration_ms) FILTER (WHERE im.kind = 'owned' AND im.role = 'master' AND im.variant_no = 0),
           (sum(v.duration_ms) FILTER (WHERE a.media_kind = 'video' AND im.variant_no = 0))::bigint
         ) AS duration_ms,
         sum(b.byte_size)::bigint AS size_bytes,
         (count(*) FILTER (WHERE im.selected))::integer AS selected_count,
         (count(*) FILTER (WHERE im.role = 'ed'))::integer AS processed_count,
         (count(*) FILTER (WHERE im.life_use IS NULL))::integer AS life_unassigned,
         (count(*) FILTER (WHERE im.life_use IN ('chats', 'both')))::integer AS life_chat_count,
         (count(*) FILTER (WHERE im.life_use IN ('feed', 'both')))::integer AS life_feed_count
    FROM item_memberships im
    JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
    JOIN asset_versions v ON v.model_id = a.model_id
                         AND v.id = coalesce(im.pinned_version_id, a.current_version_id)
    JOIN blobs b ON b.sha256 = v.master_sha256
   WHERE im.model_id = i.model_id AND im.item_id = i.id AND im.removed_at IS NULL
) m ON true
LEFT JOIN LATERAL (
  SELECT min(coalesce(r.remote_created_at, r.detected_at)) AS arrived_at
    FROM item_memberships im
    JOIN asset_versions v ON v.model_id = im.model_id AND v.asset_id = im.asset_id
    JOIN source_revisions r ON r.model_id = v.model_id AND r.id = v.source_revision_id
   WHERE im.model_id = i.model_id AND im.item_id = i.id AND im.kind = 'owned'
) arrival ON true
LEFT JOIN LATERAL (
  SELECT public_item_id(c.type, c.number) AS public_id
    FROM provenance p
    JOIN content_items c ON c.model_id = p.model_id AND c.id = p.child_item_id
   WHERE p.model_id = i.model_id AND p.parent_item_id = i.id AND p.relation = 'ppv_from_custom'
     AND p.voided_by_id IS NULL AND c.deleted_at IS NULL
   ORDER BY c.number
   LIMIT 1
) ppv ON i.type = 'CUS'
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT a.value_raw ORDER BY a.value_raw) AS aliases
    FROM aliases a
   WHERE a.model_id = i.model_id AND a.item_id = i.id
     AND a.kind IN ('legacy_id', 'merged_id', 'vault_album')
) al ON true
WHERE i.deleted_at IS NULL;
