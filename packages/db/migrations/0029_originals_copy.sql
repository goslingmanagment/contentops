-- 0029_originals_copy: ContentOps writes the copies of the originals itself (SPEC §9.4, owner's
-- rule 24.11.2026). Role `worker` gets a third work of the slot `originals`, system-wide like the
-- other two:
--
--   originals_copy  writes the copy rows that have no object yet — the MEGA copies of the models'
--                   sources, Lora's Я.Диск into «Архив Я.Диска» of her Dropbox, both copies of
--                   every web upload — from the bytes on our disk or cloud to cloud, hashing what
--                   it streams; such a copy is checked by its own stream. Only under
--                   `originals/` in MEGA and the folders of ContentOps in a Dropbox; nothing is
--                   ever deleted in a Dropbox.
--
-- Copies in a model's Dropbox are rows `place = 'dropbox', role = 'copy'`: the table takes them
-- as it is.

ALTER TABLE work_operations DROP CONSTRAINT work_operations_kind_check;
ALTER TABLE work_operations ADD CONSTRAINT work_operations_kind_check
  CHECK (kind IN (
    'scan', 'fetch', 'hash', 'unpack_archive', 'import_parse', 'register', 'propose',
    'export', 'hub_sync', 'hub_history', 'hub_publish', 'annotate', 'verify_blobs', 'backup',
    'derive_video', 'encode_master', 'verify_master', 'render', 'uniq_render',
    'render_compat', 'extract_frame', 'derive_image', 'video_print', 'hub_orders',
    'originals_check', 'originals_audit', 'originals_copy'
  ));

ALTER TABLE work_operations DROP CONSTRAINT work_operations_global_kinds;
ALTER TABLE work_operations ADD CONSTRAINT work_operations_global_kinds
  CHECK ((model_id IS NULL) = (kind IN ('verify_blobs', 'backup', 'originals_check',
                                        'originals_audit', 'originals_copy')));
