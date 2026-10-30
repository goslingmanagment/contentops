-- 0002_bytes_sources: bytes, their technical descriptions, derivatives, pipeline versions
-- (global tables, schema §3.1, §3.3) and the sources of bytes (domain tables, §3.4).
--
-- Global tables hold no content of a model (schema §1 p. 1) and carry no journal trigger:
-- workers write them, and the journal of a work is its typed events (schema §9.3).
-- Value lists are text + CHECK; the same lists live in `src/values.ts`.

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- Columns named in the trigger arguments are written once: NULL → value, never changed
-- afterwards (source_revisions after download, a rendition generation bound to its master).
CREATE FUNCTION set_once() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  col text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF NOT old_row ? col THEN
      RAISE EXCEPTION 'set_once on %: no column %', TG_TABLE_NAME, col;
    END IF;
    IF jsonb_typeof(old_row -> col) <> 'null' AND old_row -> col IS DISTINCT FROM new_row -> col THEN
      RAISE EXCEPTION 'column %.% is already set', TG_TABLE_NAME, col
        USING ERRCODE = 'CO003';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------------
-- Pipeline versions (schema §3.1)
-- ---------------------------------------------------------------------------

-- What a `pipeline_version` string means. A new master or rendition profile is a new row;
-- derivative keys use the `recipe_digest` of their own kind (`recipe_digests`).
CREATE TABLE pipeline_versions (
  version text PRIMARY KEY,
  ffmpeg text NOT NULL,
  svtav1 text NOT NULL,
  libvips text NOT NULL,
  sharp text NOT NULL,
  phash_algo text NOT NULL,
  master_recipe jsonb NOT NULL,
  rendition_recipes jsonb NOT NULL,
  recipe_digests jsonb NOT NULL
    CONSTRAINT pipeline_versions_recipe_digests_object CHECK (jsonb_typeof(recipe_digests) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  is_current boolean NOT NULL DEFAULT false,
  CONSTRAINT pipeline_versions_current_activated CHECK (NOT is_current OR activated_at IS NOT NULL)
);
CREATE UNIQUE INDEX pipeline_versions_one_current ON pipeline_versions (is_current) WHERE is_current;

CREATE TRIGGER pipeline_versions_fixed BEFORE UPDATE ON pipeline_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'version', 'ffmpeg', 'svtav1', 'libvips', 'sharp', 'phash_algo', 'master_recipe',
    'rendition_recipes', 'recipe_digests'
  );

-- ---------------------------------------------------------------------------
-- Bytes (schema §3.3, §9.2)
-- ---------------------------------------------------------------------------

-- Immutable bytes by SHA-256. A row is never deleted: otherwise `verify-blobs` could not tell
-- «removed on purpose» from «bytes lost». References that hold a blob are real FKs on
-- `blobs (sha256)`; `blob_is_referenced()` (0003) counts them.
CREATE TABLE blobs (
  sha256 bytea PRIMARY KEY CONSTRAINT blobs_sha256_check CHECK (octet_length(sha256) = 32),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  mime text NOT NULL,
  ext text NOT NULL CONSTRAINT blobs_ext_format CHECK (ext ~ '^[a-z0-9]{1,10}$'),
  media_kind text NOT NULL CHECK (media_kind IN ('video', 'image')),
  storage_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'present' CHECK (state IN ('present', 'purged', 'missing', 'corrupt')),
  registered_at timestamptz NOT NULL DEFAULT now(),
  purged_at timestamptz,
  verified_at timestamptz,
  CONSTRAINT blobs_purged_at CHECK (state <> 'purged' OR purged_at IS NOT NULL)
);

CREATE TRIGGER blobs_fixed BEFORE UPDATE ON blobs
  FOR EACH ROW EXECUTE FUNCTION forbid_change('sha256', 'byte_size', 'ext', 'media_kind', 'storage_key');

-- ffprobe and EXIF, computed once per bytes and tool recipe (SPEC §12.0). The bytes may be a
-- source that never becomes a blob, so `sha256` is a fingerprint, not a reference.
CREATE TABLE blob_probes (
  sha256 bytea NOT NULL CONSTRAINT blob_probes_sha256_check CHECK (octet_length(sha256) = 32),
  kind text NOT NULL CHECK (kind IN ('ffprobe', 'exif')),
  recipe_digest text NOT NULL,
  duration_ms bigint,
  width integer,
  height integer,
  rotation integer,
  fps_num integer,
  fps_den integer,
  video_codec text,
  pix_fmt text,
  bit_rate bigint,
  is_hdr boolean,
  audio_tracks jsonb,
  -- EXIF without a zone stays local time; it never becomes an invented UTC.
  shot_at timestamptz,
  shot_at_local timestamp,
  shot_tz text,
  camera jsonb,
  raw jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sha256, kind, recipe_digest)
);
-- Candidates by Hub duration and size (SPEC §7); shooting day.
CREATE INDEX blob_probes_duration_size ON blob_probes (duration_ms, width, height);
CREATE INDEX blob_probes_shot_at ON blob_probes (shot_at);

-- Perceptual hash of a photo (SPEC §6.2): a hint, never a merge.
CREATE TABLE blob_phashes (
  sha256 bytea NOT NULL CONSTRAINT blob_phashes_sha256_check CHECK (octet_length(sha256) = 32),
  algorithm text NOT NULL,
  algo_version text NOT NULL,
  normalization text NOT NULL,
  phash bit(64) NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sha256, algorithm, algo_version, normalization)
);

-- How a master was made (`decision`) and the verdict of its check, one row per attempt
-- (schema §9.2). A failed check may have no master hash.
CREATE TABLE master_checks (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  source_sha256 bytea NOT NULL CONSTRAINT master_checks_source_sha256_check
    CHECK (octet_length(source_sha256) = 32),
  master_sha256 bytea CONSTRAINT master_checks_master_sha256_check
    CHECK (octet_length(master_sha256) = 32),
  recipe_digest text NOT NULL,
  work_id uuid NOT NULL REFERENCES work_operations (id) ON DELETE RESTRICT,
  attempt integer NOT NULL CHECK (attempt >= 1),
  -- Empty only when the source did not open (`unreadable`): no rule applies.
  decision text CHECK (decision IN (
    'encode', 'copy', 'skipped_hdr', 'skipped_av1', 'skipped_lowrate', 'skipped_audio'
  )),
  verdict text NOT NULL CHECK (verdict IN (
    'ok', 'unreadable', 'bigger_than_source', 'timing_drift', 'timing_uncomparable',
    'audio_mismatch', 'audio_offset', 'audio_tracks_lost', 'encode_failed', 'frame_mismatch',
    'result_decode_errors', 'publish_failed', 'source_decode_errors', 'source_truncated',
    'metadata_mismatch'
  )),
  enc_ms bigint,
  verify_ms bigint,
  src_frames bigint,
  dst_frames bigint,
  crf integer,
  report jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT master_checks_attempt UNIQUE (source_sha256, recipe_digest, work_id, attempt),
  CONSTRAINT master_checks_decision CHECK (decision IS NOT NULL OR verdict = 'unreadable')
);
CREATE INDEX master_checks_master ON master_checks (master_sha256);

-- Intent to write or remove bytes (schema §3.3, §9.3 «Операции с файлами»): a crash between
-- the file operation and the database leaves a visible trace. Not a reference to the blob.
CREATE TABLE storage_operations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN ('put', 'purge')),
  blob_sha256 bytea NOT NULL CONSTRAINT storage_operations_blob_sha256_check
    CHECK (octet_length(blob_sha256) = 32),
  from_key text,
  to_key text,
  state text NOT NULL DEFAULT 'intent' CHECK (state IN (
    'intent', 'started', 'fs_done', 'committed', 'failed', 'cancelled'
  )),
  owner text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT storage_operations_finished_at
    CHECK ((state IN ('committed', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);
-- One live intent per blob.
CREATE UNIQUE INDEX storage_operations_active ON storage_operations (blob_sha256)
  WHERE state IN ('intent', 'started', 'fs_done');

-- Only an intent that has not started can be cancelled; a finished operation is final.
CREATE FUNCTION storage_operation_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('committed', 'failed', 'cancelled') AND NEW.state <> OLD.state
     OR NEW.state = 'cancelled' AND OLD.state NOT IN ('intent', 'cancelled') THEN
    RAISE EXCEPTION 'storage operation %: % → % is not allowed', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'CO005';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER storage_operations_transition BEFORE UPDATE OF state ON storage_operations
  FOR EACH ROW EXECUTE FUNCTION storage_operation_transition();
CREATE TRIGGER storage_operations_fixed BEFORE UPDATE ON storage_operations
  FOR EACH ROW EXECUTE FUNCTION forbid_change('id', 'kind', 'blob_sha256', 'from_key', 'to_key');

-- ---------------------------------------------------------------------------
-- Derivatives (schema §3.3, §9.1, SPEC §9.1, §9.3). Not references to blobs.
-- ---------------------------------------------------------------------------

-- A physical build of one derivative kind. The first generation is built from the source at
-- intake (`master_sha256` empty, address by `id`) and is bound to its master once after the
-- check; a rebuild is a new generation, and an address never serves other bytes.
CREATE TABLE rendition_generations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  master_sha256 bytea CONSTRAINT rendition_generations_master_sha256_check
    CHECK (octet_length(master_sha256) = 32),
  kind text NOT NULL CHECK (kind IN (
    'preview', 'poster', 'thumb320', 'thumb640', 'preview2048', 'frames', 'platform'
  )),
  recipe_digest text NOT NULL,
  meta_stripped boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT false,
  input_kind text NOT NULL CHECK (input_kind IN ('source', 'master')),
  input_sha256 bytea NOT NULL CONSTRAINT rendition_generations_input_sha256_check
    CHECK (octet_length(input_sha256) = 32),
  state text NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'ready', 'failed', 'evicted')),
  work_id uuid REFERENCES work_operations (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  bound_at timestamptz,
  CONSTRAINT rendition_generations_master_input
    CHECK (input_kind = 'source' OR master_sha256 = input_sha256),
  CONSTRAINT rendition_generations_bound CHECK (bound_at IS NULL OR master_sha256 IS NOT NULL),
  CONSTRAINT rendition_generations_ready_at CHECK (state <> 'ready' OR ready_at IS NOT NULL)
);
-- One active generation per derivative key; switching is serialised by this key.
CREATE UNIQUE INDEX rendition_generations_active_key
  ON rendition_generations (master_sha256, kind, recipe_digest, meta_stripped)
  WHERE is_active;
-- Unbound generations of a draft are found by its source.
CREATE INDEX rendition_generations_input ON rendition_generations (input_sha256);

CREATE TRIGGER rendition_generations_fixed BEFORE UPDATE ON rendition_generations
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'id', 'kind', 'recipe_digest', 'meta_stripped', 'input_kind', 'input_sha256'
  );
CREATE TRIGGER rendition_generations_bound_once BEFORE UPDATE ON rendition_generations
  FOR EACH ROW EXECUTE FUNCTION set_once('master_sha256', 'bound_at');

-- A file inside a generation; names come from the derivative manifest (SPEC §9.3). Removing
-- the file changes `state`, the description stays: a receipt always knows what was issued.
CREATE TABLE rendition_artifacts (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  generation_id uuid NOT NULL REFERENCES rendition_generations (id) ON DELETE RESTRICT,
  name text NOT NULL CONSTRAINT rendition_artifacts_name_format CHECK (name ~ (
    '^(platform\.mp4|preview\.mp4|poster\.webp|thumb-320\.webp|thumb-640\.webp'
    '|preview-2048\.webp|frames/[0-9]{4,6}\.webp)$'
  )),
  output_sha256 bytea NOT NULL CONSTRAINT rendition_artifacts_output_sha256_check
    CHECK (octet_length(output_sha256) = 32),
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  mime text NOT NULL,
  width integer,
  height integer,
  duration_ms bigint,
  frame_ms bigint,
  storage_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'evicted', 'missing')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (generation_id, name),
  -- Target of FK (rendition_artifact_id, output_sha256) from receipt entries.
  UNIQUE (id, output_sha256)
);

CREATE TRIGGER rendition_artifacts_fixed BEFORE UPDATE ON rendition_artifacts
  FOR EACH ROW EXECUTE FUNCTION forbid_change('id', 'generation_id', 'name', 'output_sha256', 'storage_key');

-- The output of an unfinished work holds its blob (schema §9.2).
ALTER TABLE work_operations
  ADD CONSTRAINT work_operations_output_sha256_fkey
  FOREIGN KEY (output_sha256) REFERENCES blobs (sha256) ON DELETE RESTRICT;
CREATE INDEX work_operations_output ON work_operations (output_sha256)
  WHERE output_sha256 IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Sources (schema §3.4, §9.7; SPEC §6.1)
-- ---------------------------------------------------------------------------

-- Where bytes and metadata come from. Both clouds sit behind one source interface and are
-- read-only (SPEC §2.1 p. 6). The token itself is not stored: `credentials_ref` names an
-- environment variable. `root_path` is the model's folder at the source (configuration):
-- `disk:/…` or `/` on Yandex Disk, `/…` or `''` (the whole account) on Dropbox.
CREATE TABLE sources (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN ('yandex_disk', 'dropbox', 'web_upload', 'legacy_metadata')),
  label text NOT NULL,
  credentials_ref text CONSTRAINT sources_credentials_ref_format
    CHECK (credentials_ref ~ '^[A-Z][A-Z0-9_]*$'),
  root_path text,
  read_only boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, label),
  CONSTRAINT sources_cloud_read_only CHECK (kind NOT IN ('yandex_disk', 'dropbox') OR read_only),
  -- A cloud folder is scanned from its root and read with its token.
  CONSTRAINT sources_cloud_root
    CHECK (kind NOT IN ('yandex_disk', 'dropbox') OR (root_path IS NOT NULL AND credentials_ref IS NOT NULL))
);

-- An external resource. The path is not unique: a new resource can appear on an old path.
-- A member of an unpacked archive is `(archive revision, entry number)`: equal names inside
-- one ZIP stay distinct.
CREATE TABLE source_objects (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  source_id uuid NOT NULL,
  resource_id text,
  upload_id text,
  current_path text NOT NULL,
  current_name text NOT NULL,
  is_dir boolean NOT NULL DEFAULT false,
  parent_id uuid,
  archive_revision_id uuid,
  archive_entry_no integer CHECK (archive_entry_no >= 0),
  current_revision_id uuid,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  gone_since timestamptz,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, source_id, resource_id),
  UNIQUE (model_id, archive_revision_id, archive_entry_no),
  FOREIGN KEY (model_id, source_id) REFERENCES sources (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, parent_id) REFERENCES source_objects (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT source_objects_archive_member
    CHECK ((archive_revision_id IS NULL) = (archive_entry_no IS NULL))
);
CREATE INDEX source_objects_last_seen ON source_objects (model_id, last_seen_at);
-- Search by an old path (SPEC §11.2).
CREATE INDEX source_objects_path_trgm ON source_objects USING gin (current_path gin_trgm_ops);

-- History of paths and names (rename and move): a new row and an alias, not a new draft.
CREATE TABLE source_paths (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  source_object_id uuid NOT NULL,
  path_raw text NOT NULL,
  path_nfc text NOT NULL GENERATED ALWAYS AS (normalize(path_raw, NFC)) STORED,
  name text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, source_object_id, path_nfc),
  FOREIGN KEY (model_id, source_object_id) REFERENCES source_objects (model_id, id)
    ON DELETE RESTRICT
);

-- An observed state of the bytes. A→B→A gives three revisions; there is no uniqueness by a hash.
-- Observed identity and metadata never change; `source_sha256`, `verified_at` and
-- `verified_route` are written once after download and check, `frozen_by_work_id` once by the
-- snapshot `scan:freeze` (SPEC §6.3).
CREATE TABLE source_revisions (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  source_object_id uuid NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no >= 1),
  -- Yandex Disk: MD5 and SHA-256 from the API; Dropbox: `content_hash` and `rev`.
  md5 bytea CONSTRAINT source_revisions_md5_check CHECK (octet_length(md5) = 16),
  remote_sha256 bytea CONSTRAINT source_revisions_remote_sha256_check
    CHECK (octet_length(remote_sha256) = 32),
  content_hash bytea CONSTRAINT source_revisions_content_hash_check
    CHECK (octet_length(content_hash) = 32),
  remote_rev text,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  -- `created` of Yandex Disk, `server_modified` of Dropbox: the arrival date.
  remote_created_at timestamptz,
  remote_modified_at timestamptz,
  detected_at timestamptz NOT NULL DEFAULT now(),
  scan_work_id uuid,
  previous_id uuid,
  source_sha256 bytea CONSTRAINT source_revisions_source_sha256_check
    CHECK (octet_length(source_sha256) = 32),
  verified_at timestamptz,
  verified_route text CHECK (verified_route IN ('download', 'local_copy', 'upload')),
  frozen_by_work_id uuid,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, source_object_id, sequence_no),
  -- Target of FK (model_id, id, current_revision_id) from source_objects.
  UNIQUE (model_id, source_object_id, id),
  FOREIGN KEY (model_id, source_object_id) REFERENCES source_objects (model_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, previous_id) REFERENCES source_revisions (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, scan_work_id) REFERENCES work_operations (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, frozen_by_work_id) REFERENCES work_operations (model_id, id)
    ON DELETE RESTRICT,
  -- The local hash, the check and its route arrive together.
  CONSTRAINT source_revisions_verified CHECK (
    (source_sha256 IS NULL) = (verified_at IS NULL) AND (verified_at IS NULL) = (verified_route IS NULL)
  )
);
-- Exact duplicates (SPEC §6.2): by the local hash and, before download, by the API hash.
CREATE INDEX source_revisions_source_sha256 ON source_revisions (model_id, source_sha256);
CREATE INDEX source_revisions_remote_sha256 ON source_revisions (model_id, remote_sha256);

ALTER TABLE source_objects
  ADD FOREIGN KEY (model_id, archive_revision_id) REFERENCES source_revisions (model_id, id)
    ON DELETE RESTRICT,
  -- The current revision is a revision of this object.
  ADD FOREIGN KEY (model_id, id, current_revision_id)
    REFERENCES source_revisions (model_id, source_object_id, id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Fixed columns and journal of the source tables
-- ---------------------------------------------------------------------------

CREATE TRIGGER sources_fixed BEFORE UPDATE ON sources
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'kind');
CREATE TRIGGER source_objects_fixed BEFORE UPDATE ON source_objects
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'source_id', 'resource_id', 'upload_id', 'archive_revision_id', 'archive_entry_no'
  );
CREATE TRIGGER source_paths_fixed BEFORE UPDATE ON source_paths
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'source_object_id', 'path_raw', 'name');
CREATE TRIGGER source_revisions_fixed BEFORE UPDATE ON source_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'source_object_id', 'sequence_no', 'md5', 'remote_sha256', 'content_hash',
    'remote_rev', 'byte_size', 'remote_created_at', 'remote_modified_at', 'detected_at',
    'scan_work_id', 'previous_id'
  );
CREATE TRIGGER source_revisions_verified_once BEFORE UPDATE ON source_revisions
  FOR EACH ROW EXECUTE FUNCTION set_once(
    'source_sha256', 'verified_at', 'verified_route', 'frozen_by_work_id'
  );

CREATE TRIGGER sources_journal AFTER INSERT OR UPDATE OR DELETE ON sources
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER source_objects_journal AFTER INSERT OR UPDATE OR DELETE ON source_objects
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER source_paths_journal AFTER INSERT OR UPDATE OR DELETE ON source_paths
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER source_revisions_journal AFTER INSERT OR UPDATE OR DELETE ON source_revisions
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');

-- ---------------------------------------------------------------------------
-- Privileges: a blob row is never deleted.
-- ---------------------------------------------------------------------------

REVOKE DELETE ON blobs FROM contentops_app;
