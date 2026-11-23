-- 0026_storage_safety:
-- 1) Protect raw bytes of registered web uploads (`web_uploads.sha256`, SPEC §9.1, §12.3):
--    when a web upload «Другое» is compressed to an AV1 master, `asset_versions` points only to
--    the AV1 master and the original bytes have no external cloud copy. Keep them referenced by
--    `blob_is_referenced()` while `state = 'registered'` and `raw_released_at IS NULL`, unless
--    the upload's draft was resolved as `rejected` or `alias`. Once archived externally, setting
--    `raw_released_at` (and optionally `raw_archive_ref`) lets `purge-blobs` reclaim the raw blob.
-- 2) Close the reopen/purge race in `inbox_draft_transition()` (0015): while a `purge` storage
--    operation is in progress on the draft's bytes, reopening a rejected draft is refused under
--    the same row lock (`FOR SHARE`) as `lockBlobForReference`.

ALTER TABLE web_uploads
  ADD COLUMN raw_released_at timestamptz,
  ADD COLUMN raw_archive_ref text;

CREATE OR REPLACE FUNCTION blob_is_referenced(sha bytea) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM asset_versions v WHERE v.master_sha256 = sha)
      OR EXISTS (SELECT 1 FROM inbox_drafts d WHERE d.master_sha256 = sha AND d.state <> 'resolved')
      OR EXISTS (SELECT 1 FROM inbox_drafts d WHERE d.source_blob_sha256 = sha AND d.state <> 'resolved')
      OR EXISTS (
           SELECT 1 FROM web_uploads u
            WHERE u.sha256 = sha
              AND (
                u.state IN ('receiving', 'received', 'verified')
                OR (
                  u.state = 'registered'
                  AND u.raw_released_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM inbox_drafts d
                     WHERE d.model_id = u.model_id
                       AND d.web_upload_id = u.id
                       AND d.state = 'resolved'
                       AND d.outcome IN ('rejected', 'alias')
                  )
                )
              )
         )
      OR EXISTS (SELECT 1 FROM work_operations w WHERE w.output_sha256 = sha
                  AND w.state IN ('pending', 'running', 'retry_wait'));
$$;

CREATE OR REPLACE FUNCTION inbox_draft_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'resolved'
     AND (NEW.state, NEW.outcome) IS DISTINCT FROM (OLD.state, OLD.outcome) THEN
    IF OLD.outcome IN ('new_item', 'append') AND NEW.state = 'resolved'
       AND NEW.outcome IN ('alias', 'rejected')
       AND current_setting('app.action', true) IN ('objectFiles.copyOf', 'objectFiles.notContent')
       AND NOT EXISTS (
         SELECT 1 FROM asset_versions v
           JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
          WHERE v.model_id = OLD.model_id AND v.id = OLD.applied_version_id
            AND m.kind = 'owned' AND m.removed_at IS NULL) THEN
      RETURN NEW;
    END IF;
    IF OLD.outcome <> 'rejected' OR NEW.state <> 'ready' THEN
      RAISE EXCEPTION 'draft %: % (%) → % is not allowed', OLD.id, OLD.state, OLD.outcome, NEW.state
        USING ERRCODE = 'CO005';
    END IF;
    PERFORM 1 FROM blobs
      WHERE sha256 IN (OLD.master_sha256, OLD.source_blob_sha256)
      ORDER BY sha256 FOR SHARE;
    IF EXISTS (SELECT 1 FROM blobs WHERE sha256 IN (OLD.master_sha256, OLD.source_blob_sha256)
                                     AND state <> 'present') THEN
      RAISE EXCEPTION 'draft %: its bytes were removed, it cannot reopen', OLD.id
        USING ERRCODE = 'CO005';
    END IF;
    IF EXISTS (SELECT 1 FROM storage_operations o
                WHERE o.blob_sha256 IN (OLD.master_sha256, OLD.source_blob_sha256)
                  AND o.kind = 'purge'
                  AND o.state IN ('intent', 'started', 'fs_done')) THEN
      RAISE EXCEPTION 'draft %: its bytes are being purged, it cannot reopen', OLD.id
        USING ERRCODE = 'CO005';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
