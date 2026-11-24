-- 0030_originals_free: what leaves the VM's disk (SPEC §9.1, §9.4; owner's rule 24.11.2026).
-- ContentOps itself removes the bytes on its disk that are not a master once their original is
-- reliable — two clouds hold it, checked byte for byte (`original_copies`):
--
-- 1) a registered web upload keeps its raw bytes until ContentOps releases it
--    (`web_uploads.raw_released_at`, set by the work `originals_free` only when both copies of
--    the upload — MEGA and the model's Dropbox — are checked). The exception of 0026 for an
--    upload whose draft was rejected or is an alias goes: such bytes had no copy anywhere and
--    could be purged before they were archived;
-- 2) the input of an unfinished work holds its bytes as its output does (an encoder reading a
--    blob must never lose it), with its own index;
-- 3) the work `originals_free` of role `worker` (slot `originals`, system-wide like the other
--    three): releases the uploads and removes, by the storage protocol, the blobs of reliable
--    originals nobody references. Blobs of unknown origin stay for the owner's `purge-blobs`.

CREATE INDEX work_operations_input_unfinished ON work_operations (input_sha256)
  WHERE input_sha256 IS NOT NULL AND state IN ('pending', 'running', 'retry_wait');

CREATE OR REPLACE FUNCTION blob_is_referenced(sha bytea) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM asset_versions v WHERE v.master_sha256 = sha)
      OR EXISTS (SELECT 1 FROM inbox_drafts d WHERE d.master_sha256 = sha AND d.state <> 'resolved')
      OR EXISTS (SELECT 1 FROM inbox_drafts d WHERE d.source_blob_sha256 = sha AND d.state <> 'resolved')
      OR EXISTS (
           SELECT 1 FROM web_uploads u
            WHERE u.sha256 = sha
              AND (u.state IN ('receiving', 'received', 'verified')
                   OR (u.state = 'registered' AND u.raw_released_at IS NULL)))
      OR EXISTS (SELECT 1 FROM work_operations w WHERE w.output_sha256 = sha
                  AND w.state IN ('pending', 'running', 'retry_wait'))
      OR EXISTS (SELECT 1 FROM work_operations w WHERE w.input_sha256 = sha
                  AND w.state IN ('pending', 'running', 'retry_wait'));
$$;

ALTER TABLE work_operations DROP CONSTRAINT work_operations_kind_check;
ALTER TABLE work_operations ADD CONSTRAINT work_operations_kind_check
  CHECK (kind IN (
    'scan', 'fetch', 'hash', 'unpack_archive', 'import_parse', 'register', 'propose',
    'export', 'hub_sync', 'hub_history', 'hub_publish', 'annotate', 'verify_blobs', 'backup',
    'derive_video', 'encode_master', 'verify_master', 'render', 'uniq_render',
    'render_compat', 'extract_frame', 'derive_image', 'video_print', 'hub_orders',
    'originals_check', 'originals_audit', 'originals_copy', 'originals_free'
  ));

ALTER TABLE work_operations DROP CONSTRAINT work_operations_global_kinds;
ALTER TABLE work_operations ADD CONSTRAINT work_operations_global_kinds
  CHECK ((model_id IS NULL) = (kind IN ('verify_blobs', 'backup', 'originals_check',
                                        'originals_audit', 'originals_copy', 'originals_free')));
