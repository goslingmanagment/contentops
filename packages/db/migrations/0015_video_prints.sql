-- 0015_video_prints: «Похоже на ролик» at intake (SPEC §6.2).
--
-- A montage of Ари came two or three times: the editor's original, a second export and a copy
-- from the Я.Диск queue with the loudness evened out — other bytes, the same picture. Each
-- became a FYP of its own (17 extra), and Hub matching found their posts disputed. The print of
-- a video is the duration of its picture and the pHash of ten frames at fixed shares of it,
-- taken from `preview.mp4`: no decoding of the source. A print close to one of an accepted
-- video of the model asks ◆ «Похоже на ролик FYP-0019/master»: «Это копия» (an alias of that
-- file, as an exact duplicate) or «Отдельный объект». The hint never decides by itself.
CREATE TABLE video_prints (
  -- The bytes the preview was built from: the source of a draft or a version, as
  -- `rendition_generations.input_sha256` names them.
  sha256 bytea NOT NULL CONSTRAINT video_prints_sha256_check CHECK (octet_length(sha256) = 32),
  algorithm text NOT NULL,
  algo_version text NOT NULL,
  -- The picture's duration (the video stream of the preview), not the container's: a copy
  -- with a longer audio track has the same picture.
  duration_ms integer NOT NULL CONSTRAINT video_prints_duration_check CHECK (duration_ms > 0),
  -- The pHash of each frame, in the order of the shares.
  frames bit(64)[] NOT NULL CONSTRAINT video_prints_frames_check
    CHECK (cardinality(frames) BETWEEN 1 AND 32 AND array_position(frames, NULL) IS NULL),
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sha256, algorithm, algo_version)
);
-- The candidates of a print are the prints of about the same duration.
CREATE INDEX video_prints_duration ON video_prints (algorithm, algo_version, duration_ms);
-- A print names the source of a version: the accepted file is found by it, not by a scan.
CREATE INDEX asset_versions_source ON asset_versions (source_sha256);

ALTER TABLE inbox_draft_candidates DROP CONSTRAINT inbox_draft_candidates_kind_check;
ALTER TABLE inbox_draft_candidates ADD CONSTRAINT inbox_draft_candidates_kind_check
  CHECK (kind IN (
    'order', 'existing_item', 'exact_duplicate', 'similar_photo', 'similar_video', 'legacy_id',
    'source_parent', 'content_type'
  ));

-- ◆ «Похоже на ролик»: the draft waits for «Это копия» or «Отдельный объект».
ALTER TABLE inbox_drafts DROP CONSTRAINT inbox_drafts_blocked_reason_check;
ALTER TABLE inbox_drafts ADD CONSTRAINT inbox_drafts_blocked_reason_check
  CHECK (blocked_reason IN (
    'ambiguous_order', 'video_in_set', 'id_collision', 'cross_model_dup', 'master_failed',
    'needs_type', 'source_unavailable', 'deferred', 'which_frame', 'row_changed', 'archive_split',
    'video_copy'
  ));

-- The print of a video whose preview is ready: a light work of `worker-video` (ten seeks in
-- the preview), low priority for the library accepted before it.
ALTER TABLE work_operations DROP CONSTRAINT work_operations_kind_check;
ALTER TABLE work_operations ADD CONSTRAINT work_operations_kind_check
  CHECK (kind IN (
    'scan', 'fetch', 'hash', 'unpack_archive', 'import_parse', 'register', 'propose',
    'export', 'hub_sync', 'hub_history', 'hub_publish', 'annotate', 'verify_blobs', 'backup',
    'derive_video', 'encode_master', 'verify_master', 'render', 'uniq_render',
    'render_compat', 'extract_frame', 'derive_image', 'video_print'
  ));
