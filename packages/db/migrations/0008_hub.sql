-- 0008_hub: the mirror of Agency Hub (schema §3.6, §9.1, §9.2, §9.6; SPEC §7, §8.1).
--
-- ContentOps reads Hub every hour: `posts`, `post_attachments`, `raw_media` and `vault_media`
-- of a page by `rowUpdatedAt` with an overlap, `capture_coverage` and `sync_streams` whole, the
-- Fansly file statistics by day. Every change Hub shows is a new row of the append-only log
-- `hub_observations` (A→B→A is three rows, there is no uniqueness by hash); the typed tables
-- hold the current row and point at its observation, a repeat only moves `last_seen_at`.
-- Evidence points at an observation, never at a current row. The poll boundary, Hub's own
-- freshness and the coverage of a page live in `hub_sync_state` (the former `hub_coverage`
-- and `hub_sync_runs` became its columns and `work_operations` rows of kind `hub_sync`).
-- Value lists are text + CHECK; the same lists live in `src/values.ts`.
--
-- Current Hub rows carry no journal trigger (schema §9.3): their journal is the observation
-- log. `hub_sync_state` has one: the inputs of a past verdict are restored from it.

-- ---------------------------------------------------------------------------
-- Observation log (schema §3.6, §9.4)
-- ---------------------------------------------------------------------------

-- One row per change of one Hub row: `external_key` is Hub's stable key of the row inside its
-- dataset, `sequence_no` counts its changes from 1. `semantic_hash` is SHA-256 of the pinned
-- fields (SPEC §8.1) without Hub's service times (`firstObservedAt`, `lastObservedAt`,
-- `rowUpdatedAt`, `capturedAt`) and without the album walk (it lives in `hub_vault_albums`);
-- `payload` is the row as Hub sent it. `run_id` is the `hub_sync` work and `run_attempt` its
-- attempt that saw the change.
CREATE TABLE hub_observations (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  account_id uuid NOT NULL,
  dataset text NOT NULL CHECK (dataset IN (
    'posts', 'post_attachments', 'raw_media', 'vault_media', 'creator_stats_media_daily',
    'creator_stats_media_likes'
  )),
  external_key text NOT NULL CONSTRAINT hub_observations_external_key_filled
    CHECK (external_key <> ''),
  sequence_no integer NOT NULL CONSTRAINT hub_observations_sequence_no_check
    CHECK (sequence_no >= 1),
  row_updated_at timestamptz,
  semantic_hash bytea NOT NULL CONSTRAINT hub_observations_semantic_hash_sha256
    CHECK (octet_length(semantic_hash) = 32),
  payload jsonb NOT NULL CONSTRAINT hub_observations_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid NOT NULL,
  run_attempt integer NOT NULL CONSTRAINT hub_observations_run_attempt_check
    CHECK (run_attempt >= 1),
  previous_id uuid,
  PRIMARY KEY (model_id, id),
  CONSTRAINT hub_observations_sequence
    UNIQUE (model_id, account_id, dataset, external_key, sequence_no),
  FOREIGN KEY (model_id, account_id) REFERENCES accounts (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, run_id) REFERENCES work_operations (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, previous_id) REFERENCES hub_observations (model_id, id)
    ON DELETE RESTRICT,
  -- The first observation of a row has no predecessor, every later one has.
  CONSTRAINT hub_observations_previous CHECK ((sequence_no = 1) = (previous_id IS NULL)),
  CONSTRAINT hub_observations_not_self CHECK (previous_id <> id)
);

CREATE TRIGGER hub_observations_append_only BEFORE UPDATE OR DELETE ON hub_observations
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
REVOKE UPDATE, DELETE ON hub_observations FROM contentops_app;

-- ---------------------------------------------------------------------------
-- Current rows (schema §3.6, §9.2, §9.6)
-- ---------------------------------------------------------------------------

-- A post of a page as Hub sees it now. `fyp_flags` is Hub's `fypFlags` as is (4 — not in the
-- feed, SPEC §7); an empty `wall_refs` is not «not on the wall». Which placements a post
-- became is read from `placements.external_post_ref` (schema §9.2).
CREATE TABLE hub_posts (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  account_id uuid NOT NULL,
  post_ref text NOT NULL,
  current_observation_id uuid NOT NULL,
  published_at timestamptz,
  caption text,
  attachment_count integer,
  fyp_flags integer,
  wall_refs jsonb NOT NULL DEFAULT '[]' CONSTRAINT hub_posts_wall_refs_array
    CHECK (jsonb_typeof(wall_refs) = 'array'),
  -- Hub's own times: the first sighting is the delay monitor's input (SPEC §7).
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  row_updated_at timestamptz,
  -- When a poll of ContentOps last saw the row.
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, id),
  CONSTRAINT hub_posts_ref UNIQUE (model_id, account_id, post_ref),
  FOREIGN KEY (model_id, account_id) REFERENCES accounts (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, current_observation_id) REFERENCES hub_observations (model_id, id)
    ON DELETE RESTRICT
);
CREATE INDEX hub_posts_published ON hub_posts (account_id, published_at DESC);
CREATE INDEX hub_posts_files ON hub_posts (account_id, attachment_count, published_at);

-- Post → offer or bundle → platform file. A bundle unrolls into its members, a preview has its
-- own role. The set of an affected post is replaced whole, an empty one too. The match columns
-- are a projection the matching rebuilds: an exact match of a file without a proven surface
-- lives here until a placement can be made (schema §9.6).
CREATE TABLE hub_post_attachments (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  post_id uuid NOT NULL,
  -- Hub's stable key of the row.
  hub_key text NOT NULL,
  current_observation_id uuid NOT NULL,
  attachment_index integer,
  member_index integer,
  position integer,
  role text NOT NULL CHECK (role IN ('main', 'offer_preview', 'bundle_preview')),
  content_type integer,
  -- The offer or bundle the post points at; `bundle_ref` — the bundle of a member.
  content_ref text,
  bundle_ref text,
  -- The offer of the file: views and likes of Fansly hang on it (SPEC §8.1).
  media_offer_ref text,
  preview_ref text,
  media_ref text,
  link_state text NOT NULL CHECK (link_state IN (
    'resolved', 'attachment_ref_missing', 'media_ref_missing', 'bundle_members_missing',
    'preview_unresolved', 'file_metadata_missing', 'non_media_attachment'
  )),
  filename text,
  mime text,
  duration_ms integer,
  orig_width integer,
  orig_height integer,
  matched_asset_id uuid,
  matched_version_id uuid,
  receipt_entry_id uuid,
  match_strength text NOT NULL DEFAULT 'none'
    CHECK (match_strength IN ('none', 'candidate', 'exact')),
  matched_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, id),
  CONSTRAINT hub_post_attachments_slot UNIQUE NULLS NOT DISTINCT
    (model_id, post_id, attachment_index, member_index, role),
  CONSTRAINT hub_post_attachments_key UNIQUE (model_id, post_id, hub_key),
  FOREIGN KEY (model_id, post_id) REFERENCES hub_posts (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, current_observation_id) REFERENCES hub_observations (model_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, matched_asset_id, matched_version_id)
    REFERENCES asset_versions (model_id, asset_id, id) ON DELETE RESTRICT,
  -- The issued file that matched is a file of the matched version; with the CHECK below it
  -- also stands for the plain FK of `receipt_entry_id` (schema §9.6).
  FOREIGN KEY (model_id, matched_version_id, receipt_entry_id)
    REFERENCES download_receipt_entries (model_id, asset_version_id, id) ON DELETE RESTRICT,
  CONSTRAINT hub_post_attachments_matched_version
    CHECK ((matched_asset_id IS NULL) = (matched_version_id IS NULL)),
  CONSTRAINT hub_post_attachments_receipt_version
    CHECK (receipt_entry_id IS NULL OR matched_version_id IS NOT NULL),
  CONSTRAINT hub_post_attachments_matched
    CHECK ((match_strength = 'none') = (matched_version_id IS NULL)
           AND (matched_at IS NULL) = (matched_version_id IS NULL))
);
CREATE INDEX hub_post_attachments_media ON hub_post_attachments (model_id, media_ref);
CREATE INDEX hub_post_attachments_offer ON hub_post_attachments (model_id, media_offer_ref);

-- A platform file. `filename_norm` is the name without its extension in lower case: the name of
-- a ContentOps download is an exact clue (SPEC §7, naming §5).
CREATE TABLE hub_raw_media (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  account_id uuid NOT NULL,
  media_ref text NOT NULL,
  current_observation_id uuid NOT NULL,
  filename text,
  filename_norm text GENERATED ALWAYS AS (lower(regexp_replace(filename, '\.[^./]*$', ''))) STORED,
  mime text,
  media_type integer,
  duration_ms integer,
  out_width integer,
  out_height integer,
  orig_width integer,
  orig_height integer,
  fps_milli integer,
  created_at_platform timestamptz,
  origin text,
  first_observed_at timestamptz,
  row_updated_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, id),
  CONSTRAINT hub_raw_media_ref UNIQUE (model_id, account_id, media_ref),
  FOREIGN KEY (model_id, account_id) REFERENCES accounts (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, current_observation_id) REFERENCES hub_observations (model_id, id)
    ON DELETE RESTRICT
);
CREATE INDEX hub_raw_media_name ON hub_raw_media (model_id, filename_norm);
CREATE INDEX hub_raw_media_shape ON hub_raw_media (account_id, duration_ms, orig_width, orig_height);

-- A vault album of the creator (the user vault of likes and purchases is not read). The last
-- full walk is Hub's proof of what lies there now (SPEC §7 «Hub обходил альбом … 03:08»).
CREATE TABLE hub_vault_albums (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  account_id uuid NOT NULL,
  album_ref text NOT NULL,
  title text,
  last_full_walk_at timestamptz,
  full_walk_ref text,
  member_count integer,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, id),
  CONSTRAINT hub_vault_albums_ref UNIQUE (model_id, account_id, album_ref),
  -- Target of FK (model_id, account_id, album_id): a member stays on its page.
  UNIQUE (model_id, account_id, id),
  FOREIGN KEY (model_id, account_id) REFERENCES accounts (model_id, id) ON DELETE RESTRICT
);
-- `PPV-073 Йога, анал, гольфы` leads to its object (naming §7).
CREATE INDEX hub_vault_albums_title ON hub_vault_albums (model_id, lower(title));

-- A file in an album. «Был когда-то» and «есть сейчас» are different facts: `missing_since`
-- comes only from a proven full walk, and a file with it holds no placement.
CREATE TABLE hub_vault_media (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  account_id uuid NOT NULL,
  album_id uuid NOT NULL,
  member_ref text NOT NULL,
  current_observation_id uuid NOT NULL,
  media_ref text,
  media_offer_ref text,
  custom_filename text,
  filename text,
  mime text,
  media_type integer,
  duration_ms integer,
  orig_width integer,
  orig_height integer,
  created_at_platform timestamptz,
  membership_at timestamptz,
  missing_since timestamptz,
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  row_updated_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, id),
  CONSTRAINT hub_vault_media_member UNIQUE (model_id, account_id, album_id, member_ref),
  FOREIGN KEY (model_id, account_id, album_id) REFERENCES hub_vault_albums (model_id, account_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, current_observation_id) REFERENCES hub_observations (model_id, id)
    ON DELETE RESTRICT
);
CREATE INDEX hub_vault_media_media ON hub_vault_media (model_id, media_ref);

CREATE TRIGGER hub_posts_fixed BEFORE UPDATE ON hub_posts
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'account_id', 'post_ref');
CREATE TRIGGER hub_post_attachments_fixed BEFORE UPDATE ON hub_post_attachments
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'post_id', 'hub_key');
CREATE TRIGGER hub_raw_media_fixed BEFORE UPDATE ON hub_raw_media
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'account_id', 'media_ref');
CREATE TRIGGER hub_vault_albums_fixed BEFORE UPDATE ON hub_vault_albums
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'account_id', 'album_ref');
CREATE TRIGGER hub_vault_media_fixed BEFORE UPDATE ON hub_vault_media
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'account_id', 'album_id', 'member_ref'
  );

-- ---------------------------------------------------------------------------
-- Poll boundary, freshness and coverage (schema §3.6, §9.1, §9.6; SPEC §7, §8.1)
-- ---------------------------------------------------------------------------

-- One row per page and stream of the poll (`work_operations.dataset` of `hub_sync`); `scope`
-- is `page` for the whole page. The boundary moves only after every page of the read is saved.
--   last_success_at — start of the last successful run, the base of the next read;
--   watermark_at    — `rowUpdatedAt` the next hourly read starts from (last success − 3 h);
--   last_daily_at   — start of the last daily or full run (a day of overlap once a day);
--   next_full_at    — a month after the last full re-read; the first run, a failed run, a
--                     gap longer than a day and a Hub rebuild re-read in full too (SPEC §8.1);
--   rebuilt_at      — when Hub refused a cursor as minted before its rebuild: a full re-read
--                     is due until one starts after it;
--   hub_succeeded_at — Hub's own freshness: `sync_streams.succeededAt` of its posts stream,
--                     on Fansly (no `sync_streams` rows) the latest `lastObservedAt` of the
--                     page's posts; older than a day — «Hub не обновлял посты с …»;
--   window_from … proven_complete_at — coverage of the posts (entry E7): NULL until Hub's
--                     `capture_coverage` holds a posts plan, then only with proof.
CREATE TABLE hub_sync_state (
  model_id uuid NOT NULL,
  -- Subject of the journal; the key is (page, dataset, scope).
  id uuid NOT NULL DEFAULT uuidv7(),
  account_id uuid NOT NULL,
  dataset text NOT NULL CHECK (dataset IN ('posts', 'raw_media', 'vault_media', 'creator_stats')),
  scope text NOT NULL DEFAULT 'page',
  watermark_at timestamptz,
  last_success_at timestamptz,
  last_daily_at timestamptz,
  next_full_at timestamptz,
  rebuilt_at timestamptz,
  hub_succeeded_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0
    CONSTRAINT hub_sync_state_consecutive_failures_check CHECK (consecutive_failures >= 0),
  available boolean NOT NULL DEFAULT true,
  unavailable_reason text,
  last_error text,
  -- The `hub_sync` work that last wrote the row.
  last_work_id uuid,
  window_from timestamptz,
  window_to timestamptz,
  expected_count integer,
  observed_count integer,
  stop_reason text,
  -- Hub's `conclusion.blockers` of the last read (`gaps_present` …); NULL — not read yet.
  blockers text[],
  proven_complete_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, account_id, dataset, scope),
  UNIQUE (model_id, id),
  FOREIGN KEY (model_id, account_id) REFERENCES accounts (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, last_work_id) REFERENCES work_operations (model_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT hub_sync_state_available CHECK (available OR unavailable_reason IS NOT NULL)
);

CREATE TRIGGER hub_sync_state_fixed BEFORE UPDATE ON hub_sync_state
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'account_id', 'dataset', 'scope');
CREATE TRIGGER hub_sync_state_journal AFTER INSERT OR UPDATE OR DELETE ON hub_sync_state
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');

-- ---------------------------------------------------------------------------
-- Evidence points at its observation (schema §9.5)
-- ---------------------------------------------------------------------------

ALTER TABLE placement_evidence
  ADD FOREIGN KEY (model_id, hub_observation_id) REFERENCES hub_observations (model_id, id)
    ON DELETE RESTRICT;
