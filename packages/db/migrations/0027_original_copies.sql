-- 0027_original_copies: where an original lives besides the owner's PC (owner's rule 24.11.2026,
-- SPEC §9.4). An original — a revision of a model's cloud source or a registered web upload — may
-- leave the PC when two of three clouds (Яндекс.Диск, Dropbox, MEGA) hold it, checked byte for
-- byte, and its master is ready or ContentOps decided there will be none. This table is the
-- ledger of those places; the rule over it is one SQL query (`apps/server/src/originals/rule.ts`).
-- Nothing is released by this file: actions come later, their journal is `action_log` and
-- `storage_operations`.
--
--   place         yandex | dropbox | mega — the cloud;
--   role          origin — the cloud where ContentOps found the file (its source); copy — a copy;
--   remote        the rclone remote the copy is read through (`mega`); empty for an origin, read
--                 through the ContentOps source itself;
--   path          the path in that cloud;
--   object_ref    the provider's identity of the very object that was seen: a MEGA node ID, a
--                 Dropbox `id@rev`, the Яндекс.Диск SHA-256 (or MD5) of the revision;
--   seen_*        hashes of the bytes the check saw (MD5, SHA-256, Dropbox content hash);
--   verified_at   the check matched those bytes with the original's reference hash; a new object
--                 under the path or another size drops it (trigger below);
--   missing_since a listing no longer finds the object; a missing place does not count;
--   attempts, next_try_at, error — the retries of the check.
CREATE TABLE original_copies (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7(),
  source_revision_id uuid,
  web_upload_id uuid,
  place text NOT NULL CONSTRAINT original_copies_place_check
    CHECK (place IN ('yandex', 'dropbox', 'mega')),
  role text NOT NULL CONSTRAINT original_copies_role_check CHECK (role IN ('origin', 'copy')),
  remote text CHECK (remote IS NULL OR length(remote) BETWEEN 1 AND 100),
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
  object_ref text CHECK (object_ref IS NULL OR length(object_ref) BETWEEN 1 AND 300),
  byte_size bigint CHECK (byte_size >= 0),
  seen_md5 bytea CHECK (octet_length(seen_md5) = 16),
  seen_sha256 bytea CHECK (octet_length(seen_sha256) = 32),
  seen_dropbox_hash bytea CHECK (octet_length(seen_dropbox_hash) = 32),
  copied_at timestamptz,
  verified_at timestamptz,
  verified_by text CHECK (verified_by IS NULL OR length(verified_by) BETWEEN 1 AND 100),
  last_seen_at timestamptz,
  missing_since timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_try_at timestamptz,
  error text CHECK (error IS NULL OR length(error) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, id),
  FOREIGN KEY (model_id, source_revision_id) REFERENCES source_revisions (model_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, web_upload_id) REFERENCES web_uploads (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT original_copies_one_original
    CHECK (num_nonnulls(source_revision_id, web_upload_id) = 1),
  -- The origin is the model's own cloud folder: a web upload has none, MEGA is never one.
  CONSTRAINT original_copies_origin CHECK (
    role <> 'origin' OR (source_revision_id IS NOT NULL AND place IN ('yandex', 'dropbox'))),
  CONSTRAINT original_copies_copy_remote CHECK (role = 'origin' OR remote IS NOT NULL),
  -- A check names who made it, which object it saw and what hash its bytes gave.
  CONSTRAINT original_copies_verified CHECK (
    (verified_at IS NULL) = (verified_by IS NULL)
    AND (verified_at IS NULL OR (
      object_ref IS NOT NULL AND byte_size IS NOT NULL
      AND num_nonnulls(seen_md5, seen_sha256, seen_dropbox_hash) >= 1)))
);

-- One row per original and cloud: «two places» are two different clouds.
CREATE UNIQUE INDEX original_copies_revision_place ON original_copies (model_id, source_revision_id, place)
  WHERE source_revision_id IS NOT NULL;
CREATE UNIQUE INDEX original_copies_upload_place ON original_copies (model_id, web_upload_id, place)
  WHERE web_upload_id IS NOT NULL;
-- What is still to check: the queue of the later check work.
CREATE INDEX original_copies_to_check ON original_copies (next_try_at)
  WHERE verified_at IS NULL AND missing_since IS NULL;

CREATE TRIGGER original_copies_fixed BEFORE UPDATE ON original_copies
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'source_revision_id', 'web_upload_id',
    'place', 'role');

-- Another object under the path, or another size, is not what was checked: the check goes with
-- its hashes, unless the same statement records a new check. `updated_at` follows every change.
CREATE FUNCTION original_copies_identity() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.object_ref, NEW.byte_size) IS DISTINCT FROM (OLD.object_ref, OLD.byte_size)
     AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at THEN
    NEW.verified_at := NULL;
    NEW.verified_by := NULL;
    NEW.seen_md5 := NULL;
    NEW.seen_sha256 := NULL;
    NEW.seen_dropbox_hash := NULL;
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER original_copies_identity BEFORE UPDATE ON original_copies
  FOR EACH ROW EXECUTE FUNCTION original_copies_identity();
