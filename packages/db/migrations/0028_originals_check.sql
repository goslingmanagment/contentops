-- 0028_originals_check: ContentOps checks the places of the originals itself (SPEC §9.4,
-- owner's rule 24.11.2026). Role `worker` gets two works of its own slot `originals`, both
-- system-wide (one queue across the models, so the copy of Я.Диск on C: goes first):
--
--   originals_check  streams a MEGA copy back once and compares its MD5, SHA-256 and Dropbox
--                    hash with the original's; every 10 minutes, a run of at most 30 minutes;
--   originals_audit  the nightly listing of Я.Диск, the Dropboxes and MEGA (no downloads): who is
--                    still there, the origins checked by the hash of the list, free space.
--
-- `original_copies.unseen_since` — the first whole listing that did not find a checked object
-- (or found another one under its path). The next night's listing that still does not find it
-- sets `missing_since`; a listing that finds it clears both. A broken or partial listing
-- changes neither.

ALTER TABLE work_operations DROP CONSTRAINT work_operations_kind_check;
ALTER TABLE work_operations ADD CONSTRAINT work_operations_kind_check
  CHECK (kind IN (
    'scan', 'fetch', 'hash', 'unpack_archive', 'import_parse', 'register', 'propose',
    'export', 'hub_sync', 'hub_history', 'hub_publish', 'annotate', 'verify_blobs', 'backup',
    'derive_video', 'encode_master', 'verify_master', 'render', 'uniq_render',
    'render_compat', 'extract_frame', 'derive_image', 'video_print', 'hub_orders',
    'originals_check', 'originals_audit'
  ));

ALTER TABLE work_operations DROP CONSTRAINT work_operations_global_kinds;
ALTER TABLE work_operations ADD CONSTRAINT work_operations_global_kinds
  CHECK ((model_id IS NULL) = (kind IN ('verify_blobs', 'backup', 'originals_check',
                                        'originals_audit')));

ALTER TABLE original_copies ADD COLUMN unseen_since timestamptz;
