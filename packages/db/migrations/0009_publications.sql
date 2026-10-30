-- 0009_publications: a plan row and its Hub publication (schema §3.5, §9.5; SPEC §7 «Публикация
-- через Hub», §8, §8.1; PLAN 5б). No tables: the link lives on the row.
--
-- «Подготовить» uploads the files the row ships that Hub does not have yet (the platform copy
-- named by naming §5–6, accounted by SHA-256 in `hub_files`) or names the very same file already
-- in the page's vault; Hub creates a draft from the row's fields and returns its checks, kept in
-- `hub_checks`. «Отправить» — a person only — approves the version of the draft they saw. The
-- statuses come from Hub's feed every 10 minutes; a published one names its post
-- (`platform_post_ref`) or vault album (`vault_album_ref`): the row → publication → post link is
-- exact, the post is never matched. The poll's boundary and freshness are a `hub_sync_state` row
-- of dataset `publications`.

-- ---------------------------------------------------------------------------
-- The publication of a row (schema §3.5)
-- ---------------------------------------------------------------------------

--   hub_publication_id  — Hub's publication; one row per publication;
--   hub_kind            — what it publishes: by the surface (SPEC §7 table);
--   hub_status          — Hub's status as Hub gives it (its list grows: no CHECK), with
--                         `hub_status_reason`, `hub_status_at` (Hub's `statusChangedAt`) and
--                         `hub_updated_at` (Hub's `updatedAt`: a feed row older than it changes
--                         nothing, so a repeated read is idempotent);
--   hub_version         — the draft's content version: «Отправить» approves this one;
--   hub_checks          — Hub's checks of the draft: `{blocked, findings: [...]}`;
--   hub_files           — the files of the draft: `[{version_id, name, sha256, bytes, file_id |
--                         vault_media_ref, uploaded_at}]`; a repeated «Подготовить» uploads
--                         nothing these already hold;
--   hub_content_hash    — SHA-256 of the draft as sent: the same draft is not made twice;
--   hub_prepared_*      — who prepared it and the row version it was made from: a later change
--                         of the row makes the draft stale («Подготовить заново»);
--   hub_sent_*          — the person who sent it (agents prepare, people send, SPEC §11.1).
ALTER TABLE posting_plan_rows
  ADD COLUMN hub_publication_id bigint
    CONSTRAINT posting_plan_rows_hub_publication_id_positive CHECK (hub_publication_id > 0),
  ADD COLUMN hub_kind text CHECK (hub_kind IN (
    'fyp_post', 'subscriber_post', 'paid_post', 'story', 'vault_album'
  )),
  ADD COLUMN hub_status text,
  ADD COLUMN hub_status_reason text,
  ADD COLUMN hub_status_at timestamptz,
  ADD COLUMN hub_updated_at timestamptz,
  ADD COLUMN hub_version integer
    CONSTRAINT posting_plan_rows_hub_version_positive CHECK (hub_version > 0),
  ADD COLUMN hub_checks jsonb
    CONSTRAINT posting_plan_rows_hub_checks_object CHECK (jsonb_typeof(hub_checks) = 'object'),
  ADD COLUMN hub_files jsonb NOT NULL DEFAULT '[]'
    CONSTRAINT posting_plan_rows_hub_files_array CHECK (jsonb_typeof(hub_files) = 'array'),
  ADD COLUMN hub_content_hash text,
  ADD COLUMN hub_prepared_at timestamptz,
  ADD COLUMN hub_prepared_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  ADD COLUMN hub_prepared_version bigint,
  ADD COLUMN hub_sent_at timestamptz,
  ADD COLUMN hub_sent_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  ADD COLUMN platform_post_ref text,
  ADD COLUMN vault_album_ref text,
  -- A publication has its kind, status and draft; without one the row holds none of them.
  ADD CONSTRAINT posting_plan_rows_hub_publication CHECK (
    CASE WHEN hub_publication_id IS NULL
      THEN num_nonnulls(hub_kind, hub_status, hub_version, hub_checks, hub_prepared_at,
                        hub_sent_at, platform_post_ref, vault_album_ref) = 0
      ELSE num_nulls(hub_kind, hub_status, hub_version, hub_updated_at, hub_prepared_at) = 0
    END
  ),
  -- Sent by a person, at a time.
  ADD CONSTRAINT posting_plan_rows_hub_sent CHECK ((hub_sent_at IS NULL) = (hub_sent_by IS NULL)),
  -- A post or an album: one of the two, by the kind.
  ADD CONSTRAINT posting_plan_rows_hub_ref CHECK (
    num_nonnulls(platform_post_ref, vault_album_ref) <= 1
    AND (vault_album_ref IS NULL OR hub_kind = 'vault_album')
  );

CREATE UNIQUE INDEX posting_plan_rows_hub_publication
  ON posting_plan_rows (hub_publication_id) WHERE hub_publication_id IS NOT NULL;
-- The exact link of a post (album) to its row: the matching skips these posts (below).
CREATE INDEX posting_plan_rows_platform_post
  ON posting_plan_rows (model_id, account_id, platform_post_ref)
  WHERE platform_post_ref IS NOT NULL;
CREATE INDEX posting_plan_rows_vault_album
  ON posting_plan_rows (model_id, account_id, vault_album_ref)
  WHERE vault_album_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The matching skips what came through a publication (SPEC §7)
-- ---------------------------------------------------------------------------

-- A post (or a vault album) of the page that a Hub publication of ContentOps became: its
-- placement and exact evidence are written from the publication, the matching leaves it alone
-- and the rules of waiting and «не вышло» do not apply to its row.
CREATE FUNCTION is_publication_post(p_model uuid, p_account uuid, p_post_ref text)
  RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM posting_plan_rows
     WHERE model_id = p_model AND account_id = p_account AND platform_post_ref = p_post_ref)
$$;

CREATE FUNCTION is_publication_album(p_model uuid, p_account uuid, p_album_ref text)
  RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM posting_plan_rows
     WHERE model_id = p_model AND account_id = p_account AND vault_album_ref = p_album_ref)
$$;

-- ---------------------------------------------------------------------------
-- The status poll's boundary (schema §3.6): `hub_sync_state` of dataset `publications`
-- ---------------------------------------------------------------------------

-- `watermark_at` is the greatest Hub `updatedAt` read; the next read asks from it minus an
-- overlap. `last_success_at` — «Hub · статусы на 18:32».
ALTER TABLE hub_sync_state DROP CONSTRAINT hub_sync_state_dataset_check;
ALTER TABLE hub_sync_state ADD CONSTRAINT hub_sync_state_dataset_check
  CHECK (dataset IN ('posts', 'raw_media', 'vault_media', 'creator_stats', 'publications'));
