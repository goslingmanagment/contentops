-- 0012_inbox_reads: «Приехало» reads the last fetch of each draft by an index (SPEC §12.0).
--
-- The list and its counter take, for every open draft, the last `fetch` of its revision: the
-- progress of a running download or the answer of a fetch that gave up. Without an index each
-- draft scanned the whole queue: at 4 334 open drafts and 13 800 works on the pilot that was
-- 9.9 s of one query. The partial index holds only fetch rows, newest first per revision.
CREATE INDEX work_operations_fetch_revision
  ON work_operations (model_id, source_revision_id, created_at DESC)
  WHERE kind = 'fetch';
