CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';

CREATE TABLE public.asset_versions (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    asset_id uuid NOT NULL,
    version_no integer NOT NULL,
    master_sha256 bytea NOT NULL,
    source_sha256 bytea,
    source_revision_id uuid,
    work_id uuid,
    duration_ms bigint,
    width integer,
    height integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT asset_versions_source_sha256_check CHECK ((octet_length(source_sha256) = 32)),
    CONSTRAINT asset_versions_version_no_check CHECK ((version_no >= 1))
);

ALTER TABLE public.asset_versions OWNER TO contentops_migrate;

CREATE TABLE public.inbox_drafts (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    group_id uuid NOT NULL,
    source_revision_id uuid,
    web_upload_id uuid,
    from_version_id uuid,
    origin text NOT NULL,
    state text DEFAULT 'discovered'::text NOT NULL,
    outcome text,
    priority integer DEFAULT 0 NOT NULL,
    discovered_at timestamp with time zone DEFAULT now() NOT NULL,
    ready_at timestamp with time zone,
    decided_at timestamp with time zone,
    decided_by uuid,
    md5 bytea,
    byte_size bigint,
    path text,
    preview_url_at timestamp with time zone,
    source_sha256 bytea,
    source_blob_sha256 bytea,
    master_sha256 bytea,
    master_verified_at timestamp with time zone,
    master_is_source boolean DEFAULT false NOT NULL,
    proposed_role text,
    proposed_ordinal integer,
    proposed_life_use text,
    target_item_id uuid,
    target_asset_id uuid,
    duplicate_of_version_id uuid,
    blocked_reason text,
    applied_item_id uuid,
    applied_version_id uuid,
    reject_reason text,
    rejected_at timestamp with time zone,
    reopened_at timestamp with time zone,
    reopen_count integer DEFAULT 0 NOT NULL,
    error text,
    search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('russian'::regconfig, translate(COALESCE(path, ''::text), '/._-'::text, '    '::text))) STORED,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT inbox_drafts_accept_applied CHECK (((outcome <> ALL (ARRAY['new_item'::text, 'append'::text])) OR (applied_item_id IS NOT NULL))),
    CONSTRAINT inbox_drafts_accept_verified CHECK (((outcome <> ALL (ARRAY['new_item'::text, 'append'::text])) OR (master_verified_at IS NOT NULL))),
    CONSTRAINT inbox_drafts_alias_target CHECK (((outcome <> 'alias'::text) OR (duplicate_of_version_id IS NOT NULL))),
    CONSTRAINT inbox_drafts_blocked_reason_check CHECK ((blocked_reason = ANY (ARRAY['ambiguous_order'::text, 'video_in_set'::text, 'id_collision'::text, 'cross_model_dup'::text, 'master_failed'::text, 'needs_type'::text, 'source_unavailable'::text, 'deferred'::text, 'which_frame'::text, 'row_changed'::text, 'archive_split'::text]))),
    CONSTRAINT inbox_drafts_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT inbox_drafts_md5_check CHECK ((octet_length(md5) = 16)),
    CONSTRAINT inbox_drafts_one_input CHECK ((num_nonnulls(source_revision_id, web_upload_id, from_version_id) = 1)),
    CONSTRAINT inbox_drafts_origin_check CHECK ((origin = ANY (ARRAY['disk_scan'::text, 'web_upload'::text, 'legacy_import'::text, 'archive'::text, 'derived'::text]))),
    CONSTRAINT inbox_drafts_outcome CHECK (((state = 'resolved'::text) = (outcome IS NOT NULL))),
    CONSTRAINT inbox_drafts_outcome_check CHECK ((outcome = ANY (ARRAY['new_item'::text, 'append'::text, 'alias'::text, 'rejected'::text]))),
    CONSTRAINT inbox_drafts_proposed_life_use_check CHECK ((proposed_life_use = ANY (ARRAY['feed'::text, 'chats'::text, 'both'::text]))),
    CONSTRAINT inbox_drafts_proposed_ordinal_check CHECK (((proposed_ordinal >= 1) AND (proposed_ordinal <= 999))),
    CONSTRAINT inbox_drafts_proposed_role_check CHECK ((proposed_role = ANY (ARRAY['master'::text, 'teaser'::text, 'pic'::text, 'raw'::text, 'ed'::text, 'clip'::text, 'thumb'::text, 'cap'::text]))),
    CONSTRAINT inbox_drafts_rejected_at CHECK (((outcome <> 'rejected'::text) OR (rejected_at IS NOT NULL))),
    CONSTRAINT inbox_drafts_reopen_count_check CHECK ((reopen_count >= 0)),
    CONSTRAINT inbox_drafts_source_sha256_check CHECK ((octet_length(source_sha256) = 32)),
    CONSTRAINT inbox_drafts_state_check CHECK ((state = ANY (ARRAY['discovered'::text, 'processing'::text, 'ready'::text, 'resolved'::text]))),
    CONSTRAINT inbox_drafts_verified_master CHECK (((master_verified_at IS NULL) OR (master_sha256 IS NOT NULL)))
);

ALTER TABLE public.inbox_drafts OWNER TO contentops_migrate;

CREATE TABLE public.web_uploads (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    upload_id text NOT NULL,
    principal_id uuid NOT NULL,
    client_filename text NOT NULL,
    declared_kind text NOT NULL,
    target_item_id uuid,
    size_expected bigint NOT NULL,
    bytes_received bigint DEFAULT 0 NOT NULL,
    sha256 bytea,
    state text DEFAULT 'receiving'::text NOT NULL,
    tmp_key text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    plan_row_id uuid,
    CONSTRAINT web_uploads_bytes_received_check CHECK ((bytes_received >= 0)),
    CONSTRAINT web_uploads_declared_kind_check CHECK ((declared_kind = ANY (ARRAY['fyp_edit'::text, 'teaser'::text, 'processed_frames'::text, 'master_version'::text, 'other'::text]))),
    CONSTRAINT web_uploads_progress CHECK ((bytes_received <= size_expected)),
    CONSTRAINT web_uploads_registered CHECK (((state <> 'registered'::text) OR (sha256 IS NOT NULL))),
    CONSTRAINT web_uploads_size_expected_check CHECK ((size_expected >= 0)),
    CONSTRAINT web_uploads_state_check CHECK ((state = ANY (ARRAY['receiving'::text, 'received'::text, 'verified'::text, 'registered'::text, 'failed'::text, 'abandoned'::text])))
);

ALTER TABLE public.web_uploads OWNER TO contentops_migrate;

CREATE TABLE public.work_operations (
    id uuid DEFAULT uuidv7() NOT NULL,
    model_id uuid,
    kind text NOT NULL,
    work_key text NOT NULL,
    account_id uuid,
    dataset text,
    scope text,
    window_from timestamp with time zone,
    window_to timestamp with time zone,
    pipeline_version text,
    recipe_digest text,
    state text DEFAULT 'pending'::text NOT NULL,
    paused_reason text,
    priority integer DEFAULT 0 NOT NULL,
    attempt_no integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_owner text,
    lease_until timestamp with time zone,
    fence_generation bigint DEFAULT 0 NOT NULL,
    heartbeat_at timestamp with time zone,
    input_sha256 bytea,
    output_sha256 bytea,
    output_ref text,
    progress_num bigint,
    progress_den bigint,
    progress_note text,
    checkpoint jsonb,
    failure_kind text,
    error_code text,
    error_text text,
    report jsonb,
    stream_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    draft_id uuid,
    source_revision_id uuid,
    asset_version_id uuid,
    manifest_id uuid,
    receipt_id uuid,
    generation_id uuid,
    CONSTRAINT work_operations_attempt_no_check CHECK ((attempt_no >= 0)),
    CONSTRAINT work_operations_failure_kind_check CHECK ((failure_kind = ANY (ARRAY['transient'::text, 'permanent'::text]))),
    CONSTRAINT work_operations_finished_at CHECK (((state = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) = (finished_at IS NOT NULL))),
    CONSTRAINT work_operations_global_kinds CHECK (((model_id IS NULL) = (kind = ANY (ARRAY['verify_blobs'::text, 'backup'::text])))),
    CONSTRAINT work_operations_input_sha256_check CHECK ((octet_length(input_sha256) = 32)),
    CONSTRAINT work_operations_kind_check CHECK ((kind = ANY (ARRAY['scan'::text, 'fetch'::text, 'hash'::text, 'unpack_archive'::text, 'import_parse'::text, 'register'::text, 'propose'::text, 'export'::text, 'hub_sync'::text, 'hub_history'::text, 'hub_publish'::text, 'annotate'::text, 'verify_blobs'::text, 'backup'::text, 'derive_video'::text, 'encode_master'::text, 'verify_master'::text, 'render'::text, 'uniq_render'::text, 'render_compat'::text, 'extract_frame'::text, 'derive_image'::text]))),
    CONSTRAINT work_operations_model_targets CHECK (((model_id IS NOT NULL) OR (num_nonnulls(account_id, draft_id, source_revision_id, asset_version_id, manifest_id, receipt_id) = 0))),
    CONSTRAINT work_operations_output_sha256_check CHECK ((octet_length(output_sha256) = 32)),
    CONSTRAINT work_operations_paused_reason_format CHECK ((paused_reason ~ '^switch_off:.+$'::text)),
    CONSTRAINT work_operations_running_lease CHECK (((state <> 'running'::text) OR ((lease_owner IS NOT NULL) AND (lease_until IS NOT NULL)))),
    CONSTRAINT work_operations_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'retry_wait'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

ALTER TABLE public.work_operations OWNER TO contentops_migrate;

CREATE FUNCTION public.blob_is_referenced(sha bytea) RETURNS boolean
    LANGUAGE sql STABLE PARALLEL SAFE
    RETURN ((EXISTS (SELECT 1 FROM public.asset_versions v WHERE (v.master_sha256 = blob_is_referenced.sha))) OR (EXISTS (SELECT 1 FROM public.inbox_drafts d WHERE ((d.master_sha256 = blob_is_referenced.sha) AND (d.state <> 'resolved'::text)))) OR (EXISTS (SELECT 1 FROM public.inbox_drafts d WHERE ((d.source_blob_sha256 = blob_is_referenced.sha) AND (d.state <> 'resolved'::text)))) OR (EXISTS (SELECT 1 FROM public.web_uploads u WHERE ((u.sha256 = blob_is_referenced.sha) AND (u.state = ANY (ARRAY['receiving'::text, 'received'::text, 'verified'::text]))))) OR (EXISTS (SELECT 1 FROM public.work_operations w WHERE ((w.output_sha256 = blob_is_referenced.sha) AND (w.state = ANY (ARRAY['pending'::text, 'running'::text, 'retry_wait'::text]))))));

ALTER FUNCTION public.blob_is_referenced(sha bytea) OWNER TO contentops_migrate;

CREATE FUNCTION public.catalog_tsquery(q text) RETURNS tsquery
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN (websearch_to_tsquery('russian'::regconfig, q) || websearch_to_tsquery('english'::regconfig, q));

ALTER FUNCTION public.catalog_tsquery(q text) OWNER TO contentops_migrate;

CREATE FUNCTION public.role_fits_type(item_type text, role text) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN COALESCE(CASE item_type WHEN 'PPV'::text THEN (role = ANY (ARRAY['master'::text, 'teaser'::text, 'pic'::text, 'thumb'::text])) WHEN 'SET'::text THEN (role = ANY (ARRAY['raw'::text, 'ed'::text])) WHEN 'SXT'::text THEN (role = ANY (ARRAY['pic'::text, 'clip'::text])) WHEN 'CUS'::text THEN (role = ANY (ARRAY['master'::text, 'pic'::text])) WHEN 'FYP'::text THEN (role = 'master'::text) WHEN 'LIFE'::text THEN (role = ANY (ARRAY['pic'::text, 'clip'::text])) WHEN 'RAW'::text THEN (role = 'raw'::text) WHEN 'PRM'::text THEN (role = ANY (ARRAY['pic'::text, 'clip'::text])) ELSE NULL::boolean END, false);

ALTER FUNCTION public.role_fits_type(item_type text, role text) OWNER TO contentops_migrate;

CREATE TABLE public.aliases (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    kind text NOT NULL,
    value_raw text NOT NULL,
    value_norm text GENERATED ALWAYS AS (lower(NORMALIZE(value_raw, NFC))) STORED NOT NULL,
    item_id uuid,
    asset_id uuid,
    source_object_id uuid,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT aliases_kind_check CHECK ((kind = ANY (ARRAY['legacy_path'::text, 'legacy_name'::text, 'legacy_id'::text, 'sub_handle'::text, 'merged_id'::text, 'vault_album'::text, 'tg_card'::text, 'resource_id'::text, 'registry_row'::text]))),
    CONSTRAINT aliases_one_target CHECK ((num_nonnulls(item_id, asset_id) = 1))
);

ALTER TABLE public.aliases OWNER TO contentops_migrate;

CREATE TABLE public.chronology_entries (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    item_id uuid NOT NULL,
    asset_version_id uuid NOT NULL,
    at_ms bigint NOT NULL,
    end_ms bigint,
    text text NOT NULL,
    source text NOT NULL,
    frame_artifact_id uuid,
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('russian'::regconfig, text)) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT chronology_entries_at_ms_check CHECK ((at_ms >= 0)),
    CONSTRAINT chronology_entries_source_check CHECK ((source = ANY (ARRAY['ai'::text, 'human'::text, 'import'::text]))),
    CONSTRAINT chronology_entries_span CHECK (((end_ms IS NULL) OR (end_ms > at_ms)))
);

ALTER TABLE public.chronology_entries OWNER TO contentops_migrate;

CREATE TABLE public.content_items (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    type text NOT NULL,
    number integer NOT NULL,
    title text,
    title_en text,
    description text,
    ppv_kind text,
    raw_purpose text,
    shot_on date,
    cover_membership_id uuid,
    has_second_person boolean,
    name_in_media text,
    created_from_group_id uuid,
    origin text NOT NULL,
    promo_channel_id uuid,
    merged_into_item_id uuid,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    delete_reason text,
    search_tsv tsvector GENERATED ALWAYS AS (((setweight(to_tsvector('russian'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(title_en, ''::text)), 'A'::"char")) || setweight(to_tsvector('russian'::regconfig, COALESCE(description, ''::text)), 'B'::"char"))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    default_contractor_id uuid,
    CONSTRAINT content_items_default_contractor CHECK (((default_contractor_id IS NULL) OR (type = 'PRM'::text))),
    CONSTRAINT content_items_merged_deleted CHECK (((merged_into_item_id IS NULL) OR (deleted_at IS NOT NULL))),
    CONSTRAINT content_items_name_in_media CHECK (((name_in_media IS NULL) OR (type = 'CUS'::text))),
    CONSTRAINT content_items_name_in_media_check CHECK ((name_in_media = ANY (ARRAY['yes'::text, 'no'::text, 'unknown'::text]))),
    CONSTRAINT content_items_number_range CHECK (((number >= 1) AND (number <= 999999))),
    CONSTRAINT content_items_origin_check CHECK ((origin = ANY (ARRAY['intake'::text, 'import'::text, 'manual'::text]))),
    CONSTRAINT content_items_ppv_kind CHECK (((type = 'PPV'::text) = (ppv_kind IS NOT NULL))),
    CONSTRAINT content_items_ppv_kind_check CHECK ((ppv_kind = ANY (ARRAY['bundle'::text, 'dm'::text]))),
    CONSTRAINT content_items_promo_channel CHECK (((type = 'PRM'::text) = (promo_channel_id IS NOT NULL))),
    CONSTRAINT content_items_raw_purpose CHECK (((type = 'RAW'::text) = (raw_purpose IS NOT NULL))),
    CONSTRAINT content_items_raw_purpose_check CHECK ((raw_purpose = ANY (ARRAY['fyp'::text, 'ppv'::text, 'mass_dm'::text, 'unknown'::text]))),
    CONSTRAINT content_items_type_check CHECK ((type = ANY (ARRAY['PPV'::text, 'SET'::text, 'SXT'::text, 'CUS'::text, 'FYP'::text, 'LIFE'::text, 'RAW'::text, 'PRM'::text])))
);

ALTER TABLE public.content_items OWNER TO contentops_migrate;

CREATE TABLE public.item_memberships (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    item_id uuid NOT NULL,
    item_type text NOT NULL,
    asset_id uuid NOT NULL,
    variant_no integer DEFAULT 0 NOT NULL,
    kind text NOT NULL,
    role text NOT NULL,
    ordinal integer,
    display_position integer,
    selected boolean DEFAULT false NOT NULL,
    life_use text,
    pinned_version_id uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    added_by uuid,
    removed_at timestamp with time zone,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT item_memberships_kind_check CHECK ((kind = ANY (ARRAY['owned'::text, 'reference'::text]))),
    CONSTRAINT item_memberships_life_use CHECK (((life_use IS NULL) OR (item_type = 'LIFE'::text))),
    CONSTRAINT item_memberships_life_use_check CHECK ((life_use = ANY (ARRAY['feed'::text, 'chats'::text, 'both'::text]))),
    CONSTRAINT item_memberships_ordinal CHECK (((role = ANY (ARRAY['pic'::text, 'raw'::text, 'ed'::text, 'clip'::text])) = (ordinal IS NOT NULL))),
    CONSTRAINT item_memberships_ordinal_range CHECK (((ordinal >= 1) AND (ordinal <= 999))),
    CONSTRAINT item_memberships_pinned CHECK (((pinned_version_id IS NULL) OR (kind = 'reference'::text))),
    CONSTRAINT item_memberships_reference_in_prm CHECK (((kind = 'owned'::text) OR (item_type = 'PRM'::text))),
    CONSTRAINT item_memberships_removed_position CHECK (((removed_at IS NULL) OR (display_position IS NULL))),
    CONSTRAINT item_memberships_role_check CHECK ((role = ANY (ARRAY['master'::text, 'teaser'::text, 'pic'::text, 'raw'::text, 'ed'::text, 'clip'::text, 'thumb'::text, 'cap'::text]))),
    CONSTRAINT item_memberships_role_fits_type CHECK (((kind = 'reference'::text) OR public.role_fits_type(item_type, role))),
    CONSTRAINT item_memberships_variant CHECK (((kind = 'reference'::text) OR (variant_no = 0) OR ((item_type = 'FYP'::text) AND (role = 'master'::text))))
);

ALTER TABLE public.item_memberships OWNER TO contentops_migrate;

CREATE FUNCTION public.catalog_search(p_model_id uuid, q text) RETURNS TABLE(item_id uuid, rank real)
    LANGUAGE sql STABLE PARALLEL SAFE
    BEGIN ATOMIC
 WITH query AS (
          SELECT public.catalog_tsquery(catalog_search.q) AS ts,
             lower(NORMALIZE(catalog_search.q, NFC)) AS norm,
             (('%'::text || replace(replace(replace(lower(NORMALIZE(catalog_search.q, NFC)), '\'::text, '\\'::text), '%'::text, '\%'::text), '_'::text, '\_'::text)) || '%'::text) AS pattern
         ), hits AS (
          SELECT i_1.id AS item_id,
             ts_rank(i_1.search_tsv, query.ts) AS rank
            FROM public.content_items i_1,
             query
           WHERE ((i_1.model_id = catalog_search.p_model_id) AND (i_1.search_tsv @@ query.ts))
         UNION ALL
          SELECT COALESCE(a.item_id, owner.item_id) AS "coalesce",
                 CASE
                     WHEN (a.value_norm = query.norm) THEN 1.0
                     ELSE 0.5
                 END AS "case"
            FROM ((public.aliases a
              CROSS JOIN query)
              LEFT JOIN public.item_memberships owner ON (((owner.model_id = a.model_id) AND (owner.asset_id = a.asset_id) AND (owner.kind = 'owned'::text) AND (owner.removed_at IS NULL))))
           WHERE ((a.model_id = catalog_search.p_model_id) AND (query.norm <> ''::text) AND (a.value_norm ~~ query.pattern))
         UNION ALL
          SELECT c.item_id,
             ts_rank(c.tsv, query.ts) AS ts_rank
            FROM public.chronology_entries c,
             query
           WHERE ((c.model_id = catalog_search.p_model_id) AND (c.tsv @@ query.ts))
         )
  SELECT h.item_id,
     max(h.rank) AS max
    FROM (hits h
      JOIN public.content_items i ON (((i.model_id = catalog_search.p_model_id) AND (i.id = h.item_id))))
   WHERE (i.deleted_at IS NULL)
   GROUP BY h.item_id
   ORDER BY (max(h.rank)) DESC, h.item_id;
END;

ALTER FUNCTION public.catalog_search(p_model_id uuid, q text) OWNER TO contentops_migrate;

CREATE FUNCTION public.check_sealed_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  parent_table text := TG_ARGV[0];
  child_table text := TG_ARGV[1];
  fk_column text := TG_ARGV[2];
  parent_id uuid;
  expected integer;
  actual integer;
  top integer;
BEGIN
  IF TG_TABLE_NAME = parent_table THEN
    parent_id := NEW.id;
  ELSE
    parent_id := (to_jsonb(NEW) ->> fk_column)::uuid;
  END IF;
  EXECUTE format('SELECT entry_count FROM %I WHERE model_id = $1 AND id = $2', parent_table)
    INTO expected USING NEW.model_id, parent_id;
  EXECUTE format('SELECT count(*), max(position) FROM %I WHERE model_id = $1 AND %I = $2',
                 child_table, fk_column)
    INTO actual, top USING NEW.model_id, parent_id;
  IF actual IS DISTINCT FROM expected OR top IS DISTINCT FROM expected THEN
    RAISE EXCEPTION '% %: % rows up to position %, sealed with %',
      parent_table, parent_id, actual, top, expected
      USING ERRCODE = 'CO004';
  END IF;
  RETURN NULL;
END
$_$;

ALTER FUNCTION public.check_sealed_count() OWNER TO contentops_migrate;

CREATE FUNCTION public.check_tag_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM tags WHERE id = NEW.tag_id AND model_id IS NOT NULL
                                    AND model_id <> NEW.model_id) THEN
    RAISE EXCEPTION 'tag % belongs to another model', NEW.tag_id
      USING ERRCODE = 'CO006';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.check_tag_scope() OWNER TO contentops_migrate;

CREATE FUNCTION public.content_item_second_person_late() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE posting_plan_rows r
     SET cancelled_at = now(),
         cancelled_by = nullif(current_setting('app.actor_id', true), '')::uuid,
         cancel_reason = 'second_person',
         row_version = r.row_version + 1
    FROM accounts a
   WHERE r.model_id = NEW.model_id AND r.item_id = NEW.id
     AND r.marked_at IS NULL AND r.cancelled_at IS NULL
     AND a.model_id = r.model_id AND a.id = r.account_id AND a.platform = 'onlyfans';
  RETURN NULL;
END
$$;

ALTER FUNCTION public.content_item_second_person_late() OWNER TO contentops_migrate;

CREATE FUNCTION public.custom_order_delivery_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  order_status text;
  target_part text;
  target_retracts uuid;
BEGIN
  SELECT status INTO order_status FROM custom_orders
   WHERE model_id = NEW.model_id AND id = NEW.order_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF order_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'order %: % takes no delivery or retraction', NEW.order_id, order_status
      USING ERRCODE = 'CO005';
  END IF;
  IF NEW.retracts_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT part, retracts_id INTO target_part, target_retracts FROM custom_order_deliveries
   WHERE model_id = NEW.model_id AND order_id = NEW.order_id AND id = NEW.retracts_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF target_retracts IS NOT NULL THEN
    RAISE EXCEPTION 'delivery %: a retraction is not retracted', NEW.retracts_id
      USING ERRCODE = 'CO005';
  END IF;
  IF target_part = 'video' THEN
    UPDATE custom_orders SET video_completed_at = NULL, video_completed_by = NULL
     WHERE model_id = NEW.model_id AND id = NEW.order_id AND video_completed_at IS NOT NULL;
  ELSE
    UPDATE custom_orders SET photos_completed_at = NULL, photos_completed_by = NULL
     WHERE model_id = NEW.model_id AND id = NEW.order_id AND photos_completed_at IS NOT NULL;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.custom_order_delivery_lock() OWNER TO contentops_migrate;

CREATE TABLE public.asset_manifest_entries (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    manifest_id uuid NOT NULL,
    "position" integer NOT NULL,
    item_id uuid NOT NULL,
    membership_id uuid,
    asset_id uuid NOT NULL,
    asset_version_id uuid NOT NULL,
    handle_snapshot text NOT NULL,
    selected_snapshot boolean,
    life_use_snapshot text,
    CONSTRAINT asset_manifest_entries_life_use_snapshot_check CHECK ((life_use_snapshot = ANY (ARRAY['feed'::text, 'chats'::text, 'both'::text]))),
    CONSTRAINT asset_manifest_entries_position_check CHECK (("position" >= 1))
);

ALTER TABLE public.asset_manifest_entries OWNER TO contentops_migrate;

CREATE TABLE public.assets (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    created_in_item_id uuid NOT NULL,
    media_kind text NOT NULL,
    current_version_id uuid NOT NULL,
    variant_kind text DEFAULT 'none'::text NOT NULL,
    variant_no integer DEFAULT 0 NOT NULL,
    uniq_level text,
    retired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT assets_media_kind_check CHECK ((media_kind = ANY (ARRAY['video'::text, 'image'::text]))),
    CONSTRAINT assets_uniq_level CHECK (((variant_kind = 'uniq'::text) = (uniq_level IS NOT NULL))),
    CONSTRAINT assets_uniq_level_check CHECK ((uniq_level = ANY (ARRAY['soft'::text, 'trim'::text, 'mirror'::text]))),
    CONSTRAINT assets_variant_kind_check CHECK ((variant_kind = ANY (ARRAY['none'::text, 'uniq'::text]))),
    CONSTRAINT assets_variant_no CHECK (((variant_kind = 'uniq'::text) = (variant_no > 0))),
    CONSTRAINT assets_variant_no_check CHECK ((variant_no >= 0))
);

ALTER TABLE public.assets OWNER TO contentops_migrate;

CREATE TABLE public.custom_order_deliveries (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    order_id uuid NOT NULL,
    part text,
    item_id uuid,
    item_type text DEFAULT 'CUS'::text NOT NULL,
    manifest_id uuid,
    draft_id uuid,
    delivered_at timestamp with time zone,
    basis jsonb,
    evidence_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    linked_by uuid,
    confirmed_by uuid,
    retracts_id uuid,
    retract_reason text,
    CONSTRAINT custom_order_deliveries_item_type_check CHECK ((item_type = 'CUS'::text)),
    CONSTRAINT custom_order_deliveries_not_self CHECK ((retracts_id <> id)),
    CONSTRAINT custom_order_deliveries_part_check CHECK ((part = ANY (ARRAY['video'::text, 'photos'::text]))),
    CONSTRAINT custom_order_deliveries_shape CHECK (
CASE
    WHEN (retracts_id IS NULL) THEN ((num_nulls(part, item_id, manifest_id, delivered_at, basis) = 0) AND (retract_reason IS NULL))
    ELSE ((num_nonnulls(part, item_id, manifest_id, delivered_at, basis, draft_id, confirmed_by) = 0) AND (retract_reason IS NOT NULL))
END)
);

ALTER TABLE public.custom_order_deliveries OWNER TO contentops_migrate;

CREATE FUNCTION public.custom_order_live_files(p_model_id uuid, p_order_id uuid, p_part text) RETURNS integer
    LANGUAGE sql STABLE PARALLEL SAFE
    RETURN (SELECT (count(DISTINCT e.asset_id))::integer AS count FROM ((public.custom_order_deliveries d JOIN public.asset_manifest_entries e ON (((e.model_id = d.model_id) AND (e.manifest_id = d.manifest_id)))) JOIN public.assets a ON (((a.model_id = e.model_id) AND (a.id = e.asset_id)))) WHERE ((d.model_id = custom_order_live_files.p_model_id) AND (d.order_id = custom_order_live_files.p_order_id) AND (d.part = custom_order_live_files.p_part) AND (a.media_kind = CASE custom_order_live_files.p_part WHEN 'video'::text THEN 'video'::text ELSE 'image'::text END) AND (NOT (EXISTS (SELECT 1 FROM public.custom_order_deliveries r WHERE (r.retracts_id = d.id))))));

ALTER FUNCTION public.custom_order_live_files(p_model_id uuid, p_order_id uuid, p_part text) OWNER TO contentops_migrate;

CREATE FUNCTION public.custom_order_revision_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  order_status text;
BEGIN
  SELECT status INTO order_status FROM custom_orders
   WHERE model_id = NEW.model_id AND id = NEW.order_id
     FOR NO KEY UPDATE;
  IF order_status = 'closed' AND NOT NEW.done THEN
    RAISE EXCEPTION 'order %: closed, a revision cannot be open', NEW.order_id
      USING ERRCODE = 'CO005';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.custom_order_revision_lock() OWNER TO contentops_migrate;

CREATE FUNCTION public.custom_order_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  parts_done boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('closed', 'cancelled') THEN
    IF NEW.status <> OLD.status
       OR (NEW.expects_video, NEW.expects_photos, NEW.photo_count, NEW.video_completed_at,
           NEW.photos_completed_at)
          IS DISTINCT FROM
          (OLD.expects_video, OLD.expects_photos, OLD.photo_count, OLD.video_completed_at,
           OLD.photos_completed_at) THEN
      RAISE EXCEPTION 'order %: % is final', OLD.id, OLD.status
        USING ERRCODE = 'CO005';
    END IF;
    RETURN NEW;
  END IF;

  -- A mark of a part that was not ordered is left to CHECK `custom_orders_*_mark`.
  IF NEW.video_completed_at IS NOT NULL AND NEW.expects_video
     AND custom_order_live_files(NEW.model_id, NEW.id, 'video') = 0 THEN
    RAISE EXCEPTION 'order %: the video part has no live delivery', NEW.id
      USING ERRCODE = 'CO005';
  END IF;
  IF NEW.photos_completed_at IS NOT NULL AND NEW.expects_photos
     AND custom_order_live_files(NEW.model_id, NEW.id, 'photos') < coalesce(NEW.photo_count, 1) THEN
    RAISE EXCEPTION 'order %: % of % photos delivered',
      NEW.id, custom_order_live_files(NEW.model_id, NEW.id, 'photos'), coalesce(NEW.photo_count, 1)
      USING ERRCODE = 'CO005';
  END IF;

  parts_done := (NOT NEW.expects_video OR NEW.video_completed_at IS NOT NULL)
            AND (NOT NEW.expects_photos OR NEW.photos_completed_at IS NOT NULL);
  IF NEW.status IN ('open', 'delivered') THEN
    NEW.status := CASE WHEN parts_done THEN 'delivered' ELSE 'open' END;
  ELSIF NEW.status = 'closed' THEN
    IF NOT parts_done THEN
      RAISE EXCEPTION 'order %: not every ordered part is delivered', NEW.id
        USING ERRCODE = 'CO005';
    END IF;
    IF EXISTS (SELECT 1 FROM custom_order_revisions
                WHERE model_id = NEW.model_id AND order_id = NEW.id AND NOT done) THEN
      RAISE EXCEPTION 'order %: a revision is open', NEW.id
        USING ERRCODE = 'CO005';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.custom_order_status() OWNER TO contentops_migrate;

CREATE FUNCTION public.forbid_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  col text;
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb := to_jsonb(NEW);
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF NOT old_row ? col THEN
      RAISE EXCEPTION 'forbid_change on %: no column %', TG_TABLE_NAME, col;
    END IF;
    IF old_row -> col IS DISTINCT FROM new_row -> col THEN
      RAISE EXCEPTION 'column %.% cannot change', TG_TABLE_NAME, col
        USING ERRCODE = 'CO003';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.forbid_change() OWNER TO contentops_migrate;

CREATE FUNCTION public.forbid_update_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% on %: rows are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'CO002';
END
$$;

ALTER FUNCTION public.forbid_update_delete() OWNER TO contentops_migrate;

CREATE FUNCTION public.inbox_draft_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.state = 'resolved'
     AND (NEW.state, NEW.outcome) IS DISTINCT FROM (OLD.state, OLD.outcome) THEN
    IF OLD.outcome <> 'rejected' OR NEW.state <> 'ready' THEN
      RAISE EXCEPTION 'draft %: % (%) → % is not allowed', OLD.id, OLD.state, OLD.outcome, NEW.state
        USING ERRCODE = 'CO005';
    END IF;
    PERFORM 1 FROM blobs WHERE sha256 IN (OLD.master_sha256, OLD.source_blob_sha256) FOR SHARE;
    IF EXISTS (SELECT 1 FROM blobs WHERE sha256 IN (OLD.master_sha256, OLD.source_blob_sha256)
                                     AND state <> 'present') THEN
      RAISE EXCEPTION 'draft %: its bytes were removed, it cannot reopen', OLD.id
        USING ERRCODE = 'CO005';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.inbox_draft_transition() OWNER TO contentops_migrate;

CREATE FUNCTION public.jsonb_has_secret(doc jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN ((doc IS NOT NULL) AND jsonb_path_exists(doc, 'strict $.**?(@.type() == "object").keyvalue()?(@."key" like_regex "^(password|password_hash|token|token_hash|secret|cookie|set-cookie|authorization)$" flag "i")'::jsonpath, '{}'::jsonb, true));

ALTER FUNCTION public.jsonb_has_secret(doc jsonb) OWNER TO contentops_migrate;

CREATE FUNCTION public.log_row_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_actor_type text := nullif(current_setting('app.actor_type', true), '');
  v_actor_id text := nullif(current_setting('app.actor_id', true), '');
  v_actor_label text := nullif(current_setting('app.actor_label', true), '');
  v_action text := nullif(current_setting('app.action', true), '');
  v_request_id text := nullif(current_setting('app.request_id', true), '');
  v_item_id text := nullif(current_setting('app.item_id', true), '');
  v_work_id text := nullif(current_setting('app.work_id', true), '');
  secret_keys text[] := ARRAY['password_hash', 'token_hash'];
  technical_keys text[] := ARRAY['updated_at', 'row_version', 'last_seen_at', 'last_used_at'];
  old_row jsonb;
  new_row jsonb;
  subject jsonb;
  before_doc jsonb;
  after_doc jsonb;
  key_col text;
BEGIN
  IF v_actor_type IS NULL OR v_actor_label IS NULL OR v_action IS NULL OR v_request_id IS NULL
     OR (v_actor_id IS NULL AND v_actor_type <> 'system') THEN
    RAISE EXCEPTION '% on % without journal context', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'CO001',
            HINT = 'SET LOCAL app.actor_type, app.actor_id, app.actor_label, app.action, app.request_id';
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    old_row := to_jsonb(OLD) - secret_keys;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_row := to_jsonb(NEW) - secret_keys;
  END IF;
  subject := coalesce(new_row, old_row);

  IF TG_OP = 'INSERT' THEN
    after_doc := new_row;
  ELSIF TG_OP = 'DELETE' THEN
    before_doc := old_row;
  ELSE
    SELECT jsonb_object_agg(n.key, o.value), jsonb_object_agg(n.key, n.value)
      INTO before_doc, after_doc
      FROM jsonb_each(new_row) AS n
      JOIN jsonb_each(old_row) AS o ON o.key = n.key
     WHERE n.value IS DISTINCT FROM o.value
       AND NOT n.key = ANY (technical_keys);
    IF before_doc IS NULL THEN
      RETURN NULL;
    END IF;
    FOREACH key_col IN ARRAY TG_ARGV LOOP
      before_doc := before_doc || jsonb_build_object(key_col, old_row -> key_col);
      after_doc := after_doc || jsonb_build_object(key_col, new_row -> key_col);
    END LOOP;
  END IF;

  INSERT INTO action_log (
    model_id, actor_type, actor_id, actor_label, action, entry_kind, item_id, request_id,
    work_id, subject_kind, subject_id, subject_label, before, after
  ) VALUES (
    CASE WHEN TG_TABLE_NAME = 'models' THEN subject ->> 'id' ELSE subject ->> 'model_id' END::uuid,
    v_actor_type,
    v_actor_id::uuid,
    v_actor_label,
    v_action,
    'change',
    v_item_id::uuid,
    v_request_id,
    v_work_id::uuid,
    TG_TABLE_NAME,
    (subject ->> 'id')::uuid,
    coalesce(subject ->> 'code', subject ->> 'key', subject ->> 'login', subject ->> 'type',
             subject ->> 'id'),
    before_doc,
    after_doc
  );
  RETURN NULL;
END
$$;

ALTER FUNCTION public.log_row_change() OWNER TO contentops_migrate;

CREATE FUNCTION public.posting_plan_row_second_person() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  page_platform text;
  flag boolean;
BEGIN
  IF NEW.item_id IS NULL OR NEW.cancelled_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.item_id IS NOT DISTINCT FROM OLD.item_id
     AND NEW.manifest_id IS NOT DISTINCT FROM OLD.manifest_id
     AND NEW.account_id = OLD.account_id THEN
    RETURN NEW;
  END IF;
  SELECT platform INTO page_platform FROM accounts
   WHERE model_id = NEW.model_id AND id = NEW.account_id;
  IF page_platform IS DISTINCT FROM 'onlyfans' THEN
    RETURN NEW;
  END IF;
  SELECT has_second_person INTO flag FROM content_items
   WHERE model_id = NEW.model_id AND id = NEW.item_id
     FOR SHARE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF flag IS NULL THEN
    RAISE EXCEPTION 'item %: second person not checked, OnlyFans waits for the answer', NEW.item_id
      USING ERRCODE = 'CO007', DETAIL = 'unchecked';
  ELSIF flag THEN
    RAISE EXCEPTION 'item %: second person in frame never goes to OnlyFans', NEW.item_id
      USING ERRCODE = 'CO007', DETAIL = 'second_person';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.posting_plan_row_second_person() OWNER TO contentops_migrate;

CREATE FUNCTION public.posting_plan_row_slot() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  expected timestamptz;
  release_account uuid;
  kind text;
BEGIN
  IF NEW.slot_tz IS NULL THEN
    SELECT timezone INTO NEW.slot_tz FROM models WHERE id = NEW.model_id;
  END IF;
  expected := (NEW.slot_date + coalesce(NEW.slot_time, time '00:00')) AT TIME ZONE NEW.slot_tz;
  IF NEW.slot_at IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.slot_at IS NOT DISTINCT FROM OLD.slot_at) THEN
    NEW.slot_at := expected;
  ELSIF NEW.slot_at <> expected THEN
    RAISE EXCEPTION 'plan row %: slot_at % is not % % in %',
      NEW.id, NEW.slot_at, NEW.slot_date, NEW.slot_time, NEW.slot_tz
      USING ERRCODE = 'CO005';
  END IF;
  IF NEW.release_id IS NOT NULL THEN
    SELECT account_id INTO release_account FROM ppv_releases
     WHERE model_id = NEW.model_id AND id = NEW.release_id;
    -- An unknown release is left to the FK.
    IF FOUND AND release_account <> NEW.account_id THEN
      RAISE EXCEPTION 'plan row %: the release % belongs to another page', NEW.id, NEW.release_id
        USING ERRCODE = 'CO005';
    END IF;
    SELECT s.kind INTO kind FROM surfaces s
     WHERE s.model_id = NEW.model_id AND s.account_id = NEW.account_id AND s.id = NEW.surface_id;
    IF FOUND AND kind IS DISTINCT FROM NEW.release_surface_kind THEN
      RAISE EXCEPTION 'plan row %: release surface % is not the row''s %',
        NEW.id, NEW.release_surface_kind, kind
        USING ERRCODE = 'CO005';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.posting_plan_row_slot() OWNER TO contentops_migrate;

CREATE FUNCTION public.promo_delivery_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (OLD.state = 'prepared' AND NEW.state = 'preparing')
     OR (OLD.state = 'preparing' AND NEW.state = 'sent') THEN
    RAISE EXCEPTION 'promo handoff % cannot go % → %', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'CO005';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.promo_delivery_transition() OWNER TO contentops_migrate;

CREATE FUNCTION public.public_item_id(item_type text, item_number integer) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN ((item_type || '-'::text) || lpad((item_number)::text, GREATEST(CASE WHEN (item_type = ANY (ARRAY['FYP'::text, 'RAW'::text])) THEN 4 ELSE 3 END, length((item_number)::text)), '0'::text));

ALTER FUNCTION public.public_item_id(item_type text, item_number integer) OWNER TO contentops_migrate;

CREATE FUNCTION public.set_once() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

ALTER FUNCTION public.set_once() OWNER TO contentops_migrate;

CREATE FUNCTION public.storage_operation_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.state IN ('committed', 'failed', 'cancelled') AND NEW.state <> OLD.state
     OR NEW.state = 'cancelled' AND OLD.state NOT IN ('intent', 'cancelled') THEN
    RAISE EXCEPTION 'storage operation %: % → % is not allowed', OLD.id, OLD.state, NEW.state
      USING ERRCODE = 'CO005';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.storage_operation_transition() OWNER TO contentops_migrate;

CREATE TABLE public.accounts (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    code text NOT NULL,
    platform text NOT NULL,
    title text NOT NULL,
    handle text NOT NULL,
    "position" integer NOT NULL,
    hub_page_ref text,
    week_norm jsonb,
    default_assignee_id uuid,
    default_uniq_level text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT accounts_code_format CHECK ((code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text)),
    CONSTRAINT accounts_default_uniq_level_check CHECK ((default_uniq_level = ANY (ARRAY['soft'::text, 'trim'::text, 'mirror'::text]))),
    CONSTRAINT accounts_platform_check CHECK ((platform = ANY (ARRAY['fansly'::text, 'onlyfans'::text]))),
    CONSTRAINT accounts_week_norm_object CHECK (((week_norm IS NULL) OR (jsonb_typeof(week_norm) = 'object'::text)))
);

ALTER TABLE public.accounts OWNER TO contentops_migrate;

CREATE TABLE public.action_log (
    id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    model_id uuid,
    actor_type text NOT NULL,
    actor_id uuid,
    actor_label text NOT NULL,
    action text NOT NULL,
    entry_kind text NOT NULL,
    item_id uuid,
    request_id text,
    work_id uuid,
    subject_kind text NOT NULL,
    subject_id uuid,
    subject_label text NOT NULL,
    before jsonb,
    after jsonb,
    result text DEFAULT 'ok'::text NOT NULL,
    payload_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT action_log_actor_id CHECK (((actor_id IS NOT NULL) OR (actor_type = 'system'::text))),
    CONSTRAINT action_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['human'::text, 'agent'::text, 'system'::text]))),
    CONSTRAINT action_log_entry_kind_check CHECK ((entry_kind = ANY (ARRAY['action'::text, 'change'::text]))),
    CONSTRAINT action_log_no_secrets CHECK (((NOT public.jsonb_has_secret(before)) AND (NOT public.jsonb_has_secret(after)))),
    CONSTRAINT action_log_result_check CHECK ((result = ANY (ARRAY['ok'::text, 'denied'::text, 'error'::text])))
);

ALTER TABLE public.action_log OWNER TO contentops_migrate;

ALTER TABLE public.action_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.action_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.annotation_fields (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    item_id uuid,
    version_id uuid,
    group_id uuid,
    draft_id uuid,
    field text NOT NULL,
    value_version bigint DEFAULT 0 NOT NULL,
    confirmed_value_version bigint,
    confirmed_at timestamp with time zone,
    confirmed_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT annotation_fields_confirmed CHECK ((((confirmed_at IS NULL) = (confirmed_value_version IS NULL)) AND ((confirmed_value_version IS NULL) OR (confirmed_value_version <= value_version)))),
    CONSTRAINT annotation_fields_field_check CHECK ((field = ANY (ARRAY['title'::text, 'title_en'::text, 'description'::text, 'tags'::text, 'chronology'::text, 'purpose'::text, 'second_person'::text]))),
    CONSTRAINT annotation_fields_one_target CHECK ((num_nonnulls(item_id, version_id, group_id, draft_id) = 1)),
    CONSTRAINT annotation_fields_value_version_check CHECK ((value_version >= 0))
);

ALTER TABLE public.annotation_fields OWNER TO contentops_migrate;

CREATE TABLE public.api_tokens (
    id uuid DEFAULT uuidv7() NOT NULL,
    principal_id uuid NOT NULL,
    name text NOT NULL,
    token_hash bytea NOT NULL,
    token_prefix text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    CONSTRAINT api_tokens_token_hash_sha256 CHECK ((octet_length(token_hash) = 32))
);

ALTER TABLE public.api_tokens OWNER TO contentops_migrate;

CREATE TABLE public.asset_manifests (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    purpose text NOT NULL,
    origin_item_id uuid,
    entry_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT asset_manifests_entry_count_check CHECK ((entry_count > 0)),
    CONSTRAINT asset_manifests_purpose_check CHECK ((purpose = ANY (ARRAY['plan'::text, 'download'::text, 'delivery'::text, 'submission'::text])))
);

ALTER TABLE public.asset_manifests OWNER TO contentops_migrate;

CREATE TABLE public.blob_phashes (
    sha256 bytea NOT NULL,
    algorithm text NOT NULL,
    algo_version text NOT NULL,
    normalization text NOT NULL,
    phash bit(64) NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT blob_phashes_sha256_check CHECK ((octet_length(sha256) = 32))
);

ALTER TABLE public.blob_phashes OWNER TO contentops_migrate;

CREATE TABLE public.blob_probes (
    sha256 bytea NOT NULL,
    kind text NOT NULL,
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
    shot_at timestamp with time zone,
    shot_at_local timestamp without time zone,
    shot_tz text,
    camera jsonb,
    raw jsonb,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT blob_probes_kind_check CHECK ((kind = ANY (ARRAY['ffprobe'::text, 'exif'::text]))),
    CONSTRAINT blob_probes_sha256_check CHECK ((octet_length(sha256) = 32))
);

ALTER TABLE public.blob_probes OWNER TO contentops_migrate;

CREATE TABLE public.blobs (
    sha256 bytea NOT NULL,
    byte_size bigint NOT NULL,
    mime text NOT NULL,
    ext text NOT NULL,
    media_kind text NOT NULL,
    storage_key text NOT NULL,
    state text DEFAULT 'present'::text NOT NULL,
    registered_at timestamp with time zone DEFAULT now() NOT NULL,
    purged_at timestamp with time zone,
    verified_at timestamp with time zone,
    CONSTRAINT blobs_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT blobs_ext_format CHECK ((ext ~ '^[a-z0-9]{1,10}$'::text)),
    CONSTRAINT blobs_media_kind_check CHECK ((media_kind = ANY (ARRAY['video'::text, 'image'::text]))),
    CONSTRAINT blobs_purged_at CHECK (((state <> 'purged'::text) OR (purged_at IS NOT NULL))),
    CONSTRAINT blobs_sha256_check CHECK ((octet_length(sha256) = 32)),
    CONSTRAINT blobs_state_check CHECK ((state = ANY (ARRAY['present'::text, 'purged'::text, 'missing'::text, 'corrupt'::text])))
);

ALTER TABLE public.blobs OWNER TO contentops_migrate;

CREATE TABLE public.custom_orders (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid,
    tg_chat text NOT NULL,
    tg_topic bigint,
    tg_message_id bigint NOT NULL,
    card_author text NOT NULL,
    card_at timestamp with time zone NOT NULL,
    buyer_name text,
    brief text NOT NULL,
    ordered_duration_raw text,
    duration_min_s integer,
    duration_max_s integer,
    expects_video boolean NOT NULL,
    expects_photos boolean NOT NULL,
    photo_count integer,
    due_at timestamp with time zone,
    status text DEFAULT 'open'::text NOT NULL,
    name_in_media text DEFAULT 'unknown'::text NOT NULL,
    video_completed_at timestamp with time zone,
    video_completed_by uuid,
    photos_completed_at timestamp with time zone,
    photos_completed_by uuid,
    closed_at timestamp with time zone,
    closed_by uuid,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    cancel_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT custom_orders_cancelled CHECK (((status = 'cancelled'::text) = ((cancelled_at IS NOT NULL) AND (cancel_reason IS NOT NULL)))),
    CONSTRAINT custom_orders_closed CHECK (((status = 'closed'::text) = (closed_at IS NOT NULL))),
    CONSTRAINT custom_orders_duration CHECK ((duration_max_s >= COALESCE(duration_min_s, 0))),
    CONSTRAINT custom_orders_duration_min_s_check CHECK ((duration_min_s >= 0)),
    CONSTRAINT custom_orders_name_in_media_check CHECK ((name_in_media = ANY (ARRAY['yes'::text, 'no'::text, 'unknown'::text]))),
    CONSTRAINT custom_orders_parts CHECK ((expects_video OR expects_photos)),
    CONSTRAINT custom_orders_photo_count CHECK (((photo_count IS NULL) OR ((photo_count > 0) AND expects_photos))),
    CONSTRAINT custom_orders_photos_mark CHECK ((((photos_completed_at IS NULL) OR expects_photos) AND ((photos_completed_by IS NULL) OR (photos_completed_at IS NOT NULL)))),
    CONSTRAINT custom_orders_status_check CHECK ((status = ANY (ARRAY['open'::text, 'delivered'::text, 'closed'::text, 'cancelled'::text]))),
    CONSTRAINT custom_orders_video_mark CHECK ((((video_completed_at IS NULL) OR expects_video) AND ((video_completed_by IS NULL) OR (video_completed_at IS NOT NULL))))
);

ALTER TABLE public.custom_orders OWNER TO contentops_migrate;

CREATE TABLE public.item_tags (
    model_id uuid NOT NULL,
    item_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    source text NOT NULL,
    group_at_import text,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    added_by uuid,
    CONSTRAINT item_tags_group_at_import_check CHECK ((group_at_import = ANY (ARRAY['action'::text, 'attribute'::text, 'mood'::text]))),
    CONSTRAINT item_tags_source_check CHECK ((source = ANY (ARRAY['ai'::text, 'human'::text, 'import'::text])))
);

ALTER TABLE public.item_tags OWNER TO contentops_migrate;

CREATE TABLE public.promo_channels (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT promo_channels_code_format CHECK ((code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))
);

ALTER TABLE public.promo_channels OWNER TO contentops_migrate;

CREATE TABLE public.provenance (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    relation text NOT NULL,
    child_item_id uuid,
    child_version_id uuid,
    parent_item_id uuid,
    parent_version_id uuid,
    params jsonb,
    basis text,
    work_id uuid,
    voided_by_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT provenance_not_self CHECK (((NOT (child_item_id = parent_item_id)) AND (NOT (child_version_id = parent_version_id)))),
    CONSTRAINT provenance_one_child CHECK ((num_nonnulls(child_item_id, child_version_id) = 1)),
    CONSTRAINT provenance_one_parent CHECK ((num_nonnulls(parent_item_id, parent_version_id) = 1)),
    CONSTRAINT provenance_relation_check CHECK ((relation = ANY (ARRAY['montage_from'::text, 'uniq_from'::text, 'teaser_from'::text, 'frame_from'::text, 'processed_from'::text, 'ppv_from_custom'::text, 'extracted_from'::text, 'remaster_from'::text, 'split_from'::text, 'merged_from'::text, 'reencoded_from'::text])))
);

ALTER TABLE public.provenance OWNER TO contentops_migrate;

CREATE TABLE public.rendition_generations (
    id uuid DEFAULT uuidv7() NOT NULL,
    master_sha256 bytea,
    kind text NOT NULL,
    recipe_digest text NOT NULL,
    meta_stripped boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    input_kind text NOT NULL,
    input_sha256 bytea NOT NULL,
    state text DEFAULT 'building'::text NOT NULL,
    work_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ready_at timestamp with time zone,
    bound_at timestamp with time zone,
    CONSTRAINT rendition_generations_bound CHECK (((bound_at IS NULL) OR (master_sha256 IS NOT NULL))),
    CONSTRAINT rendition_generations_input_kind_check CHECK ((input_kind = ANY (ARRAY['source'::text, 'master'::text]))),
    CONSTRAINT rendition_generations_input_sha256_check CHECK ((octet_length(input_sha256) = 32)),
    CONSTRAINT rendition_generations_kind_check CHECK ((kind = ANY (ARRAY['preview'::text, 'poster'::text, 'thumb320'::text, 'thumb640'::text, 'preview2048'::text, 'frames'::text, 'platform'::text]))),
    CONSTRAINT rendition_generations_master_input CHECK (((input_kind = 'source'::text) OR (master_sha256 = input_sha256))),
    CONSTRAINT rendition_generations_master_sha256_check CHECK ((octet_length(master_sha256) = 32)),
    CONSTRAINT rendition_generations_ready_at CHECK (((state <> 'ready'::text) OR (ready_at IS NOT NULL))),
    CONSTRAINT rendition_generations_state_check CHECK ((state = ANY (ARRAY['building'::text, 'ready'::text, 'failed'::text, 'evicted'::text])))
);

ALTER TABLE public.rendition_generations OWNER TO contentops_migrate;

CREATE TABLE public.source_revisions (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    source_object_id uuid NOT NULL,
    sequence_no integer NOT NULL,
    md5 bytea,
    remote_sha256 bytea,
    content_hash bytea,
    remote_rev text,
    byte_size bigint NOT NULL,
    remote_created_at timestamp with time zone,
    remote_modified_at timestamp with time zone,
    remote_shot_at timestamp with time zone,
    media_type text,
    crc32 bytea,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    scan_work_id uuid,
    previous_id uuid,
    source_sha256 bytea,
    verified_at timestamp with time zone,
    verified_route text,
    frozen_by_work_id uuid,
    frozen_path text,
    CONSTRAINT source_revisions_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT source_revisions_content_hash_check CHECK ((octet_length(content_hash) = 32)),
    CONSTRAINT source_revisions_crc32_check CHECK ((octet_length(crc32) = 4)),
    CONSTRAINT source_revisions_frozen CHECK (((frozen_by_work_id IS NULL) = (frozen_path IS NULL))),
    CONSTRAINT source_revisions_md5_check CHECK ((octet_length(md5) = 16)),
    CONSTRAINT source_revisions_remote_sha256_check CHECK ((octet_length(remote_sha256) = 32)),
    CONSTRAINT source_revisions_sequence_no_check CHECK ((sequence_no >= 1)),
    CONSTRAINT source_revisions_source_sha256_check CHECK ((octet_length(source_sha256) = 32)),
    CONSTRAINT source_revisions_verified CHECK ((((source_sha256 IS NULL) = (verified_at IS NULL)) AND ((verified_at IS NULL) = (verified_route IS NULL)))),
    CONSTRAINT source_revisions_verified_route_check CHECK ((verified_route = ANY (ARRAY['download'::text, 'local_copy'::text, 'upload'::text])))
);

ALTER TABLE public.source_revisions OWNER TO contentops_migrate;

CREATE TABLE public.tags (
    id uuid DEFAULT uuidv7() NOT NULL,
    model_id uuid,
    slug text NOT NULL,
    label_ru text NOT NULL,
    tag_group text,
    merged_into_tag_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT tags_tag_group_check CHECK ((tag_group = ANY (ARRAY['action'::text, 'attribute'::text, 'mood'::text])))
);

ALTER TABLE public.tags OWNER TO contentops_migrate;

CREATE VIEW public.catalog_index WITH (security_invoker='true') AS
 SELECT i.model_id,
    i.id AS item_id,
    public.public_item_id(i.type, i.number) AS public_id,
    i.type,
    i.number,
    i.title,
    i.title_en,
    COALESCE(tg.slugs, '{}'::text[]) AS tags,
        CASE
            WHEN ((af.confirmed > 0) AND (af.confirmed = af.total)) THEN 'confirmed'::text
            WHEN (af.confirmed > 0) THEN 'partial'::text
            ELSE 'draft'::text
        END AS markup_state,
    cv.version_id AS cover_version_id,
    cv.width AS cover_width,
    cv.height AS cover_height,
    cv.thumb320_generation_id AS cover_thumb320_generation_id,
    cv.thumb640_generation_id AS cover_thumb640_generation_id,
    m.duration_ms,
    m.photo_count,
    m.video_count,
    m.version_count,
    COALESCE(m.has_teaser, false) AS has_teaser,
    m.size_bytes,
    COALESCE(arrival.arrived_at, i.created_at) AS arrived_at,
    i.shot_on,
    i.ppv_kind,
    i.raw_purpose,
    ppv.public_id AS ppv_made_as,
    COALESCE(cd.name_in_media, i.name_in_media) AS name_in_media,
    i.has_second_person,
        CASE
            WHEN (i.type = 'SET'::text) THEN COALESCE(m.selected_count, 0)
            ELSE NULL::integer
        END AS selected_count,
        CASE
            WHEN (i.type = 'SET'::text) THEN COALESCE(m.processed_count, 0)
            ELSE NULL::integer
        END AS processed_count,
        CASE
            WHEN (i.type = 'LIFE'::text) THEN COALESCE(m.life_unassigned, 0)
            ELSE NULL::integer
        END AS life_unassigned,
        CASE
            WHEN (i.type = 'LIFE'::text) THEN COALESCE(m.life_chat_count, 0)
            ELSE NULL::integer
        END AS life_chat_count,
        CASE
            WHEN (i.type = 'LIFE'::text) THEN COALESCE(m.life_feed_count, 0)
            ELSE NULL::integer
        END AS life_feed_count,
    ((i.type = 'CUS'::text) AND (COALESCE(m.video_count, 0) = 0) AND (COALESCE(m.photo_count, 0) > 0)) AS photo_custom,
    COALESCE(al.aliases, '{}'::text[]) AS aliases,
    pc.code AS promo_channel_code,
    i.created_at,
    i.updated_at,
    cd.order_id,
    cd.delivered_at
   FROM (((((((((public.content_items i
     LEFT JOIN public.promo_channels pc ON (((pc.model_id = i.model_id) AND (pc.id = i.promo_channel_id))))
     LEFT JOIN LATERAL ( SELECT array_agg(DISTINCT COALESCE(merged.slug, t.slug) ORDER BY COALESCE(merged.slug, t.slug)) AS slugs
           FROM ((public.item_tags it
             JOIN public.tags t ON ((t.id = it.tag_id)))
             LEFT JOIN public.tags merged ON ((merged.id = t.merged_into_tag_id)))
          WHERE ((it.model_id = i.model_id) AND (it.item_id = i.id))) tg ON (true))
     LEFT JOIN LATERAL ( SELECT count(*) AS total,
            count(*) FILTER (WHERE (f.confirmed_value_version = f.value_version)) AS confirmed
           FROM public.annotation_fields f
          WHERE ((f.model_id = i.model_id) AND ((f.item_id = i.id) OR (f.version_id IN ( SELECT a.current_version_id
                   FROM (public.item_memberships im
                     JOIN public.assets a ON (((a.model_id = im.model_id) AND (a.id = im.asset_id))))
                  WHERE ((im.model_id = i.model_id) AND (im.item_id = i.id) AND (im.kind = 'owned'::text) AND (im.removed_at IS NULL))))))) af ON (true))
     LEFT JOIN LATERAL ( SELECT v.id AS version_id,
            v.width,
            v.height,
            ( SELECT g.id
                   FROM public.rendition_generations g
                  WHERE ((g.master_sha256 = v.master_sha256) AND (g.kind = 'thumb320'::text) AND g.is_active AND (g.state = 'ready'::text) AND (NOT g.meta_stripped))
                  ORDER BY g.ready_at DESC
                 LIMIT 1) AS thumb320_generation_id,
            ( SELECT g.id
                   FROM public.rendition_generations g
                  WHERE ((g.master_sha256 = v.master_sha256) AND (g.kind = 'thumb640'::text) AND g.is_active AND (g.state = 'ready'::text) AND (NOT g.meta_stripped))
                  ORDER BY g.ready_at DESC
                 LIMIT 1) AS thumb640_generation_id
           FROM ((public.item_memberships im
             JOIN public.assets a ON (((a.model_id = im.model_id) AND (a.id = im.asset_id))))
             JOIN public.asset_versions v ON (((v.model_id = a.model_id) AND (v.id = COALESCE(im.pinned_version_id, a.current_version_id)))))
          WHERE ((im.model_id = i.model_id) AND (im.item_id = i.id) AND ((im.id = i.cover_membership_id) OR ((i.cover_membership_id IS NULL) AND (im.removed_at IS NULL))))
          ORDER BY im.display_position, im.added_at, im.id
         LIMIT 1) cv ON (true))
     LEFT JOIN LATERAL ( SELECT (count(*) FILTER (WHERE ((a.media_kind = 'image'::text) AND (im.variant_no = 0))))::integer AS photo_count,
            (count(*) FILTER (WHERE ((a.media_kind = 'video'::text) AND (im.variant_no = 0))))::integer AS video_count,
            max(v.version_no) FILTER (WHERE (im.kind = 'owned'::text)) AS version_count,
            bool_or(((im.kind = 'owned'::text) AND (im.role = 'teaser'::text))) AS has_teaser,
            COALESCE(max(v.duration_ms) FILTER (WHERE ((im.kind = 'owned'::text) AND (im.role = 'master'::text) AND (im.variant_no = 0))), (sum(v.duration_ms) FILTER (WHERE ((a.media_kind = 'video'::text) AND (im.variant_no = 0))))::bigint) AS duration_ms,
            (sum(b.byte_size))::bigint AS size_bytes,
            (count(*) FILTER (WHERE im.selected))::integer AS selected_count,
            (count(*) FILTER (WHERE (im.role = 'ed'::text)))::integer AS processed_count,
            (count(*) FILTER (WHERE (im.life_use IS NULL)))::integer AS life_unassigned,
            (count(*) FILTER (WHERE (im.life_use = ANY (ARRAY['chats'::text, 'both'::text]))))::integer AS life_chat_count,
            (count(*) FILTER (WHERE (im.life_use = ANY (ARRAY['feed'::text, 'both'::text]))))::integer AS life_feed_count
           FROM (((public.item_memberships im
             JOIN public.assets a ON (((a.model_id = im.model_id) AND (a.id = im.asset_id))))
             JOIN public.asset_versions v ON (((v.model_id = a.model_id) AND (v.id = COALESCE(im.pinned_version_id, a.current_version_id)))))
             JOIN public.blobs b ON ((b.sha256 = v.master_sha256)))
          WHERE ((im.model_id = i.model_id) AND (im.item_id = i.id) AND (im.removed_at IS NULL))) m ON (true))
     LEFT JOIN LATERAL ( SELECT min(COALESCE(r.remote_created_at, r.detected_at)) AS arrived_at
           FROM ((public.item_memberships im
             JOIN public.asset_versions v ON (((v.model_id = im.model_id) AND (v.asset_id = im.asset_id))))
             JOIN public.source_revisions r ON (((r.model_id = v.model_id) AND (r.id = v.source_revision_id))))
          WHERE ((im.model_id = i.model_id) AND (im.item_id = i.id) AND (im.kind = 'owned'::text))) arrival ON (true))
     LEFT JOIN LATERAL ( SELECT public.public_item_id(c.type, c.number) AS public_id
           FROM (public.provenance p
             JOIN public.content_items c ON (((c.model_id = p.model_id) AND (c.id = p.child_item_id))))
          WHERE ((p.model_id = i.model_id) AND (p.parent_item_id = i.id) AND (p.relation = 'ppv_from_custom'::text) AND (p.voided_by_id IS NULL) AND (c.deleted_at IS NULL))
          ORDER BY c.number
         LIMIT 1) ppv ON ((i.type = 'CUS'::text)))
     LEFT JOIN LATERAL ( SELECT array_agg(DISTINCT a.value_raw ORDER BY a.value_raw) AS aliases
           FROM public.aliases a
          WHERE ((a.model_id = i.model_id) AND (a.item_id = i.id) AND (a.kind = ANY (ARRAY['legacy_id'::text, 'merged_id'::text, 'vault_album'::text])))) al ON (true))
     LEFT JOIN LATERAL ( SELECT d.order_id,
            d.delivered_at,
            o.name_in_media
           FROM (public.custom_order_deliveries d
             JOIN public.custom_orders o ON (((o.model_id = d.model_id) AND (o.id = d.order_id))))
          WHERE ((d.model_id = i.model_id) AND (d.item_id = i.id) AND (NOT (EXISTS ( SELECT 1
                   FROM public.custom_order_deliveries r
                  WHERE (r.retracts_id = d.id)))))
          ORDER BY d.delivered_at, d.id
         LIMIT 1) cd ON ((i.type = 'CUS'::text)))
  WHERE (i.deleted_at IS NULL);

ALTER VIEW public.catalog_index OWNER TO contentops_migrate;

CREATE TABLE public.contractors (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    name text NOT NULL,
    contact text,
    channel_id uuid,
    format text DEFAULT 'upload'::text NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT contractors_format_check CHECK ((format = ANY (ARRAY['upload'::text, 'master'::text, 'compat'::text]))),
    CONSTRAINT contractors_name_filled CHECK ((btrim(name) <> ''::text))
);

ALTER TABLE public.contractors OWNER TO contentops_migrate;

CREATE TABLE public.custom_order_messages (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    order_id uuid NOT NULL,
    tg_ref text NOT NULL,
    kind text NOT NULL,
    message_at timestamp with time zone NOT NULL,
    author text NOT NULL,
    excerpt text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_by uuid,
    CONSTRAINT custom_order_messages_kind_check CHECK ((kind = ANY (ARRAY['card'::text, 'repost'::text, 'delivery'::text, 'revision'::text, 'confirmation'::text, 'note'::text])))
);

ALTER TABLE public.custom_order_messages OWNER TO contentops_migrate;

CREATE TABLE public.custom_order_revisions (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    order_id uuid NOT NULL,
    requirement text NOT NULL,
    request_tg_ref text NOT NULL,
    request_ordinal integer DEFAULT 1 NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    done boolean DEFAULT false NOT NULL,
    done_basis text,
    fixed_delivery_id uuid,
    done_at timestamp with time zone,
    done_by uuid,
    reopened_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT custom_order_revisions_done_at CHECK ((done = (done_at IS NOT NULL))),
    CONSTRAINT custom_order_revisions_done_basis CHECK (((NOT done) OR (done_basis IS NOT NULL))),
    CONSTRAINT custom_order_revisions_request_ordinal_check CHECK ((request_ordinal >= 1))
);

ALTER TABLE public.custom_order_revisions OWNER TO contentops_migrate;

CREATE TABLE public.download_receipt_entries (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    receipt_id uuid NOT NULL,
    "position" integer NOT NULL,
    asset_id uuid NOT NULL,
    asset_version_id uuid NOT NULL,
    rendition_artifact_id uuid,
    issued_master boolean DEFAULT false NOT NULL,
    export_key text,
    file_name text NOT NULL,
    file_name_norm text GENERATED ALWAYS AS (lower(NORMALIZE(file_name, NFC))) STORED NOT NULL,
    output_sha256 bytea NOT NULL,
    byte_size bigint NOT NULL,
    duration_ms bigint,
    width integer,
    height integer,
    CONSTRAINT download_receipt_entries_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT download_receipt_entries_one_file CHECK (((num_nonnulls(rendition_artifact_id, export_key) + (issued_master)::integer) = 1)),
    CONSTRAINT download_receipt_entries_output_sha256_check CHECK ((octet_length(output_sha256) = 32)),
    CONSTRAINT download_receipt_entries_position_check CHECK (("position" >= 1))
);

ALTER TABLE public.download_receipt_entries OWNER TO contentops_migrate;

CREATE TABLE public.download_receipts (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    principal_id uuid NOT NULL,
    kind text NOT NULL,
    manifest_id uuid NOT NULL,
    account_code_snapshot text,
    slot_date_snapshot date,
    meta_stripped boolean NOT NULL,
    zip_key text,
    entry_count integer NOT NULL,
    corrects_id uuid,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    plan_row_id uuid,
    CONSTRAINT download_receipts_entry_count_check CHECK ((entry_count > 0)),
    CONSTRAINT download_receipts_kind_check CHECK ((kind = ANY (ARRAY['master'::text, 'platform'::text, 'edit'::text, 'promo'::text])))
);

ALTER TABLE public.download_receipts OWNER TO contentops_migrate;

CREATE TABLE public.hub_observations (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    dataset text NOT NULL,
    external_key text NOT NULL,
    sequence_no integer NOT NULL,
    row_updated_at timestamp with time zone,
    semantic_hash bytea NOT NULL,
    payload jsonb NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    run_id uuid NOT NULL,
    run_attempt integer NOT NULL,
    previous_id uuid,
    CONSTRAINT hub_observations_dataset_check CHECK ((dataset = ANY (ARRAY['posts'::text, 'post_attachments'::text, 'raw_media'::text, 'vault_media'::text, 'creator_stats_media_daily'::text, 'creator_stats_media_likes'::text]))),
    CONSTRAINT hub_observations_external_key_filled CHECK ((external_key <> ''::text)),
    CONSTRAINT hub_observations_not_self CHECK ((previous_id <> id)),
    CONSTRAINT hub_observations_payload_object CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT hub_observations_previous CHECK (((sequence_no = 1) = (previous_id IS NULL))),
    CONSTRAINT hub_observations_run_attempt_check CHECK ((run_attempt >= 1)),
    CONSTRAINT hub_observations_semantic_hash_sha256 CHECK ((octet_length(semantic_hash) = 32)),
    CONSTRAINT hub_observations_sequence_no_check CHECK ((sequence_no >= 1))
);

ALTER TABLE public.hub_observations OWNER TO contentops_migrate;

CREATE TABLE public.hub_post_attachments (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    post_id uuid NOT NULL,
    hub_key text NOT NULL,
    current_observation_id uuid NOT NULL,
    attachment_index integer,
    member_index integer,
    "position" integer,
    role text NOT NULL,
    content_type integer,
    content_ref text,
    bundle_ref text,
    media_offer_ref text,
    preview_ref text,
    media_ref text,
    link_state text NOT NULL,
    filename text,
    mime text,
    duration_ms integer,
    orig_width integer,
    orig_height integer,
    matched_asset_id uuid,
    matched_version_id uuid,
    receipt_entry_id uuid,
    match_strength text DEFAULT 'none'::text NOT NULL,
    matched_at timestamp with time zone,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hub_post_attachments_link_state_check CHECK ((link_state = ANY (ARRAY['resolved'::text, 'attachment_ref_missing'::text, 'media_ref_missing'::text, 'bundle_members_missing'::text, 'preview_unresolved'::text, 'file_metadata_missing'::text, 'non_media_attachment'::text]))),
    CONSTRAINT hub_post_attachments_match_strength_check CHECK ((match_strength = ANY (ARRAY['none'::text, 'candidate'::text, 'exact'::text]))),
    CONSTRAINT hub_post_attachments_matched CHECK ((((match_strength = 'none'::text) = (matched_version_id IS NULL)) AND ((matched_at IS NULL) = (matched_version_id IS NULL)))),
    CONSTRAINT hub_post_attachments_matched_version CHECK (((matched_asset_id IS NULL) = (matched_version_id IS NULL))),
    CONSTRAINT hub_post_attachments_receipt_version CHECK (((receipt_entry_id IS NULL) OR (matched_version_id IS NOT NULL))),
    CONSTRAINT hub_post_attachments_role_check CHECK ((role = ANY (ARRAY['main'::text, 'offer_preview'::text, 'bundle_preview'::text])))
);

ALTER TABLE public.hub_post_attachments OWNER TO contentops_migrate;

CREATE TABLE public.hub_posts (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    post_ref text NOT NULL,
    current_observation_id uuid NOT NULL,
    published_at timestamp with time zone,
    caption text,
    attachment_count integer,
    fyp_flags integer,
    wall_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    first_observed_at timestamp with time zone,
    last_observed_at timestamp with time zone,
    row_updated_at timestamp with time zone,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hub_posts_wall_refs_array CHECK ((jsonb_typeof(wall_refs) = 'array'::text))
);

ALTER TABLE public.hub_posts OWNER TO contentops_migrate;

CREATE TABLE public.hub_raw_media (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    media_ref text NOT NULL,
    current_observation_id uuid NOT NULL,
    filename text,
    filename_norm text GENERATED ALWAYS AS (lower(regexp_replace(filename, '\.[^./]*$'::text, ''::text))) STORED,
    mime text,
    media_type integer,
    duration_ms integer,
    out_width integer,
    out_height integer,
    orig_width integer,
    orig_height integer,
    fps_milli integer,
    created_at_platform timestamp with time zone,
    origin text,
    first_observed_at timestamp with time zone,
    row_updated_at timestamp with time zone,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.hub_raw_media OWNER TO contentops_migrate;

CREATE TABLE public.hub_sync_state (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    dataset text NOT NULL,
    scope text DEFAULT 'page'::text NOT NULL,
    watermark_at timestamp with time zone,
    last_success_at timestamp with time zone,
    last_daily_at timestamp with time zone,
    next_full_at timestamp with time zone,
    rebuilt_at timestamp with time zone,
    hub_succeeded_at timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    available boolean DEFAULT true NOT NULL,
    unavailable_reason text,
    last_error text,
    last_work_id uuid,
    window_from timestamp with time zone,
    window_to timestamp with time zone,
    expected_count integer,
    observed_count integer,
    stop_reason text,
    blockers text[],
    proven_complete_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT hub_sync_state_available CHECK ((available OR (unavailable_reason IS NOT NULL))),
    CONSTRAINT hub_sync_state_consecutive_failures_check CHECK ((consecutive_failures >= 0)),
    CONSTRAINT hub_sync_state_dataset_check CHECK ((dataset = ANY (ARRAY['posts'::text, 'raw_media'::text, 'vault_media'::text, 'creator_stats'::text])))
);

ALTER TABLE public.hub_sync_state OWNER TO contentops_migrate;

CREATE TABLE public.hub_vault_albums (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    album_ref text NOT NULL,
    title text,
    last_full_walk_at timestamp with time zone,
    full_walk_ref text,
    member_count integer,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.hub_vault_albums OWNER TO contentops_migrate;

CREATE TABLE public.hub_vault_media (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
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
    created_at_platform timestamp with time zone,
    membership_at timestamp with time zone,
    missing_since timestamp with time zone,
    first_observed_at timestamp with time zone,
    last_observed_at timestamp with time zone,
    row_updated_at timestamp with time zone,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.hub_vault_media OWNER TO contentops_migrate;

CREATE TABLE public.id_counters (
    model_id uuid NOT NULL,
    type text NOT NULL,
    next_number integer NOT NULL,
    legacy_reserved_at timestamp with time zone,
    legacy_reserved_work_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT id_counters_next_number_check CHECK ((next_number >= 1)),
    CONSTRAINT id_counters_type_check CHECK ((type = ANY (ARRAY['PPV'::text, 'SET'::text, 'SXT'::text, 'CUS'::text, 'FYP'::text, 'LIFE'::text, 'RAW'::text, 'PRM'::text])))
);

ALTER TABLE public.id_counters OWNER TO contentops_migrate;

CREATE TABLE public.idempotency_keys (
    id uuid DEFAULT uuidv7() NOT NULL,
    model_id uuid,
    principal_id uuid NOT NULL,
    operation text NOT NULL,
    key text NOT NULL,
    request_digest bytea NOT NULL,
    state text NOT NULL,
    response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    committed_at timestamp with time zone,
    CONSTRAINT idempotency_keys_no_replay_response CHECK (((state <> 'no_replay'::text) OR (response IS NULL))),
    CONSTRAINT idempotency_keys_no_secrets CHECK ((NOT public.jsonb_has_secret(response))),
    CONSTRAINT idempotency_keys_request_digest_sha256 CHECK ((octet_length(request_digest) = 32)),
    CONSTRAINT idempotency_keys_state_check CHECK ((state = ANY (ARRAY['committed'::text, 'no_replay'::text])))
);

ALTER TABLE public.idempotency_keys OWNER TO contentops_migrate;

CREATE TABLE public.inbox_draft_candidates (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    draft_id uuid NOT NULL,
    kind text NOT NULL,
    order_id uuid,
    item_id uuid,
    version_id uuid,
    score double precision,
    signals jsonb,
    evidence_refs jsonb,
    conflicts_with uuid[],
    chosen boolean DEFAULT false NOT NULL,
    chosen_at timestamp with time zone,
    chosen_by uuid,
    dismissed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inbox_draft_candidates_kind_check CHECK ((kind = ANY (ARRAY['order'::text, 'existing_item'::text, 'exact_duplicate'::text, 'similar_photo'::text, 'legacy_id'::text, 'source_parent'::text, 'content_type'::text])))
);

ALTER TABLE public.inbox_draft_candidates OWNER TO contentops_migrate;

CREATE TABLE public.inbox_groups (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    source_id uuid NOT NULL,
    group_key text NOT NULL,
    "grouping" text NOT NULL,
    folder_object_id uuid,
    evidence jsonb,
    discovered_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    proposed_type text,
    proposed_title text,
    proposed_title_en text,
    proposed_description text,
    proposed_tags jsonb,
    proposed_ppv_kind text,
    proposed_purpose text,
    has_second_person boolean,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    custom_order_id uuid,
    CONSTRAINT inbox_groups_grouping_check CHECK (("grouping" = ANY (ARRAY['folder'::text, 'exif_day'::text, 'upload_cluster'::text, 'single'::text, 'manual'::text]))),
    CONSTRAINT inbox_groups_proposed_ppv_kind_check CHECK ((proposed_ppv_kind = ANY (ARRAY['bundle'::text, 'dm'::text]))),
    CONSTRAINT inbox_groups_proposed_purpose_check CHECK ((proposed_purpose = ANY (ARRAY['fyp'::text, 'ppv'::text, 'mass_dm'::text, 'unknown'::text]))),
    CONSTRAINT inbox_groups_proposed_type_check CHECK ((proposed_type = ANY (ARRAY['PPV'::text, 'SET'::text, 'SXT'::text, 'CUS'::text, 'FYP'::text, 'LIFE'::text, 'RAW'::text, 'PRM'::text])))
);

ALTER TABLE public.inbox_groups OWNER TO contentops_migrate;

CREATE TABLE public.legacy_claims (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    source_object_id uuid NOT NULL,
    source_revision_id uuid,
    parser_version text NOT NULL,
    claim_key text NOT NULL,
    raw_fragment text NOT NULL,
    claim_kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    parse_work_id uuid NOT NULL,
    resolution text DEFAULT 'pending'::text NOT NULL,
    superseded_by_id uuid,
    resolved_item_id uuid,
    resolved_asset_id uuid,
    resolved_version_id uuid,
    resolved_alias_id uuid,
    resolved_evidence_id uuid,
    resolved_order_id uuid,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT legacy_claims_claim_kind_check CHECK ((claim_kind = ANY (ARRAY['number'::text, 'used'::text, 'posted'::text, 'date'::text, 'role'::text, 'registry_row'::text, 'duration'::text, 'title'::text, 'tag'::text, 'origin'::text, 'unknown'::text]))),
    CONSTRAINT legacy_claims_not_self CHECK ((superseded_by_id <> id)),
    CONSTRAINT legacy_claims_resolution_check CHECK ((resolution = ANY (ARRAY['pending'::text, 'resolved'::text, 'ignored'::text]))),
    CONSTRAINT legacy_claims_resolved CHECK (
CASE
    WHEN (resolution = 'resolved'::text) THEN ((num_nonnulls(resolved_item_id, resolved_version_id, resolved_alias_id, resolved_evidence_id, resolved_order_id) = 1) AND (resolved_at IS NOT NULL))
    ELSE (num_nonnulls(resolved_item_id, resolved_version_id, resolved_alias_id, resolved_evidence_id, resolved_order_id, resolved_at, resolved_by) = 0)
END),
    CONSTRAINT legacy_claims_resolved_version CHECK (((resolved_asset_id IS NULL) = (resolved_version_id IS NULL))),
    CONSTRAINT legacy_claims_superseded CHECK (((superseded_by_id IS NULL) OR (resolution = 'ignored'::text)))
);

ALTER TABLE public.legacy_claims OWNER TO contentops_migrate;

CREATE TABLE public.legacy_number_claims (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    type text NOT NULL,
    claimed_number integer NOT NULL,
    source_object_id uuid NOT NULL,
    claim_id uuid NOT NULL,
    registry_claim_id uuid,
    decision text,
    assigned_number integer,
    target_item_id uuid,
    decided_at timestamp with time zone,
    decided_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT legacy_number_claims_assigned_range CHECK (((assigned_number >= 1) AND (assigned_number <= 999999))),
    CONSTRAINT legacy_number_claims_decided CHECK (((decision IS NULL) = (decided_at IS NULL))),
    CONSTRAINT legacy_number_claims_decision_check CHECK ((decision = ANY (ARRAY['keep'::text, 'renumber'::text, 'typo'::text, 'unclear'::text]))),
    CONSTRAINT legacy_number_claims_number_range CHECK (((claimed_number >= 1) AND (claimed_number <= 999999))),
    CONSTRAINT legacy_number_claims_type_check CHECK ((type = ANY (ARRAY['PPV'::text, 'SET'::text, 'SXT'::text, 'CUS'::text, 'FYP'::text, 'LIFE'::text, 'RAW'::text, 'PRM'::text])))
);

ALTER TABLE public.legacy_number_claims OWNER TO contentops_migrate;

CREATE TABLE public.master_checks (
    id uuid DEFAULT uuidv7() NOT NULL,
    source_sha256 bytea NOT NULL,
    master_sha256 bytea,
    recipe_digest text NOT NULL,
    work_id uuid NOT NULL,
    attempt integer NOT NULL,
    decision text,
    verdict text NOT NULL,
    enc_ms bigint,
    verify_ms bigint,
    src_frames bigint,
    dst_frames bigint,
    crf integer,
    report jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT master_checks_attempt_check CHECK ((attempt >= 1)),
    CONSTRAINT master_checks_decision CHECK (((decision IS NOT NULL) OR (verdict = 'unreadable'::text))),
    CONSTRAINT master_checks_decision_check CHECK ((decision = ANY (ARRAY['encode'::text, 'copy'::text, 'skipped_hdr'::text, 'skipped_av1'::text, 'skipped_lowrate'::text, 'skipped_audio'::text]))),
    CONSTRAINT master_checks_master_sha256_check CHECK ((octet_length(master_sha256) = 32)),
    CONSTRAINT master_checks_source_sha256_check CHECK ((octet_length(source_sha256) = 32)),
    CONSTRAINT master_checks_verdict_check CHECK ((verdict = ANY (ARRAY['ok'::text, 'unreadable'::text, 'bigger_than_source'::text, 'timing_drift'::text, 'timing_uncomparable'::text, 'audio_mismatch'::text, 'audio_offset'::text, 'audio_tracks_lost'::text, 'encode_failed'::text, 'frame_mismatch'::text, 'result_decode_errors'::text, 'publish_failed'::text, 'source_decode_errors'::text, 'source_truncated'::text, 'metadata_mismatch'::text])))
);

ALTER TABLE public.master_checks OWNER TO contentops_migrate;

CREATE TABLE public.models (
    id uuid DEFAULT uuidv7() NOT NULL,
    code text NOT NULL,
    title text NOT NULL,
    title_genitive text NOT NULL,
    timezone text DEFAULT 'Europe/Moscow'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT models_code_format CHECK ((code ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'::text)),
    CONSTRAINT models_code_reserved CHECK ((code <> ALL (ARRAY['admin'::text, 'auth'::text])))
);

ALTER TABLE public.models OWNER TO contentops_migrate;

CREATE TABLE public.pipeline_versions (
    version text NOT NULL,
    ffmpeg text NOT NULL,
    svtav1 text NOT NULL,
    libvips text NOT NULL,
    sharp text NOT NULL,
    phash_algo text NOT NULL,
    master_recipe jsonb NOT NULL,
    rendition_recipes jsonb NOT NULL,
    recipe_digests jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    is_current boolean DEFAULT false NOT NULL,
    CONSTRAINT pipeline_versions_current_activated CHECK (((NOT is_current) OR (activated_at IS NOT NULL))),
    CONSTRAINT pipeline_versions_recipe_digests_object CHECK ((jsonb_typeof(recipe_digests) = 'object'::text))
);

ALTER TABLE public.pipeline_versions OWNER TO contentops_migrate;

CREATE TABLE public.placement_assets (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    placement_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    asset_version_id uuid NOT NULL,
    "position" integer NOT NULL,
    match_strength text DEFAULT 'none'::text NOT NULL,
    matched_media_ref text,
    receipt_entry_id uuid,
    bound_at timestamp with time zone DEFAULT now() NOT NULL,
    bound_by uuid,
    CONSTRAINT placement_assets_match_strength_check CHECK ((match_strength = ANY (ARRAY['none'::text, 'candidate'::text, 'exact'::text]))),
    CONSTRAINT placement_assets_position_check CHECK (("position" >= 1))
);

ALTER TABLE public.placement_assets OWNER TO contentops_migrate;

CREATE TABLE public.placement_evidence (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    placement_id uuid NOT NULL,
    source text NOT NULL,
    kind text NOT NULL,
    strength text,
    hub_observation_id uuid,
    external_ref text,
    matched_asset_id uuid,
    matched_version_id uuid,
    legacy_claim_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    event_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_by uuid,
    corrects_id uuid,
    dedup_key text NOT NULL,
    CONSTRAINT placement_evidence_kind_check CHECK ((kind = ANY (ARRAY['observed'::text, 'manual_confirm'::text, 'reused_pair'::text, 'manual_reject'::text, 'legacy_claim'::text, 'outside_catalog'::text, 'retract'::text]))),
    CONSTRAINT placement_evidence_matched_version CHECK (((matched_asset_id IS NULL) = (matched_version_id IS NULL))),
    CONSTRAINT placement_evidence_not_self CHECK ((corrects_id <> id)),
    CONSTRAINT placement_evidence_retract CHECK (((kind <> 'retract'::text) OR (corrects_id IS NOT NULL))),
    CONSTRAINT placement_evidence_source_check CHECK ((source = ANY (ARRAY['hub'::text, 'manual'::text, 'import'::text]))),
    CONSTRAINT placement_evidence_strength_check CHECK ((strength = ANY (ARRAY['claim'::text, 'candidate'::text, 'exact'::text]))),
    CONSTRAINT placement_evidence_triple CHECK (
CASE kind
    WHEN 'observed'::text THEN ((source = 'hub'::text) AND (hub_observation_id IS NOT NULL) AND (strength IS NOT NULL) AND (strength <> 'claim'::text))
    WHEN 'manual_confirm'::text THEN ((source = 'manual'::text) AND (strength IS NOT NULL) AND (strength = 'exact'::text))
    WHEN 'reused_pair'::text THEN ((source = 'manual'::text) AND (strength IS NOT NULL) AND (strength = 'exact'::text))
    WHEN 'legacy_claim'::text THEN ((source = 'import'::text) AND (strength IS NOT NULL) AND (strength = 'claim'::text) AND (legacy_claim_id IS NOT NULL))
    ELSE ((source = 'manual'::text) AND (strength IS NULL))
END)
);

ALTER TABLE public.placement_evidence OWNER TO contentops_migrate;

CREATE TABLE public.placements (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    surface_id uuid NOT NULL,
    occurrence_kind text NOT NULL,
    external_post_ref text,
    external_album_ref text,
    external_media_ref text,
    manual_key text,
    item_id uuid,
    item_type text,
    planned_at timestamp with time zone,
    occurred_at timestamp with time zone,
    event_precision text DEFAULT 'exact'::text NOT NULL,
    occurred_source text,
    surface_source text NOT NULL,
    caption text,
    views bigint,
    likes bigint,
    stats_at timestamp with time zone,
    out_of_catalog boolean DEFAULT false NOT NULL,
    origin text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    row_version bigint DEFAULT 1 NOT NULL,
    plan_row_id uuid,
    CONSTRAINT placements_event_precision_check CHECK ((event_precision = ANY (ARRAY['exact'::text, 'day'::text, 'unknown'::text]))),
    CONSTRAINT placements_item_type CHECK (((item_id IS NULL) = (item_type IS NULL))),
    CONSTRAINT placements_likes_check CHECK ((likes >= 0)),
    CONSTRAINT placements_occurred_source CHECK (((occurred_at IS NULL) OR (occurred_source IS NOT NULL))),
    CONSTRAINT placements_occurred_source_check CHECK ((occurred_source = ANY (ARRAY['hub'::text, 'km'::text, 'import'::text]))),
    CONSTRAINT placements_occurrence_kind_check CHECK ((occurrence_kind = ANY (ARRAY['post'::text, 'vault_member'::text, 'manual'::text]))),
    CONSTRAINT placements_origin_check CHECK ((origin = ANY (ARRAY['plan'::text, 'hub'::text, 'manual'::text, 'import'::text]))),
    CONSTRAINT placements_out_of_catalog CHECK (((NOT out_of_catalog) OR (item_id IS NULL))),
    CONSTRAINT placements_surface_source_check CHECK ((surface_source = ANY (ARRAY['hub'::text, 'km_mark'::text, 'km'::text, 'plan'::text, 'import'::text]))),
    CONSTRAINT placements_time CHECK (((planned_at IS NOT NULL) OR (occurred_at IS NOT NULL) OR (event_precision = 'unknown'::text))),
    CONSTRAINT placements_views_check CHECK ((views >= 0))
);

ALTER TABLE public.placements OWNER TO contentops_migrate;

CREATE TABLE public.platform_texts (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    item_id uuid NOT NULL,
    platform text NOT NULL,
    account_id uuid,
    locale text NOT NULL,
    variant_no integer DEFAULT 1 NOT NULL,
    title text,
    body text,
    value_version bigint DEFAULT 1 NOT NULL,
    confirmed_value_version bigint,
    confirmed_at timestamp with time zone,
    confirmed_by uuid,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT platform_texts_account CHECK (((account_id IS NULL) OR (platform <> 'generic'::text))),
    CONSTRAINT platform_texts_confirmed CHECK ((((confirmed_at IS NULL) = (confirmed_value_version IS NULL)) AND ((confirmed_value_version IS NULL) OR (confirmed_value_version <= value_version)))),
    CONSTRAINT platform_texts_locale_format CHECK ((locale ~ '^[a-z]{2}$'::text)),
    CONSTRAINT platform_texts_platform_check CHECK ((platform = ANY (ARRAY['generic'::text, 'fansly'::text, 'onlyfans'::text]))),
    CONSTRAINT platform_texts_source_check CHECK ((source = ANY (ARRAY['ai'::text, 'human'::text, 'import'::text]))),
    CONSTRAINT platform_texts_value_version_check CHECK ((value_version >= 0)),
    CONSTRAINT platform_texts_variant_no_check CHECK ((variant_no >= 1))
);

ALTER TABLE public.platform_texts OWNER TO contentops_migrate;

CREATE TABLE public.policy_settings (
    id uuid DEFAULT uuidv7() NOT NULL,
    model_id uuid,
    account_id uuid,
    item_type text,
    key text NOT NULL,
    value jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT policy_settings_global_scope CHECK (((model_id IS NOT NULL) OR (account_id IS NULL))),
    CONSTRAINT policy_settings_item_type_check CHECK ((item_type = ANY (ARRAY['PPV'::text, 'SET'::text, 'SXT'::text, 'CUS'::text, 'FYP'::text, 'LIFE'::text, 'RAW'::text, 'PRM'::text]))),
    CONSTRAINT policy_settings_value_not_json_null CHECK (((value IS NULL) OR (jsonb_typeof(value) <> 'null'::text)))
);

ALTER TABLE public.policy_settings OWNER TO contentops_migrate;

CREATE TABLE public.posting_plan_rows (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    item_id uuid,
    account_id uuid NOT NULL,
    surface_id uuid NOT NULL,
    slot_date date NOT NULL,
    slot_time time without time zone,
    slot_tz text NOT NULL,
    slot_at timestamp with time zone NOT NULL,
    assignee_id uuid,
    release_id uuid,
    release_surface_kind text,
    manifest_id uuid,
    marked_manifest_id uuid,
    expected_type text,
    expected_role text,
    input_manifest_id uuid,
    uniq_variant_no integer,
    marked_by uuid,
    marked_at timestamp with time zone,
    mark_kind text,
    stated_occurred_at timestamp with time zone,
    requires_new_upload boolean DEFAULT false NOT NULL,
    caption text,
    tier_refs text[],
    price_mills bigint,
    repost boolean DEFAULT false NOT NULL,
    album_name text,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    cancel_reason text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT posting_plan_rows_cancel CHECK (((cancelled_at IS NOT NULL) OR ((cancelled_by IS NULL) AND (cancel_reason IS NULL)))),
    CONSTRAINT posting_plan_rows_cancel_reason_check CHECK ((cancel_reason = ANY (ARRAY['late'::text, 'replaced'::text, 'paused'::text, 'second_person'::text]))),
    CONSTRAINT posting_plan_rows_expected_role CHECK ((expected_role = 'teaser'::text)),
    CONSTRAINT posting_plan_rows_expected_type_check CHECK ((expected_type = ANY (ARRAY['FYP'::text, 'PPV'::text]))),
    CONSTRAINT posting_plan_rows_inputs CHECK (((input_manifest_id IS NULL) OR (expected_type IS NOT NULL) OR (expected_role IS NOT NULL))),
    CONSTRAINT posting_plan_rows_mark CHECK (
CASE
    WHEN (marked_at IS NULL) THEN (num_nonnulls(marked_by, mark_kind, marked_manifest_id, stated_occurred_at) = 0)
    ELSE (num_nulls(marked_by, mark_kind, marked_manifest_id, manifest_id) = 0)
END),
    CONSTRAINT posting_plan_rows_mark_kind_check CHECK ((mark_kind = ANY (ARRAY['posted'::text, 'scheduled'::text]))),
    CONSTRAINT posting_plan_rows_marked_cancelled CHECK (((marked_at IS NULL) OR (cancelled_at IS NULL))),
    CONSTRAINT posting_plan_rows_object CHECK (((item_id IS NOT NULL) OR (expected_type IS NOT NULL))),
    CONSTRAINT posting_plan_rows_price CHECK ((price_mills >= 0)),
    CONSTRAINT posting_plan_rows_release_item CHECK (((release_id IS NULL) OR (item_id IS NOT NULL))),
    CONSTRAINT posting_plan_rows_release_kind CHECK (((release_id IS NULL) = (release_surface_kind IS NULL))),
    CONSTRAINT posting_plan_rows_release_surface_kind_check CHECK ((release_surface_kind = ANY (ARRAY['wall'::text, 'story'::text, 'vault'::text, 'mass_dm'::text]))),
    CONSTRAINT posting_plan_rows_ships CHECK (((manifest_id IS NOT NULL) OR (expected_type IS NOT NULL) OR (expected_role IS NOT NULL) OR (uniq_variant_no IS NOT NULL))),
    CONSTRAINT posting_plan_rows_uniq_variant CHECK ((uniq_variant_no > 0))
);

ALTER TABLE public.posting_plan_rows OWNER TO contentops_migrate;

CREATE TABLE public.ppv_releases (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    item_id uuid NOT NULL,
    item_type text DEFAULT 'PPV'::text NOT NULL,
    release_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT ppv_releases_cancelled CHECK (((cancelled_by IS NULL) OR (cancelled_at IS NOT NULL))),
    CONSTRAINT ppv_releases_item_type_check CHECK ((item_type = 'PPV'::text))
);

ALTER TABLE public.ppv_releases OWNER TO contentops_migrate;

CREATE TABLE public.principal_grants (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    principal_id uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    granted_by uuid,
    revoked_at timestamp with time zone
);

ALTER TABLE public.principal_grants OWNER TO contentops_migrate;

CREATE TABLE public.principals (
    id uuid DEFAULT uuidv7() NOT NULL,
    kind text NOT NULL,
    login text NOT NULL,
    display_name text NOT NULL,
    gender text,
    role text NOT NULL,
    password_hash text,
    ui_skin text DEFAULT 'blue'::text NOT NULL,
    disabled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT principals_gender_check CHECK ((gender = ANY (ARRAY['f'::text, 'm'::text]))),
    CONSTRAINT principals_gender_of_humans CHECK (((gender IS NOT NULL) OR (kind = 'agent'::text))),
    CONSTRAINT principals_kind_check CHECK ((kind = ANY (ARRAY['human'::text, 'agent'::text]))),
    CONSTRAINT principals_login_format CHECK ((login ~ '^[a-z0-9][a-z0-9._-]*$'::text)),
    CONSTRAINT principals_password_humans_only CHECK (((password_hash IS NULL) OR (kind = 'human'::text))),
    CONSTRAINT principals_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'manager'::text, 'reader'::text]))),
    CONSTRAINT principals_ui_skin_check CHECK ((ui_skin = ANY (ARRAY['blue'::text, 'focus'::text])))
);

ALTER TABLE public.principals OWNER TO contentops_migrate;

CREATE TABLE public.promo_deliveries (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    package_item_id uuid NOT NULL,
    package_item_type text DEFAULT 'PRM'::text NOT NULL,
    channel_id uuid NOT NULL,
    contractor_id uuid NOT NULL,
    format text,
    manifest_id uuid NOT NULL,
    receipt_id uuid,
    state text DEFAULT 'preparing'::text NOT NULL,
    prepared_at timestamp with time zone,
    prepared_by uuid,
    sent_at timestamp with time zone,
    sent_by uuid,
    recipient_note text,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    origin text DEFAULT 'product'::text NOT NULL,
    corrects_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT promo_deliveries_format_check CHECK ((format = ANY (ARRAY['upload'::text, 'master'::text, 'compat'::text]))),
    CONSTRAINT promo_deliveries_not_self CHECK ((corrects_id <> id)),
    CONSTRAINT promo_deliveries_origin_check CHECK ((origin = ANY (ARRAY['product'::text, 'import'::text]))),
    CONSTRAINT promo_deliveries_package_item_type_check CHECK ((package_item_type = 'PRM'::text)),
    CONSTRAINT promo_deliveries_prepared CHECK (
CASE origin
    WHEN 'import'::text THEN (num_nonnulls(format, prepared_at, prepared_by, receipt_id, corrects_id) = 0)
    ELSE ((prepared_at IS NOT NULL) AND (prepared_by IS NOT NULL) AND ((state = 'preparing'::text) = (receipt_id IS NULL)))
END),
    CONSTRAINT promo_deliveries_sent CHECK (
CASE origin
    WHEN 'import'::text THEN ((state = 'sent'::text) AND (sent_at IS NULL) AND (sent_by IS NULL))
    ELSE ((format IS NOT NULL) AND ((state = 'sent'::text) = ((sent_at IS NOT NULL) AND (sent_by IS NOT NULL))))
END),
    CONSTRAINT promo_deliveries_state_check CHECK ((state = ANY (ARRAY['preparing'::text, 'prepared'::text, 'sent'::text])))
);

ALTER TABLE public.promo_deliveries OWNER TO contentops_migrate;

CREATE TABLE public.rendition_artifacts (
    id uuid DEFAULT uuidv7() NOT NULL,
    generation_id uuid NOT NULL,
    name text NOT NULL,
    output_sha256 bytea NOT NULL,
    byte_size bigint NOT NULL,
    mime text NOT NULL,
    width integer,
    height integer,
    duration_ms bigint,
    frame_ms bigint,
    storage_key text NOT NULL,
    state text DEFAULT 'ready'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    CONSTRAINT rendition_artifacts_byte_size_check CHECK ((byte_size >= 0)),
    CONSTRAINT rendition_artifacts_name_format CHECK ((name ~ '^(platform\.mp4|preview\.mp4|poster\.webp|thumb-320\.webp|thumb-640\.webp|preview-2048\.webp|frames/[0-9]{4,6}\.webp)$'::text)),
    CONSTRAINT rendition_artifacts_output_sha256_check CHECK ((octet_length(output_sha256) = 32)),
    CONSTRAINT rendition_artifacts_state_check CHECK ((state = ANY (ARRAY['ready'::text, 'evicted'::text, 'missing'::text])))
);

ALTER TABLE public.rendition_artifacts OWNER TO contentops_migrate;

CREATE TABLE public.review_cases (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    kind text NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    dedup_key text NOT NULL,
    draft_id uuid,
    item_id uuid,
    version_id uuid,
    source_object_id uuid,
    blob_sha256 bytea,
    counterpart_model_id uuid,
    details jsonb,
    resolution jsonb,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT review_cases_blob_sha256_check CHECK ((octet_length(blob_sha256) = 32)),
    CONSTRAINT review_cases_kind_check CHECK ((kind = ANY (ARRAY['cross_model_duplicate'::text, 'legacy_unparsed'::text, 'merge_split'::text, 'unreadable_input'::text, 'smm_folder'::text, 'number_hole'::text]))),
    CONSTRAINT review_cases_resolved CHECK (((state = 'open'::text) = (resolved_at IS NULL))),
    CONSTRAINT review_cases_state_check CHECK ((state = ANY (ARRAY['open'::text, 'resolved'::text, 'dismissed'::text])))
);

ALTER TABLE public.review_cases OWNER TO contentops_migrate;

CREATE TABLE public.schema_migrations (
    version integer NOT NULL,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_by text NOT NULL
);

ALTER TABLE public.schema_migrations OWNER TO contentops_migrate;

CREATE TABLE public.sessions (
    id uuid DEFAULT uuidv7() NOT NULL,
    principal_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone,
    revoked_at timestamp with time zone,
    replaced_by_id uuid,
    CONSTRAINT sessions_token_hash_sha256 CHECK ((octet_length(token_hash) = 32))
);

ALTER TABLE public.sessions OWNER TO contentops_migrate;

CREATE TABLE public.source_objects (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    source_id uuid NOT NULL,
    resource_id text,
    upload_id text,
    current_path text NOT NULL,
    current_name text NOT NULL,
    is_dir boolean DEFAULT false NOT NULL,
    parent_id uuid,
    archive_revision_id uuid,
    archive_entry_no integer,
    current_revision_id uuid,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    gone_since timestamp with time zone,
    CONSTRAINT source_objects_archive_entry_no_check CHECK ((archive_entry_no >= 0)),
    CONSTRAINT source_objects_archive_member CHECK (((archive_revision_id IS NULL) = (archive_entry_no IS NULL)))
);

ALTER TABLE public.source_objects OWNER TO contentops_migrate;

CREATE TABLE public.source_paths (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    source_object_id uuid NOT NULL,
    path_raw text NOT NULL,
    path_nfc text GENERATED ALWAYS AS (NORMALIZE(path_raw, NFC)) STORED NOT NULL,
    name text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.source_paths OWNER TO contentops_migrate;

CREATE TABLE public.sources (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    kind text NOT NULL,
    label text NOT NULL,
    credentials_ref text,
    root_path text,
    read_only boolean DEFAULT true NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT sources_cloud_read_only CHECK (((kind <> ALL (ARRAY['yandex_disk'::text, 'dropbox'::text])) OR read_only)),
    CONSTRAINT sources_cloud_root CHECK (((kind <> ALL (ARRAY['yandex_disk'::text, 'dropbox'::text])) OR ((root_path IS NOT NULL) AND (credentials_ref IS NOT NULL)))),
    CONSTRAINT sources_credentials_ref_format CHECK ((credentials_ref ~ '^[A-Z][A-Z0-9_]*$'::text)),
    CONSTRAINT sources_kind_check CHECK ((kind = ANY (ARRAY['yandex_disk'::text, 'dropbox'::text, 'web_upload'::text, 'legacy_metadata'::text])))
);

ALTER TABLE public.sources OWNER TO contentops_migrate;

CREATE TABLE public.storage_operations (
    id uuid DEFAULT uuidv7() NOT NULL,
    kind text NOT NULL,
    blob_sha256 bytea NOT NULL,
    from_key text,
    to_key text,
    state text DEFAULT 'intent'::text NOT NULL,
    owner text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT storage_operations_blob_sha256_check CHECK ((octet_length(blob_sha256) = 32)),
    CONSTRAINT storage_operations_finished_at CHECK (((state = ANY (ARRAY['committed'::text, 'failed'::text, 'cancelled'::text])) = (finished_at IS NOT NULL))),
    CONSTRAINT storage_operations_kind_check CHECK ((kind = ANY (ARRAY['put'::text, 'purge'::text]))),
    CONSTRAINT storage_operations_state_check CHECK ((state = ANY (ARRAY['intent'::text, 'started'::text, 'fs_done'::text, 'committed'::text, 'failed'::text, 'cancelled'::text])))
);

ALTER TABLE public.storage_operations OWNER TO contentops_migrate;

CREATE TABLE public.surfaces (
    model_id uuid NOT NULL,
    id uuid DEFAULT uuidv7() NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    auto_match boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    row_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT surfaces_auto_match_kind CHECK (((auto_match = false) OR (kind = ANY (ARRAY['wall'::text, 'fyp'::text, 'vault'::text])))),
    CONSTRAINT surfaces_kind_check CHECK ((kind = ANY (ARRAY['wall'::text, 'fyp'::text, 'story'::text, 'vault'::text, 'mass_dm'::text])))
);

ALTER TABLE public.surfaces OWNER TO contentops_migrate;

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_code_key UNIQUE (code);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_hub_page_ref_key UNIQUE (hub_page_ref);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_model_id_code_key UNIQUE (model_id, code);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.action_log
    ADD CONSTRAINT action_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.aliases
    ADD CONSTRAINT aliases_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.aliases
    ADD CONSTRAINT aliases_value UNIQUE NULLS NOT DISTINCT (model_id, kind, value_norm, item_id, asset_id);

ALTER TABLE ONLY public.annotation_fields
    ADD CONSTRAINT annotation_fields_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.annotation_fields
    ADD CONSTRAINT annotation_fields_target UNIQUE NULLS NOT DISTINCT (model_id, item_id, version_id, group_id, draft_id, field);

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.asset_manifest_entries
    ADD CONSTRAINT asset_manifest_entries_model_id_manifest_id_position_key UNIQUE (model_id, manifest_id, "position");

ALTER TABLE ONLY public.asset_manifest_entries
    ADD CONSTRAINT asset_manifest_entries_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.asset_manifests
    ADD CONSTRAINT asset_manifests_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.asset_versions
    ADD CONSTRAINT asset_versions_model_id_asset_id_id_key UNIQUE (model_id, asset_id, id);

ALTER TABLE ONLY public.asset_versions
    ADD CONSTRAINT asset_versions_model_id_asset_id_version_no_key UNIQUE (model_id, asset_id, version_no);

ALTER TABLE ONLY public.asset_versions
    ADD CONSTRAINT asset_versions_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_model_id_id_variant_no_key UNIQUE (model_id, id, variant_no);

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.blob_phashes
    ADD CONSTRAINT blob_phashes_pkey PRIMARY KEY (sha256, algorithm, algo_version, normalization);

ALTER TABLE ONLY public.blob_probes
    ADD CONSTRAINT blob_probes_pkey PRIMARY KEY (sha256, kind, recipe_digest);

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_pkey PRIMARY KEY (sha256);

ALTER TABLE ONLY public.blobs
    ADD CONSTRAINT blobs_storage_key_key UNIQUE (storage_key);

ALTER TABLE ONLY public.chronology_entries
    ADD CONSTRAINT chronology_entries_model_id_asset_version_id_at_ms_key UNIQUE (model_id, asset_version_id, at_ms);

ALTER TABLE ONLY public.chronology_entries
    ADD CONSTRAINT chronology_entries_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_created_from_group UNIQUE (model_id, created_from_group_id);

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_model_id_id_type_key UNIQUE (model_id, id, type);

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_number UNIQUE (model_id, type, number);

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.contractors
    ADD CONSTRAINT contractors_name UNIQUE (model_id, name);

ALTER TABLE ONLY public.contractors
    ADD CONSTRAINT contractors_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.custom_order_deliveries
    ADD CONSTRAINT custom_order_deliveries_manifest UNIQUE (model_id, order_id, manifest_id);

ALTER TABLE ONLY public.custom_order_deliveries
    ADD CONSTRAINT custom_order_deliveries_model_id_order_id_id_key UNIQUE (model_id, order_id, id);

ALTER TABLE ONLY public.custom_order_deliveries
    ADD CONSTRAINT custom_order_deliveries_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.custom_order_deliveries
    ADD CONSTRAINT custom_order_deliveries_retracts_once UNIQUE (retracts_id);

ALTER TABLE ONLY public.custom_order_messages
    ADD CONSTRAINT custom_order_messages_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.custom_order_messages
    ADD CONSTRAINT custom_order_messages_ref UNIQUE (model_id, order_id, tg_ref, kind);

ALTER TABLE ONLY public.custom_order_revisions
    ADD CONSTRAINT custom_order_revisions_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.custom_order_revisions
    ADD CONSTRAINT custom_order_revisions_request UNIQUE (model_id, order_id, request_tg_ref, request_ordinal);

ALTER TABLE ONLY public.custom_orders
    ADD CONSTRAINT custom_orders_card UNIQUE NULLS NOT DISTINCT (model_id, tg_chat, tg_topic, tg_message_id);

ALTER TABLE ONLY public.custom_orders
    ADD CONSTRAINT custom_orders_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.download_receipt_entries
    ADD CONSTRAINT download_receipt_entries_model_id_asset_version_id_id_key UNIQUE (model_id, asset_version_id, id);

ALTER TABLE ONLY public.download_receipt_entries
    ADD CONSTRAINT download_receipt_entries_model_id_receipt_id_position_key UNIQUE (model_id, receipt_id, "position");

ALTER TABLE ONLY public.download_receipt_entries
    ADD CONSTRAINT download_receipt_entries_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.download_receipts
    ADD CONSTRAINT download_receipts_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.hub_observations
    ADD CONSTRAINT hub_observations_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.hub_observations
    ADD CONSTRAINT hub_observations_sequence UNIQUE (model_id, account_id, dataset, external_key, sequence_no);

ALTER TABLE ONLY public.hub_post_attachments
    ADD CONSTRAINT hub_post_attachments_key UNIQUE (model_id, post_id, hub_key);

ALTER TABLE ONLY public.hub_post_attachments
    ADD CONSTRAINT hub_post_attachments_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.hub_post_attachments
    ADD CONSTRAINT hub_post_attachments_slot UNIQUE NULLS NOT DISTINCT (model_id, post_id, attachment_index, member_index, role);

ALTER TABLE ONLY public.hub_posts
    ADD CONSTRAINT hub_posts_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.hub_posts
    ADD CONSTRAINT hub_posts_ref UNIQUE (model_id, account_id, post_ref);

ALTER TABLE ONLY public.hub_raw_media
    ADD CONSTRAINT hub_raw_media_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.hub_raw_media
    ADD CONSTRAINT hub_raw_media_ref UNIQUE (model_id, account_id, media_ref);

ALTER TABLE ONLY public.hub_sync_state
    ADD CONSTRAINT hub_sync_state_model_id_id_key UNIQUE (model_id, id);

ALTER TABLE ONLY public.hub_sync_state
    ADD CONSTRAINT hub_sync_state_pkey PRIMARY KEY (model_id, account_id, dataset, scope);

ALTER TABLE ONLY public.hub_vault_albums
    ADD CONSTRAINT hub_vault_albums_model_id_account_id_id_key UNIQUE (model_id, account_id, id);

ALTER TABLE ONLY public.hub_vault_albums
    ADD CONSTRAINT hub_vault_albums_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.hub_vault_albums
    ADD CONSTRAINT hub_vault_albums_ref UNIQUE (model_id, account_id, album_ref);

ALTER TABLE ONLY public.hub_vault_media
    ADD CONSTRAINT hub_vault_media_member UNIQUE (model_id, account_id, album_id, member_ref);

ALTER TABLE ONLY public.hub_vault_media
    ADD CONSTRAINT hub_vault_media_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.id_counters
    ADD CONSTRAINT id_counters_pkey PRIMARY KEY (model_id, type);

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_principal_id_operation_key_key UNIQUE (principal_id, operation, key);

ALTER TABLE ONLY public.inbox_draft_candidates
    ADD CONSTRAINT inbox_draft_candidates_link UNIQUE NULLS NOT DISTINCT (model_id, draft_id, kind, order_id, item_id, version_id);

ALTER TABLE ONLY public.inbox_draft_candidates
    ADD CONSTRAINT inbox_draft_candidates_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_source_revision UNIQUE (model_id, source_revision_id);

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_web_upload UNIQUE (model_id, web_upload_id);

ALTER TABLE ONLY public.inbox_groups
    ADD CONSTRAINT inbox_groups_model_id_source_id_group_key_key UNIQUE (model_id, source_id, group_key);

ALTER TABLE ONLY public.inbox_groups
    ADD CONSTRAINT inbox_groups_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.item_memberships
    ADD CONSTRAINT item_memberships_display_position UNIQUE (model_id, item_id, display_position) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.item_memberships
    ADD CONSTRAINT item_memberships_model_id_item_id_asset_id_key UNIQUE (model_id, item_id, asset_id);

ALTER TABLE ONLY public.item_memberships
    ADD CONSTRAINT item_memberships_model_id_item_id_id_key UNIQUE (model_id, item_id, id);

ALTER TABLE ONLY public.item_memberships
    ADD CONSTRAINT item_memberships_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.item_tags
    ADD CONSTRAINT item_tags_id_key UNIQUE (id);

ALTER TABLE ONLY public.item_tags
    ADD CONSTRAINT item_tags_pkey PRIMARY KEY (model_id, item_id, tag_id);

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_key UNIQUE (model_id, source_object_id, parser_version, claim_key);

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.legacy_number_claims
    ADD CONSTRAINT legacy_number_claims_claim UNIQUE (model_id, claim_id);

ALTER TABLE ONLY public.legacy_number_claims
    ADD CONSTRAINT legacy_number_claims_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.master_checks
    ADD CONSTRAINT master_checks_attempt UNIQUE (source_sha256, recipe_digest, work_id, attempt);

ALTER TABLE ONLY public.master_checks
    ADD CONSTRAINT master_checks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_code_key UNIQUE (code);

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pipeline_versions
    ADD CONSTRAINT pipeline_versions_pkey PRIMARY KEY (version);

ALTER TABLE ONLY public.placement_assets
    ADD CONSTRAINT placement_assets_model_id_id_key UNIQUE (model_id, id);

ALTER TABLE ONLY public.placement_assets
    ADD CONSTRAINT placement_assets_pkey PRIMARY KEY (model_id, placement_id, asset_version_id);

ALTER TABLE ONLY public.placement_assets
    ADD CONSTRAINT placement_assets_position UNIQUE (model_id, placement_id, "position");

ALTER TABLE ONLY public.placement_evidence
    ADD CONSTRAINT placement_evidence_corrects_once UNIQUE (corrects_id);

ALTER TABLE ONLY public.placement_evidence
    ADD CONSTRAINT placement_evidence_dedup UNIQUE (model_id, placement_id, source, dedup_key);

ALTER TABLE ONLY public.placement_evidence
    ADD CONSTRAINT placement_evidence_model_id_placement_id_id_key UNIQUE (model_id, placement_id, id);

ALTER TABLE ONLY public.placement_evidence
    ADD CONSTRAINT placement_evidence_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT placements_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.platform_texts
    ADD CONSTRAINT platform_texts_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.platform_texts
    ADD CONSTRAINT platform_texts_variant UNIQUE NULLS NOT DISTINCT (model_id, item_id, platform, account_id, locale, variant_no);

ALTER TABLE ONLY public.policy_settings
    ADD CONSTRAINT policy_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.policy_settings
    ADD CONSTRAINT policy_settings_scope UNIQUE NULLS NOT DISTINCT (model_id, account_id, item_type, key);

ALTER TABLE ONLY public.posting_plan_rows
    ADD CONSTRAINT posting_plan_rows_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.ppv_releases
    ADD CONSTRAINT ppv_releases_model_id_id_item_id_key UNIQUE (model_id, id, item_id);

ALTER TABLE ONLY public.ppv_releases
    ADD CONSTRAINT ppv_releases_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.principal_grants
    ADD CONSTRAINT principal_grants_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_login_key UNIQUE (login);

ALTER TABLE ONLY public.principals
    ADD CONSTRAINT principals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.promo_channels
    ADD CONSTRAINT promo_channels_model_id_code_key UNIQUE (model_id, code);

ALTER TABLE ONLY public.promo_channels
    ADD CONSTRAINT promo_channels_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.promo_deliveries
    ADD CONSTRAINT promo_deliveries_corrects_once UNIQUE (corrects_id);

ALTER TABLE ONLY public.promo_deliveries
    ADD CONSTRAINT promo_deliveries_manifest UNIQUE (model_id, manifest_id);

ALTER TABLE ONLY public.promo_deliveries
    ADD CONSTRAINT promo_deliveries_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.provenance
    ADD CONSTRAINT provenance_link UNIQUE NULLS NOT DISTINCT (model_id, relation, child_item_id, child_version_id, parent_item_id, parent_version_id);

ALTER TABLE ONLY public.provenance
    ADD CONSTRAINT provenance_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.rendition_artifacts
    ADD CONSTRAINT rendition_artifacts_generation_id_name_key UNIQUE (generation_id, name);

ALTER TABLE ONLY public.rendition_artifacts
    ADD CONSTRAINT rendition_artifacts_id_output_sha256_key UNIQUE (id, output_sha256);

ALTER TABLE ONLY public.rendition_artifacts
    ADD CONSTRAINT rendition_artifacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rendition_artifacts
    ADD CONSTRAINT rendition_artifacts_storage_key_key UNIQUE (storage_key);

ALTER TABLE ONLY public.rendition_generations
    ADD CONSTRAINT rendition_generations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.review_cases
    ADD CONSTRAINT review_cases_model_id_kind_dedup_key_key UNIQUE (model_id, kind, dedup_key);

ALTER TABLE ONLY public.review_cases
    ADD CONSTRAINT review_cases_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.source_objects
    ADD CONSTRAINT source_objects_model_id_archive_revision_id_archive_entry_n_key UNIQUE (model_id, archive_revision_id, archive_entry_no);

ALTER TABLE ONLY public.source_objects
    ADD CONSTRAINT source_objects_model_id_source_id_resource_id_key UNIQUE (model_id, source_id, resource_id);

ALTER TABLE ONLY public.source_objects
    ADD CONSTRAINT source_objects_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.source_paths
    ADD CONSTRAINT source_paths_model_id_source_object_id_path_nfc_key UNIQUE (model_id, source_object_id, path_nfc);

ALTER TABLE ONLY public.source_paths
    ADD CONSTRAINT source_paths_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.source_revisions
    ADD CONSTRAINT source_revisions_model_id_source_object_id_id_key UNIQUE (model_id, source_object_id, id);

ALTER TABLE ONLY public.source_revisions
    ADD CONSTRAINT source_revisions_model_id_source_object_id_sequence_no_key UNIQUE (model_id, source_object_id, sequence_no);

ALTER TABLE ONLY public.source_revisions
    ADD CONSTRAINT source_revisions_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_model_id_label_key UNIQUE (model_id, label);

ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.storage_operations
    ADD CONSTRAINT storage_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.surfaces
    ADD CONSTRAINT surfaces_account_id_kind_key UNIQUE (account_id, kind);

ALTER TABLE ONLY public.surfaces
    ADD CONSTRAINT surfaces_model_id_account_id_id_key UNIQUE (model_id, account_id, id);

ALTER TABLE ONLY public.surfaces
    ADD CONSTRAINT surfaces_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_slug UNIQUE NULLS NOT DISTINCT (model_id, slug);

ALTER TABLE ONLY public.web_uploads
    ADD CONSTRAINT web_uploads_model_id_upload_id_key UNIQUE (model_id, upload_id);

ALTER TABLE ONLY public.web_uploads
    ADD CONSTRAINT web_uploads_pkey PRIMARY KEY (model_id, id);

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_model_id_id_key UNIQUE (model_id, id);

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_work_key UNIQUE NULLS NOT DISTINCT (model_id, kind, work_key);

CREATE INDEX action_log_actor_at ON public.action_log USING btree (actor_id, at DESC);

CREATE INDEX action_log_at_brin ON public.action_log USING brin (at);

CREATE INDEX action_log_item_history ON public.action_log USING btree (model_id, item_id, at DESC) WHERE (entry_kind = 'action'::text);

CREATE INDEX action_log_model_at ON public.action_log USING btree (model_id, at DESC);

CREATE INDEX action_log_subject ON public.action_log USING btree (model_id, subject_kind, subject_id, at DESC);

CREATE INDEX aliases_value_norm ON public.aliases USING btree (model_id, value_norm);

CREATE INDEX aliases_value_trgm ON public.aliases USING gin (value_norm public.gin_trgm_ops);

CREATE INDEX annotation_fields_version ON public.annotation_fields USING btree (model_id, version_id) WHERE (version_id IS NOT NULL);

CREATE INDEX asset_manifest_entries_version ON public.asset_manifest_entries USING btree (model_id, asset_version_id);

CREATE INDEX asset_versions_master ON public.asset_versions USING btree (master_sha256);

CREATE UNIQUE INDEX assets_uniq_variant ON public.assets USING btree (model_id, created_in_item_id, variant_no) WHERE (variant_kind = 'uniq'::text);

CREATE INDEX blob_probes_duration_size ON public.blob_probes USING btree (duration_ms, width, height);

CREATE INDEX blob_probes_shot_at ON public.blob_probes USING btree (shot_at);

CREATE INDEX chronology_entries_item ON public.chronology_entries USING btree (model_id, item_id, at_ms);

CREATE INDEX chronology_entries_search ON public.chronology_entries USING gin (tsv);

CREATE INDEX content_items_live_type ON public.content_items USING btree (model_id, type) WHERE (deleted_at IS NULL);

CREATE INDEX content_items_search ON public.content_items USING gin (search_tsv);

CREATE INDEX content_items_shot_on ON public.content_items USING btree (model_id, shot_on);

CREATE INDEX content_items_title_trgm ON public.content_items USING gin (title public.gin_trgm_ops, title_en public.gin_trgm_ops);

CREATE INDEX content_items_updated ON public.content_items USING btree (model_id, updated_at DESC);

CREATE INDEX custom_order_deliveries_item ON public.custom_order_deliveries USING btree (model_id, item_id) WHERE (item_id IS NOT NULL);

CREATE INDEX custom_orders_brief_trgm ON public.custom_orders USING gin (brief public.gin_trgm_ops);

CREATE INDEX custom_orders_buyer ON public.custom_orders USING btree (model_id, lower(buyer_name));

CREATE INDEX custom_orders_status ON public.custom_orders USING btree (model_id, status, due_at);

CREATE INDEX download_receipt_entries_name ON public.download_receipt_entries USING btree (model_id, file_name_norm);

CREATE INDEX download_receipt_entries_version ON public.download_receipt_entries USING btree (model_id, asset_version_id, receipt_id);

CREATE UNIQUE INDEX download_receipts_corrects ON public.download_receipts USING btree (model_id, corrects_id) WHERE (corrects_id IS NOT NULL);

CREATE INDEX download_receipts_issued ON public.download_receipts USING btree (model_id, issued_at DESC);

CREATE INDEX download_receipts_plan_row ON public.download_receipts USING btree (model_id, plan_row_id) WHERE (plan_row_id IS NOT NULL);

CREATE INDEX hub_post_attachments_media ON public.hub_post_attachments USING btree (model_id, media_ref);

CREATE INDEX hub_post_attachments_offer ON public.hub_post_attachments USING btree (model_id, media_offer_ref);

CREATE INDEX hub_posts_files ON public.hub_posts USING btree (account_id, attachment_count, published_at);

CREATE INDEX hub_posts_published ON public.hub_posts USING btree (account_id, published_at DESC);

CREATE INDEX hub_raw_media_name ON public.hub_raw_media USING btree (model_id, filename_norm);

CREATE INDEX hub_raw_media_shape ON public.hub_raw_media USING btree (account_id, duration_ms, orig_width, orig_height);

CREATE INDEX hub_vault_albums_title ON public.hub_vault_albums USING btree (model_id, lower(title));

CREATE INDEX hub_vault_media_media ON public.hub_vault_media USING btree (model_id, media_ref);

CREATE UNIQUE INDEX inbox_draft_candidates_chosen ON public.inbox_draft_candidates USING btree (model_id, draft_id, kind) WHERE chosen;

CREATE INDEX inbox_drafts_blocked ON public.inbox_drafts USING btree (model_id, blocked_reason) WHERE (blocked_reason IS NOT NULL);

CREATE INDEX inbox_drafts_group ON public.inbox_drafts USING btree (model_id, group_id);

CREATE INDEX inbox_drafts_master ON public.inbox_drafts USING btree (master_sha256);

CREATE INDEX inbox_drafts_queue ON public.inbox_drafts USING btree (model_id, state, priority DESC, discovered_at);

CREATE INDEX inbox_drafts_search ON public.inbox_drafts USING gin (search_tsv);

CREATE INDEX inbox_drafts_source_blob ON public.inbox_drafts USING btree (source_blob_sha256);

CREATE INDEX inbox_drafts_source_sha256 ON public.inbox_drafts USING btree (source_sha256);

CREATE INDEX item_memberships_asset ON public.item_memberships USING btree (model_id, asset_id, removed_at);

CREATE UNIQUE INDEX item_memberships_handle ON public.item_memberships USING btree (model_id, item_id, role, ordinal, variant_no) NULLS NOT DISTINCT WHERE (kind = 'owned'::text);

CREATE INDEX item_memberships_item ON public.item_memberships USING btree (model_id, item_id, removed_at, display_position);

CREATE UNIQUE INDEX item_memberships_one_owner ON public.item_memberships USING btree (model_id, asset_id) WHERE ((kind = 'owned'::text) AND (removed_at IS NULL));

CREATE INDEX item_tags_tag ON public.item_tags USING btree (model_id, tag_id);

CREATE INDEX legacy_claims_pending ON public.legacy_claims USING btree (model_id, claim_kind, created_at) WHERE (resolution = 'pending'::text);

CREATE INDEX legacy_claims_source ON public.legacy_claims USING btree (model_id, source_object_id);

CREATE INDEX legacy_number_claims_number ON public.legacy_number_claims USING btree (model_id, type, claimed_number);

CREATE INDEX master_checks_master ON public.master_checks USING btree (master_sha256);

CREATE UNIQUE INDEX pipeline_versions_one_current ON public.pipeline_versions USING btree (is_current) WHERE is_current;

CREATE INDEX placement_assets_version ON public.placement_assets USING btree (model_id, asset_version_id);

CREATE INDEX placement_evidence_placement ON public.placement_evidence USING btree (model_id, placement_id, recorded_at);

CREATE INDEX placements_item ON public.placements USING btree (model_id, item_id, occurred_at DESC);

CREATE UNIQUE INDEX placements_manual_key ON public.placements USING btree (model_id, surface_id, manual_key) WHERE (manual_key IS NOT NULL);

CREATE INDEX placements_page ON public.placements USING btree (model_id, account_id, surface_id, occurred_at DESC);

CREATE INDEX placements_plan_row ON public.placements USING btree (model_id, plan_row_id) WHERE (plan_row_id IS NOT NULL);

CREATE UNIQUE INDEX placements_post ON public.placements USING btree (model_id, surface_id, external_post_ref) WHERE (external_post_ref IS NOT NULL);

CREATE INDEX placements_unbound ON public.placements USING btree (model_id, created_at) WHERE ((item_id IS NULL) AND (NOT out_of_catalog));

CREATE UNIQUE INDEX placements_vault_member ON public.placements USING btree (model_id, surface_id, external_album_ref, external_media_ref) WHERE (external_media_ref IS NOT NULL);

CREATE INDEX posting_plan_rows_item ON public.posting_plan_rows USING btree (model_id, item_id, slot_at DESC);

CREATE INDEX posting_plan_rows_open ON public.posting_plan_rows USING btree (model_id, slot_at) WHERE ((marked_at IS NULL) AND (cancelled_at IS NULL));

CREATE INDEX posting_plan_rows_page ON public.posting_plan_rows USING btree (model_id, account_id, slot_at);

CREATE UNIQUE INDEX posting_plan_rows_release_surface ON public.posting_plan_rows USING btree (model_id, release_id, release_surface_kind) WHERE ((release_id IS NOT NULL) AND (cancelled_at IS NULL));

CREATE INDEX posting_plan_rows_tasks ON public.posting_plan_rows USING btree (model_id, assignee_id, slot_date);

CREATE INDEX posting_plan_rows_uniq_waiting ON public.posting_plan_rows USING btree (model_id, item_id, uniq_variant_no) WHERE ((manifest_id IS NULL) AND (uniq_variant_no IS NOT NULL));

CREATE INDEX ppv_releases_page ON public.ppv_releases USING btree (model_id, account_id, release_date DESC);

CREATE UNIQUE INDEX principal_grants_live_key ON public.principal_grants USING btree (principal_id, model_id) WHERE (revoked_at IS NULL);

CREATE INDEX promo_deliveries_contractor ON public.promo_deliveries USING btree (model_id, contractor_id) WHERE (state = 'sent'::text);

CREATE INDEX promo_deliveries_created ON public.promo_deliveries USING btree (model_id, created_at DESC);

CREATE INDEX promo_deliveries_package ON public.promo_deliveries USING btree (model_id, package_item_id, created_at);

CREATE INDEX provenance_child_item ON public.provenance USING btree (model_id, child_item_id);

CREATE INDEX provenance_child_version ON public.provenance USING btree (model_id, child_version_id);

CREATE INDEX provenance_parent_item ON public.provenance USING btree (model_id, parent_item_id);

CREATE INDEX provenance_parent_version ON public.provenance USING btree (model_id, parent_version_id);

CREATE INDEX provenance_ppv_from_custom ON public.provenance USING btree (model_id, parent_item_id) WHERE (relation = 'ppv_from_custom'::text);

CREATE UNIQUE INDEX provenance_voided_by ON public.provenance USING btree (model_id, voided_by_id) WHERE (voided_by_id IS NOT NULL);

CREATE UNIQUE INDEX rendition_generations_active_key ON public.rendition_generations USING btree (master_sha256, kind, recipe_digest, meta_stripped) WHERE is_active;

CREATE INDEX rendition_generations_input ON public.rendition_generations USING btree (input_sha256);

CREATE INDEX source_objects_last_seen ON public.source_objects USING btree (model_id, last_seen_at);

CREATE INDEX source_objects_path_trgm ON public.source_objects USING gin (current_path public.gin_trgm_ops);

CREATE INDEX source_revisions_frozen ON public.source_revisions USING btree (model_id, frozen_by_work_id) WHERE (frozen_by_work_id IS NOT NULL);

CREATE INDEX source_revisions_remote_sha256 ON public.source_revisions USING btree (model_id, remote_sha256);

CREATE INDEX source_revisions_source_sha256 ON public.source_revisions USING btree (model_id, source_sha256);

CREATE UNIQUE INDEX storage_operations_active ON public.storage_operations USING btree (blob_sha256) WHERE (state = ANY (ARRAY['intent'::text, 'started'::text, 'fs_done'::text]));

CREATE INDEX web_uploads_sha256 ON public.web_uploads USING btree (sha256) WHERE (sha256 IS NOT NULL);

CREATE INDEX web_uploads_unfinished ON public.web_uploads USING btree (model_id, created_at) WHERE (state = ANY (ARRAY['receiving'::text, 'received'::text, 'verified'::text]));

CREATE INDEX work_operations_draft ON public.work_operations USING btree (model_id, draft_id) WHERE (draft_id IS NOT NULL);

CREATE INDEX work_operations_due ON public.work_operations USING btree (next_attempt_at, priority) WHERE (state = ANY (ARRAY['pending'::text, 'retry_wait'::text]));

CREATE INDEX work_operations_lease ON public.work_operations USING btree (lease_until) WHERE (state = 'running'::text);

CREATE INDEX work_operations_manifest ON public.work_operations USING btree (model_id, manifest_id) WHERE (manifest_id IS NOT NULL);

CREATE INDEX work_operations_output ON public.work_operations USING btree (output_sha256) WHERE (output_sha256 IS NOT NULL);

CREATE UNIQUE INDEX work_operations_stream_key ON public.work_operations USING btree (model_id, kind, stream_key) NULLS NOT DISTINCT WHERE ((stream_key IS NOT NULL) AND (state = ANY (ARRAY['pending'::text, 'running'::text, 'retry_wait'::text])));

CREATE TRIGGER accounts_fixed BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id');

CREATE TRIGGER accounts_journal AFTER INSERT OR DELETE OR UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER action_log_append_only BEFORE DELETE OR UPDATE ON public.action_log FOR EACH ROW EXECUTE FUNCTION public.forbid_update_delete();

CREATE TRIGGER aliases_fixed BEFORE UPDATE ON public.aliases FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'kind', 'value_raw');

CREATE TRIGGER aliases_journal AFTER INSERT OR DELETE OR UPDATE ON public.aliases FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER annotation_fields_fixed BEFORE UPDATE ON public.annotation_fields FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'field');

CREATE TRIGGER annotation_fields_journal AFTER INSERT OR DELETE OR UPDATE ON public.annotation_fields FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER asset_manifest_entries_append_only BEFORE DELETE OR UPDATE ON public.asset_manifest_entries FOR EACH ROW EXECUTE FUNCTION public.forbid_update_delete();

CREATE CONSTRAINT TRIGGER asset_manifest_entries_sealed AFTER INSERT ON public.asset_manifest_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_sealed_count('asset_manifests', 'asset_manifest_entries', 'manifest_id');

CREATE TRIGGER asset_manifests_append_only BEFORE DELETE OR UPDATE ON public.asset_manifests FOR EACH ROW EXECUTE FUNCTION public.forbid_update_delete();

CREATE CONSTRAINT TRIGGER asset_manifests_sealed AFTER INSERT ON public.asset_manifests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_sealed_count('asset_manifests', 'asset_manifest_entries', 'manifest_id');

CREATE TRIGGER asset_versions_append_only BEFORE DELETE OR UPDATE ON public.asset_versions FOR EACH ROW EXECUTE FUNCTION public.forbid_update_delete();

CREATE TRIGGER assets_fixed BEFORE UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'created_in_item_id', 'media_kind', 'variant_kind', 'variant_no', 'uniq_level');

CREATE TRIGGER assets_journal AFTER INSERT OR DELETE OR UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER blobs_fixed BEFORE UPDATE ON public.blobs FOR EACH ROW EXECUTE FUNCTION public.forbid_change('sha256', 'byte_size', 'ext', 'media_kind', 'storage_key');

CREATE TRIGGER chronology_entries_fixed BEFORE UPDATE ON public.chronology_entries FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'item_id', 'asset_version_id');

CREATE TRIGGER chronology_entries_journal AFTER INSERT OR DELETE OR UPDATE ON public.chronology_entries FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER content_items_fixed BEFORE UPDATE ON public.content_items FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'type', 'number');

CREATE TRIGGER content_items_journal AFTER INSERT OR DELETE OR UPDATE ON public.content_items FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER content_items_second_person_late AFTER UPDATE OF has_second_person ON public.content_items FOR EACH ROW WHEN (((new.has_second_person IS TRUE) AND (old.has_second_person IS NOT TRUE))) EXECUTE FUNCTION public.content_item_second_person_late();

CREATE TRIGGER contractors_fixed BEFORE UPDATE ON public.contractors FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id');

CREATE TRIGGER contractors_journal AFTER INSERT OR DELETE OR UPDATE ON public.contractors FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER custom_order_deliveries_append_only BEFORE DELETE OR UPDATE ON public.custom_order_deliveries FOR EACH ROW EXECUTE FUNCTION public.forbid_update_delete();

CREATE TRIGGER custom_order_deliveries_lock BEFORE INSERT ON public.custom_order_deliveries FOR EACH ROW EXECUTE FUNCTION public.custom_order_delivery_lock();

CREATE TRIGGER custom_order_messages_fixed BEFORE UPDATE ON public.custom_order_messages FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'order_id');

CREATE TRIGGER custom_order_messages_journal AFTER INSERT OR DELETE OR UPDATE ON public.custom_order_messages FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER custom_order_revisions_fixed BEFORE UPDATE ON public.custom_order_revisions FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'order_id');

CREATE TRIGGER custom_order_revisions_journal AFTER INSERT OR DELETE OR UPDATE ON public.custom_order_revisions FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER custom_order_revisions_lock BEFORE INSERT OR UPDATE ON public.custom_order_revisions FOR EACH ROW EXECUTE FUNCTION public.custom_order_revision_lock();

CREATE TRIGGER custom_orders_fixed BEFORE UPDATE ON public.custom_orders FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id');

CREATE TRIGGER custom_orders_journal AFTER INSERT OR DELETE OR UPDATE ON public.custom_orders FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER custom_orders_status BEFORE INSERT OR UPDATE ON public.custom_orders FOR EACH ROW EXECUTE FUNCTION public.custom_order_status();

CREATE TRIGGER download_receipt_entries_append_only BEFORE DELETE OR UPDATE ON public.download_receipt_entries FOR EACH ROW EXECUTE FUNCTION public.forbid_update_delete();

CREATE CONSTRAINT TRIGGER download_receipt_entries_sealed AFTER INSERT ON public.download_receipt_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_sealed_count('download_receipts', 'download_receipt_entries', 'receipt_id');

CREATE TRIGGER download_receipts_append_only BEFORE DELETE OR UPDATE ON public.download_receipts FOR EACH ROW EXECUTE FUNCTION public.forbid_update_delete();

CREATE CONSTRAINT TRIGGER download_receipts_sealed AFTER INSERT ON public.download_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_sealed_count('download_receipts', 'download_receipt_entries', 'receipt_id');

CREATE TRIGGER hub_observations_append_only BEFORE DELETE OR UPDATE ON public.hub_observations FOR EACH ROW EXECUTE FUNCTION public.forbid_update_delete();

CREATE TRIGGER hub_post_attachments_fixed BEFORE UPDATE ON public.hub_post_attachments FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'post_id', 'hub_key');

CREATE TRIGGER hub_posts_fixed BEFORE UPDATE ON public.hub_posts FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'account_id', 'post_ref');

CREATE TRIGGER hub_raw_media_fixed BEFORE UPDATE ON public.hub_raw_media FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'account_id', 'media_ref');

CREATE TRIGGER hub_sync_state_fixed BEFORE UPDATE ON public.hub_sync_state FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'account_id', 'dataset', 'scope');

CREATE TRIGGER hub_sync_state_journal AFTER INSERT OR DELETE OR UPDATE ON public.hub_sync_state FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER hub_vault_albums_fixed BEFORE UPDATE ON public.hub_vault_albums FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'account_id', 'album_ref');

CREATE TRIGGER hub_vault_media_fixed BEFORE UPDATE ON public.hub_vault_media FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'account_id', 'album_id', 'member_ref');

CREATE TRIGGER id_counters_fixed BEFORE UPDATE ON public.id_counters FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'type');

CREATE TRIGGER id_counters_journal AFTER INSERT OR DELETE OR UPDATE ON public.id_counters FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'type');

CREATE TRIGGER inbox_draft_candidates_fixed BEFORE UPDATE ON public.inbox_draft_candidates FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'draft_id', 'kind', 'order_id', 'item_id', 'version_id');

CREATE TRIGGER inbox_draft_candidates_journal AFTER INSERT OR DELETE OR UPDATE ON public.inbox_draft_candidates FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER inbox_drafts_fixed BEFORE UPDATE ON public.inbox_drafts FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'source_revision_id', 'web_upload_id', 'from_version_id', 'origin');

CREATE TRIGGER inbox_drafts_journal AFTER INSERT OR DELETE OR UPDATE ON public.inbox_drafts FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER inbox_drafts_transition BEFORE UPDATE ON public.inbox_drafts FOR EACH ROW EXECUTE FUNCTION public.inbox_draft_transition();

CREATE TRIGGER inbox_groups_fixed BEFORE UPDATE ON public.inbox_groups FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'source_id', 'group_key');

CREATE TRIGGER inbox_groups_journal AFTER INSERT OR DELETE OR UPDATE ON public.inbox_groups FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER item_memberships_fixed BEFORE UPDATE ON public.item_memberships FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'item_id', 'item_type', 'asset_id', 'variant_no', 'kind');

CREATE TRIGGER item_memberships_journal AFTER INSERT OR DELETE OR UPDATE ON public.item_memberships FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER item_tags_fixed BEFORE UPDATE ON public.item_tags FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'item_id', 'tag_id', 'id');

CREATE TRIGGER item_tags_journal AFTER INSERT OR DELETE OR UPDATE ON public.item_tags FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'item_id', 'tag_id');

CREATE TRIGGER item_tags_tag_scope BEFORE INSERT ON public.item_tags FOR EACH ROW EXECUTE FUNCTION public.check_tag_scope();

CREATE TRIGGER legacy_claims_fixed BEFORE UPDATE ON public.legacy_claims FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'source_object_id', 'source_revision_id', 'parser_version', 'claim_key', 'raw_fragment', 'claim_kind');

CREATE TRIGGER legacy_claims_journal AFTER INSERT OR DELETE OR UPDATE ON public.legacy_claims FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER legacy_number_claims_fixed BEFORE UPDATE ON public.legacy_number_claims FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'type', 'claimed_number', 'source_object_id', 'claim_id');

CREATE TRIGGER legacy_number_claims_journal AFTER INSERT OR DELETE OR UPDATE ON public.legacy_number_claims FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER models_journal AFTER INSERT OR DELETE OR UPDATE ON public.models FOR EACH ROW EXECUTE FUNCTION public.log_row_change('id');

CREATE TRIGGER pipeline_versions_fixed BEFORE UPDATE ON public.pipeline_versions FOR EACH ROW EXECUTE FUNCTION public.forbid_change('version', 'ffmpeg', 'svtav1', 'libvips', 'sharp', 'phash_algo', 'master_recipe', 'rendition_recipes', 'recipe_digests');

CREATE TRIGGER placement_assets_fixed BEFORE UPDATE ON public.placement_assets FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'placement_id', 'asset_id', 'asset_version_id');

CREATE TRIGGER placement_assets_journal AFTER INSERT OR DELETE OR UPDATE ON public.placement_assets FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER placement_evidence_append_only BEFORE DELETE OR UPDATE ON public.placement_evidence FOR EACH ROW EXECUTE FUNCTION public.forbid_update_delete();

CREATE TRIGGER placements_fixed BEFORE UPDATE ON public.placements FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'account_id', 'surface_id');

CREATE TRIGGER placements_journal AFTER INSERT OR DELETE OR UPDATE ON public.placements FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER platform_texts_fixed BEFORE UPDATE ON public.platform_texts FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'item_id', 'platform', 'account_id', 'locale', 'variant_no');

CREATE TRIGGER platform_texts_journal AFTER INSERT OR DELETE OR UPDATE ON public.platform_texts FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER policy_settings_fixed BEFORE UPDATE ON public.policy_settings FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'account_id', 'item_type', 'key');

CREATE TRIGGER policy_settings_journal AFTER INSERT OR DELETE OR UPDATE ON public.policy_settings FOR EACH ROW EXECUTE FUNCTION public.log_row_change('id');

CREATE TRIGGER posting_plan_rows_fixed BEFORE UPDATE ON public.posting_plan_rows FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'release_id', 'release_surface_kind', 'created_at', 'created_by');

CREATE TRIGGER posting_plan_rows_journal AFTER INSERT OR DELETE OR UPDATE ON public.posting_plan_rows FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER posting_plan_rows_second_person BEFORE INSERT OR UPDATE OF item_id, manifest_id, account_id ON public.posting_plan_rows FOR EACH ROW EXECUTE FUNCTION public.posting_plan_row_second_person();

CREATE TRIGGER posting_plan_rows_slot BEFORE INSERT OR UPDATE OF slot_date, slot_time, slot_tz, slot_at, release_id, account_id, surface_id ON public.posting_plan_rows FOR EACH ROW EXECUTE FUNCTION public.posting_plan_row_slot();

CREATE TRIGGER ppv_releases_fixed BEFORE UPDATE ON public.ppv_releases FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'account_id', 'item_id', 'item_type');

CREATE TRIGGER ppv_releases_journal AFTER INSERT OR DELETE OR UPDATE ON public.ppv_releases FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER principal_grants_fixed BEFORE UPDATE ON public.principal_grants FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'principal_id');

CREATE TRIGGER principal_grants_journal AFTER INSERT OR DELETE OR UPDATE ON public.principal_grants FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER promo_channels_fixed BEFORE UPDATE ON public.promo_channels FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id');

CREATE TRIGGER promo_channels_journal AFTER INSERT OR DELETE OR UPDATE ON public.promo_channels FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER promo_deliveries_fixed BEFORE UPDATE ON public.promo_deliveries FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'package_item_id', 'package_item_type', 'channel_id', 'contractor_id', 'format', 'manifest_id', 'origin', 'corrects_id', 'prepared_at', 'prepared_by');

CREATE TRIGGER promo_deliveries_journal AFTER INSERT OR DELETE OR UPDATE ON public.promo_deliveries FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER promo_deliveries_receipt_once BEFORE UPDATE ON public.promo_deliveries FOR EACH ROW EXECUTE FUNCTION public.set_once('receipt_id');

CREATE TRIGGER promo_deliveries_sent_frozen BEFORE DELETE OR UPDATE ON public.promo_deliveries FOR EACH ROW WHEN ((old.state = 'sent'::text)) EXECUTE FUNCTION public.forbid_update_delete();

CREATE TRIGGER promo_deliveries_transition BEFORE UPDATE ON public.promo_deliveries FOR EACH ROW EXECUTE FUNCTION public.promo_delivery_transition();

CREATE TRIGGER provenance_fixed BEFORE UPDATE ON public.provenance FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'relation', 'child_item_id', 'child_version_id', 'parent_item_id', 'parent_version_id');

CREATE TRIGGER provenance_journal AFTER INSERT OR DELETE OR UPDATE ON public.provenance FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER rendition_artifacts_fixed BEFORE UPDATE ON public.rendition_artifacts FOR EACH ROW EXECUTE FUNCTION public.forbid_change('id', 'generation_id', 'name', 'output_sha256', 'storage_key');

CREATE TRIGGER rendition_generations_bound_once BEFORE UPDATE ON public.rendition_generations FOR EACH ROW EXECUTE FUNCTION public.set_once('master_sha256', 'bound_at');

CREATE TRIGGER rendition_generations_fixed BEFORE UPDATE ON public.rendition_generations FOR EACH ROW EXECUTE FUNCTION public.forbid_change('id', 'kind', 'recipe_digest', 'meta_stripped', 'input_kind', 'input_sha256');

CREATE TRIGGER review_cases_fixed BEFORE UPDATE ON public.review_cases FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'kind', 'dedup_key');

CREATE TRIGGER review_cases_journal AFTER INSERT OR DELETE OR UPDATE ON public.review_cases FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER source_objects_fixed BEFORE UPDATE ON public.source_objects FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'source_id', 'resource_id', 'upload_id', 'archive_revision_id', 'archive_entry_no');

CREATE TRIGGER source_objects_journal AFTER INSERT OR DELETE OR UPDATE ON public.source_objects FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER source_paths_fixed BEFORE UPDATE ON public.source_paths FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'source_object_id', 'path_raw', 'name');

CREATE TRIGGER source_paths_journal AFTER INSERT OR DELETE OR UPDATE ON public.source_paths FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER source_revisions_fixed BEFORE UPDATE ON public.source_revisions FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'source_object_id', 'sequence_no', 'md5', 'remote_sha256', 'content_hash', 'remote_rev', 'byte_size', 'remote_created_at', 'remote_modified_at', 'remote_shot_at', 'media_type', 'crc32', 'detected_at', 'scan_work_id', 'previous_id');

CREATE TRIGGER source_revisions_journal AFTER INSERT OR DELETE OR UPDATE ON public.source_revisions FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER source_revisions_verified_once BEFORE UPDATE ON public.source_revisions FOR EACH ROW EXECUTE FUNCTION public.set_once('source_sha256', 'verified_at', 'verified_route', 'frozen_by_work_id', 'frozen_path');

CREATE TRIGGER sources_fixed BEFORE UPDATE ON public.sources FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'kind');

CREATE TRIGGER sources_journal AFTER INSERT OR DELETE OR UPDATE ON public.sources FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER storage_operations_fixed BEFORE UPDATE ON public.storage_operations FOR EACH ROW EXECUTE FUNCTION public.forbid_change('id', 'kind', 'blob_sha256', 'from_key', 'to_key');

CREATE TRIGGER storage_operations_transition BEFORE UPDATE OF state ON public.storage_operations FOR EACH ROW EXECUTE FUNCTION public.storage_operation_transition();

CREATE TRIGGER surfaces_fixed BEFORE UPDATE ON public.surfaces FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'account_id', 'kind');

CREATE TRIGGER surfaces_journal AFTER INSERT OR DELETE OR UPDATE ON public.surfaces FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER tags_fixed BEFORE UPDATE ON public.tags FOR EACH ROW EXECUTE FUNCTION public.forbid_change('id', 'model_id');

CREATE TRIGGER tags_journal AFTER INSERT OR DELETE OR UPDATE ON public.tags FOR EACH ROW EXECUTE FUNCTION public.log_row_change('id');

CREATE TRIGGER web_uploads_fixed BEFORE UPDATE ON public.web_uploads FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'upload_id', 'principal_id', 'size_expected');

CREATE TRIGGER web_uploads_journal AFTER INSERT OR DELETE OR UPDATE ON public.web_uploads FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER work_operations_inputs_fixed BEFORE UPDATE ON public.work_operations FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'kind', 'work_key', 'account_id', 'dataset', 'scope', 'window_from', 'window_to', 'draft_id', 'source_revision_id', 'asset_version_id', 'manifest_id', 'receipt_id', 'generation_id');

CREATE TRIGGER work_operations_success_final BEFORE DELETE OR UPDATE ON public.work_operations FOR EACH ROW WHEN ((old.state = 'succeeded'::text)) EXECUTE FUNCTION public.forbid_update_delete();

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_default_assignee_id_fkey FOREIGN KEY (default_assignee_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.action_log
    ADD CONSTRAINT action_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.action_log
    ADD CONSTRAINT action_log_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.action_log
    ADD CONSTRAINT action_log_work_id_fkey FOREIGN KEY (work_id) REFERENCES public.work_operations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.aliases
    ADD CONSTRAINT aliases_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.aliases
    ADD CONSTRAINT aliases_model_id_asset_id_fkey FOREIGN KEY (model_id, asset_id) REFERENCES public.assets(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.aliases
    ADD CONSTRAINT aliases_model_id_item_id_fkey FOREIGN KEY (model_id, item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.aliases
    ADD CONSTRAINT aliases_model_id_source_object_id_fkey FOREIGN KEY (model_id, source_object_id) REFERENCES public.source_objects(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.annotation_fields
    ADD CONSTRAINT annotation_fields_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.annotation_fields
    ADD CONSTRAINT annotation_fields_model_id_draft_id_fkey FOREIGN KEY (model_id, draft_id) REFERENCES public.inbox_drafts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.annotation_fields
    ADD CONSTRAINT annotation_fields_model_id_group_id_fkey FOREIGN KEY (model_id, group_id) REFERENCES public.inbox_groups(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.annotation_fields
    ADD CONSTRAINT annotation_fields_model_id_item_id_fkey FOREIGN KEY (model_id, item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.annotation_fields
    ADD CONSTRAINT annotation_fields_model_id_version_id_fkey FOREIGN KEY (model_id, version_id) REFERENCES public.asset_versions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.annotation_fields
    ADD CONSTRAINT annotation_fields_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.asset_manifest_entries
    ADD CONSTRAINT asset_manifest_entries_model_id_asset_id_asset_version_id_fkey FOREIGN KEY (model_id, asset_id, asset_version_id) REFERENCES public.asset_versions(model_id, asset_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.asset_manifest_entries
    ADD CONSTRAINT asset_manifest_entries_model_id_item_id_fkey FOREIGN KEY (model_id, item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.asset_manifest_entries
    ADD CONSTRAINT asset_manifest_entries_model_id_manifest_id_fkey FOREIGN KEY (model_id, manifest_id) REFERENCES public.asset_manifests(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.asset_manifest_entries
    ADD CONSTRAINT asset_manifest_entries_model_id_membership_id_fkey FOREIGN KEY (model_id, membership_id) REFERENCES public.item_memberships(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.asset_manifests
    ADD CONSTRAINT asset_manifests_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.asset_manifests
    ADD CONSTRAINT asset_manifests_model_id_origin_item_id_fkey FOREIGN KEY (model_id, origin_item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.asset_versions
    ADD CONSTRAINT asset_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.asset_versions
    ADD CONSTRAINT asset_versions_master_sha256_fkey FOREIGN KEY (master_sha256) REFERENCES public.blobs(sha256) ON DELETE RESTRICT;

ALTER TABLE ONLY public.asset_versions
    ADD CONSTRAINT asset_versions_model_id_asset_id_fkey FOREIGN KEY (model_id, asset_id) REFERENCES public.assets(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.asset_versions
    ADD CONSTRAINT asset_versions_model_id_source_revision_id_fkey FOREIGN KEY (model_id, source_revision_id) REFERENCES public.source_revisions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.asset_versions
    ADD CONSTRAINT asset_versions_model_id_work_id_fkey FOREIGN KEY (model_id, work_id) REFERENCES public.work_operations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_current_version_fkey FOREIGN KEY (model_id, id, current_version_id) REFERENCES public.asset_versions(model_id, asset_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.assets
    ADD CONSTRAINT assets_model_id_created_in_item_id_fkey FOREIGN KEY (model_id, created_in_item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.chronology_entries
    ADD CONSTRAINT chronology_entries_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.chronology_entries
    ADD CONSTRAINT chronology_entries_frame_artifact_id_fkey FOREIGN KEY (frame_artifact_id) REFERENCES public.rendition_artifacts(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.chronology_entries
    ADD CONSTRAINT chronology_entries_model_id_asset_version_id_fkey FOREIGN KEY (model_id, asset_version_id) REFERENCES public.asset_versions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.chronology_entries
    ADD CONSTRAINT chronology_entries_model_id_item_id_fkey FOREIGN KEY (model_id, item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_cover_fkey FOREIGN KEY (model_id, id, cover_membership_id) REFERENCES public.item_memberships(model_id, item_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_model_id_created_from_group_id_fkey FOREIGN KEY (model_id, created_from_group_id) REFERENCES public.inbox_groups(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_model_id_default_contractor_id_fkey FOREIGN KEY (model_id, default_contractor_id) REFERENCES public.contractors(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_model_id_merged_into_item_id_fkey FOREIGN KEY (model_id, merged_into_item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.content_items
    ADD CONSTRAINT content_items_model_id_promo_channel_id_fkey FOREIGN KEY (model_id, promo_channel_id) REFERENCES public.promo_channels(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.contractors
    ADD CONSTRAINT contractors_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.contractors
    ADD CONSTRAINT contractors_model_id_channel_id_fkey FOREIGN KEY (model_id, channel_id) REFERENCES public.promo_channels(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.contractors
    ADD CONSTRAINT contractors_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_deliveries
    ADD CONSTRAINT custom_order_deliveries_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_deliveries
    ADD CONSTRAINT custom_order_deliveries_linked_by_fkey FOREIGN KEY (linked_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_deliveries
    ADD CONSTRAINT custom_order_deliveries_model_id_draft_id_fkey FOREIGN KEY (model_id, draft_id) REFERENCES public.inbox_drafts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_deliveries
    ADD CONSTRAINT custom_order_deliveries_model_id_item_id_item_type_fkey FOREIGN KEY (model_id, item_id, item_type) REFERENCES public.content_items(model_id, id, type) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_deliveries
    ADD CONSTRAINT custom_order_deliveries_model_id_manifest_id_fkey FOREIGN KEY (model_id, manifest_id) REFERENCES public.asset_manifests(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_deliveries
    ADD CONSTRAINT custom_order_deliveries_model_id_order_id_fkey FOREIGN KEY (model_id, order_id) REFERENCES public.custom_orders(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_deliveries
    ADD CONSTRAINT custom_order_deliveries_model_id_order_id_retracts_id_fkey FOREIGN KEY (model_id, order_id, retracts_id) REFERENCES public.custom_order_deliveries(model_id, order_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_messages
    ADD CONSTRAINT custom_order_messages_model_id_order_id_fkey FOREIGN KEY (model_id, order_id) REFERENCES public.custom_orders(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_messages
    ADD CONSTRAINT custom_order_messages_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_revisions
    ADD CONSTRAINT custom_order_revisions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_revisions
    ADD CONSTRAINT custom_order_revisions_done_by_fkey FOREIGN KEY (done_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_revisions
    ADD CONSTRAINT custom_order_revisions_model_id_order_id_fixed_delivery_id_fkey FOREIGN KEY (model_id, order_id, fixed_delivery_id) REFERENCES public.custom_order_deliveries(model_id, order_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_order_revisions
    ADD CONSTRAINT custom_order_revisions_model_id_order_id_fkey FOREIGN KEY (model_id, order_id) REFERENCES public.custom_orders(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_orders
    ADD CONSTRAINT custom_orders_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_orders
    ADD CONSTRAINT custom_orders_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_orders
    ADD CONSTRAINT custom_orders_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_orders
    ADD CONSTRAINT custom_orders_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_orders
    ADD CONSTRAINT custom_orders_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_orders
    ADD CONSTRAINT custom_orders_photos_completed_by_fkey FOREIGN KEY (photos_completed_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.custom_orders
    ADD CONSTRAINT custom_orders_video_completed_by_fkey FOREIGN KEY (video_completed_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.download_receipt_entries
    ADD CONSTRAINT download_receipt_entries_model_id_asset_id_asset_version_i_fkey FOREIGN KEY (model_id, asset_id, asset_version_id) REFERENCES public.asset_versions(model_id, asset_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.download_receipt_entries
    ADD CONSTRAINT download_receipt_entries_model_id_receipt_id_fkey FOREIGN KEY (model_id, receipt_id) REFERENCES public.download_receipts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.download_receipt_entries
    ADD CONSTRAINT download_receipt_entries_rendition_artifact_id_output_sha2_fkey FOREIGN KEY (rendition_artifact_id, output_sha256) REFERENCES public.rendition_artifacts(id, output_sha256) ON DELETE RESTRICT;

ALTER TABLE ONLY public.download_receipts
    ADD CONSTRAINT download_receipts_model_id_corrects_id_fkey FOREIGN KEY (model_id, corrects_id) REFERENCES public.download_receipts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.download_receipts
    ADD CONSTRAINT download_receipts_model_id_manifest_id_fkey FOREIGN KEY (model_id, manifest_id) REFERENCES public.asset_manifests(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.download_receipts
    ADD CONSTRAINT download_receipts_model_id_plan_row_id_fkey FOREIGN KEY (model_id, plan_row_id) REFERENCES public.posting_plan_rows(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.download_receipts
    ADD CONSTRAINT download_receipts_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_observations
    ADD CONSTRAINT hub_observations_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_observations
    ADD CONSTRAINT hub_observations_model_id_previous_id_fkey FOREIGN KEY (model_id, previous_id) REFERENCES public.hub_observations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_observations
    ADD CONSTRAINT hub_observations_model_id_run_id_fkey FOREIGN KEY (model_id, run_id) REFERENCES public.work_operations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_post_attachments
    ADD CONSTRAINT hub_post_attachments_model_id_current_observation_id_fkey FOREIGN KEY (model_id, current_observation_id) REFERENCES public.hub_observations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_post_attachments
    ADD CONSTRAINT hub_post_attachments_model_id_matched_asset_id_matched_ver_fkey FOREIGN KEY (model_id, matched_asset_id, matched_version_id) REFERENCES public.asset_versions(model_id, asset_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_post_attachments
    ADD CONSTRAINT hub_post_attachments_model_id_matched_version_id_receipt_e_fkey FOREIGN KEY (model_id, matched_version_id, receipt_entry_id) REFERENCES public.download_receipt_entries(model_id, asset_version_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_post_attachments
    ADD CONSTRAINT hub_post_attachments_model_id_post_id_fkey FOREIGN KEY (model_id, post_id) REFERENCES public.hub_posts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_posts
    ADD CONSTRAINT hub_posts_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_posts
    ADD CONSTRAINT hub_posts_model_id_current_observation_id_fkey FOREIGN KEY (model_id, current_observation_id) REFERENCES public.hub_observations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_raw_media
    ADD CONSTRAINT hub_raw_media_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_raw_media
    ADD CONSTRAINT hub_raw_media_model_id_current_observation_id_fkey FOREIGN KEY (model_id, current_observation_id) REFERENCES public.hub_observations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_sync_state
    ADD CONSTRAINT hub_sync_state_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_sync_state
    ADD CONSTRAINT hub_sync_state_model_id_last_work_id_fkey FOREIGN KEY (model_id, last_work_id) REFERENCES public.work_operations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_vault_albums
    ADD CONSTRAINT hub_vault_albums_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_vault_media
    ADD CONSTRAINT hub_vault_media_model_id_account_id_album_id_fkey FOREIGN KEY (model_id, account_id, album_id) REFERENCES public.hub_vault_albums(model_id, account_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.hub_vault_media
    ADD CONSTRAINT hub_vault_media_model_id_current_observation_id_fkey FOREIGN KEY (model_id, current_observation_id) REFERENCES public.hub_observations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.id_counters
    ADD CONSTRAINT id_counters_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.id_counters
    ADD CONSTRAINT id_counters_model_id_legacy_reserved_work_id_fkey FOREIGN KEY (model_id, legacy_reserved_work_id) REFERENCES public.work_operations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_draft_candidates
    ADD CONSTRAINT inbox_draft_candidates_chosen_by_fkey FOREIGN KEY (chosen_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_draft_candidates
    ADD CONSTRAINT inbox_draft_candidates_model_id_draft_id_fkey FOREIGN KEY (model_id, draft_id) REFERENCES public.inbox_drafts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_draft_candidates
    ADD CONSTRAINT inbox_draft_candidates_model_id_item_id_fkey FOREIGN KEY (model_id, item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_draft_candidates
    ADD CONSTRAINT inbox_draft_candidates_model_id_order_id_fkey FOREIGN KEY (model_id, order_id) REFERENCES public.custom_orders(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_draft_candidates
    ADD CONSTRAINT inbox_draft_candidates_model_id_version_id_fkey FOREIGN KEY (model_id, version_id) REFERENCES public.asset_versions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_master_sha256_fkey FOREIGN KEY (master_sha256) REFERENCES public.blobs(sha256) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_model_id_applied_item_id_fkey FOREIGN KEY (model_id, applied_item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_model_id_applied_version_id_fkey FOREIGN KEY (model_id, applied_version_id) REFERENCES public.asset_versions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_model_id_duplicate_of_version_id_fkey FOREIGN KEY (model_id, duplicate_of_version_id) REFERENCES public.asset_versions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_model_id_from_version_id_fkey FOREIGN KEY (model_id, from_version_id) REFERENCES public.asset_versions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_model_id_group_id_fkey FOREIGN KEY (model_id, group_id) REFERENCES public.inbox_groups(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_model_id_source_revision_id_fkey FOREIGN KEY (model_id, source_revision_id) REFERENCES public.source_revisions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_model_id_target_asset_id_fkey FOREIGN KEY (model_id, target_asset_id) REFERENCES public.assets(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_model_id_target_item_id_fkey FOREIGN KEY (model_id, target_item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_model_id_web_upload_id_fkey FOREIGN KEY (model_id, web_upload_id) REFERENCES public.web_uploads(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_drafts
    ADD CONSTRAINT inbox_drafts_source_blob_sha256_fkey FOREIGN KEY (source_blob_sha256) REFERENCES public.blobs(sha256) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_groups
    ADD CONSTRAINT inbox_groups_model_id_custom_order_id_fkey FOREIGN KEY (model_id, custom_order_id) REFERENCES public.custom_orders(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_groups
    ADD CONSTRAINT inbox_groups_model_id_folder_object_id_fkey FOREIGN KEY (model_id, folder_object_id) REFERENCES public.source_objects(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.inbox_groups
    ADD CONSTRAINT inbox_groups_model_id_source_id_fkey FOREIGN KEY (model_id, source_id) REFERENCES public.sources(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.item_memberships
    ADD CONSTRAINT item_memberships_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.item_memberships
    ADD CONSTRAINT item_memberships_model_id_asset_id_pinned_version_id_fkey FOREIGN KEY (model_id, asset_id, pinned_version_id) REFERENCES public.asset_versions(model_id, asset_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.item_memberships
    ADD CONSTRAINT item_memberships_model_id_asset_id_variant_no_fkey FOREIGN KEY (model_id, asset_id, variant_no) REFERENCES public.assets(model_id, id, variant_no) ON DELETE RESTRICT;

ALTER TABLE ONLY public.item_memberships
    ADD CONSTRAINT item_memberships_model_id_item_id_item_type_fkey FOREIGN KEY (model_id, item_id, item_type) REFERENCES public.content_items(model_id, id, type) ON DELETE RESTRICT;

ALTER TABLE ONLY public.item_tags
    ADD CONSTRAINT item_tags_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.item_tags
    ADD CONSTRAINT item_tags_model_id_item_id_fkey FOREIGN KEY (model_id, item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.item_tags
    ADD CONSTRAINT item_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_model_id_parse_work_id_fkey FOREIGN KEY (model_id, parse_work_id) REFERENCES public.work_operations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_model_id_resolved_alias_id_fkey FOREIGN KEY (model_id, resolved_alias_id) REFERENCES public.aliases(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_model_id_resolved_asset_id_resolved_version__fkey FOREIGN KEY (model_id, resolved_asset_id, resolved_version_id) REFERENCES public.asset_versions(model_id, asset_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_model_id_resolved_evidence_id_fkey FOREIGN KEY (model_id, resolved_evidence_id) REFERENCES public.placement_evidence(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_model_id_resolved_item_id_fkey FOREIGN KEY (model_id, resolved_item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_model_id_resolved_order_id_fkey FOREIGN KEY (model_id, resolved_order_id) REFERENCES public.custom_orders(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_model_id_source_object_id_fkey FOREIGN KEY (model_id, source_object_id) REFERENCES public.source_objects(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_model_id_source_revision_id_fkey FOREIGN KEY (model_id, source_revision_id) REFERENCES public.source_revisions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_model_id_superseded_by_id_fkey FOREIGN KEY (model_id, superseded_by_id) REFERENCES public.legacy_claims(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_claims
    ADD CONSTRAINT legacy_claims_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_number_claims
    ADD CONSTRAINT legacy_number_claims_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_number_claims
    ADD CONSTRAINT legacy_number_claims_model_id_claim_id_fkey FOREIGN KEY (model_id, claim_id) REFERENCES public.legacy_claims(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_number_claims
    ADD CONSTRAINT legacy_number_claims_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_number_claims
    ADD CONSTRAINT legacy_number_claims_model_id_registry_claim_id_fkey FOREIGN KEY (model_id, registry_claim_id) REFERENCES public.legacy_claims(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_number_claims
    ADD CONSTRAINT legacy_number_claims_model_id_source_object_id_fkey FOREIGN KEY (model_id, source_object_id) REFERENCES public.source_objects(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.legacy_number_claims
    ADD CONSTRAINT legacy_number_claims_model_id_target_item_id_fkey FOREIGN KEY (model_id, target_item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.master_checks
    ADD CONSTRAINT master_checks_work_id_fkey FOREIGN KEY (work_id) REFERENCES public.work_operations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placement_assets
    ADD CONSTRAINT placement_assets_bound_by_fkey FOREIGN KEY (bound_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placement_assets
    ADD CONSTRAINT placement_assets_model_id_asset_id_asset_version_id_fkey FOREIGN KEY (model_id, asset_id, asset_version_id) REFERENCES public.asset_versions(model_id, asset_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placement_assets
    ADD CONSTRAINT placement_assets_model_id_placement_id_fkey FOREIGN KEY (model_id, placement_id) REFERENCES public.placements(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placement_assets
    ADD CONSTRAINT placement_assets_model_id_receipt_entry_id_fkey FOREIGN KEY (model_id, receipt_entry_id) REFERENCES public.download_receipt_entries(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placement_evidence
    ADD CONSTRAINT placement_evidence_model_id_hub_observation_id_fkey FOREIGN KEY (model_id, hub_observation_id) REFERENCES public.hub_observations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placement_evidence
    ADD CONSTRAINT placement_evidence_model_id_legacy_claim_id_fkey FOREIGN KEY (model_id, legacy_claim_id) REFERENCES public.legacy_claims(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placement_evidence
    ADD CONSTRAINT placement_evidence_model_id_matched_asset_id_matched_versi_fkey FOREIGN KEY (model_id, matched_asset_id, matched_version_id) REFERENCES public.asset_versions(model_id, asset_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placement_evidence
    ADD CONSTRAINT placement_evidence_model_id_placement_id_corrects_id_fkey FOREIGN KEY (model_id, placement_id, corrects_id) REFERENCES public.placement_evidence(model_id, placement_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placement_evidence
    ADD CONSTRAINT placement_evidence_model_id_placement_id_fkey FOREIGN KEY (model_id, placement_id) REFERENCES public.placements(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placement_evidence
    ADD CONSTRAINT placement_evidence_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT placements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT placements_model_id_account_id_surface_id_fkey FOREIGN KEY (model_id, account_id, surface_id) REFERENCES public.surfaces(model_id, account_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT placements_model_id_item_id_item_type_fkey FOREIGN KEY (model_id, item_id, item_type) REFERENCES public.content_items(model_id, id, type) ON DELETE RESTRICT;

ALTER TABLE ONLY public.placements
    ADD CONSTRAINT placements_model_id_plan_row_id_fkey FOREIGN KEY (model_id, plan_row_id) REFERENCES public.posting_plan_rows(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.platform_texts
    ADD CONSTRAINT platform_texts_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.platform_texts
    ADD CONSTRAINT platform_texts_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.platform_texts
    ADD CONSTRAINT platform_texts_model_id_item_id_fkey FOREIGN KEY (model_id, item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.platform_texts
    ADD CONSTRAINT platform_texts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.policy_settings
    ADD CONSTRAINT policy_settings_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.policy_settings
    ADD CONSTRAINT policy_settings_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.policy_settings
    ADD CONSTRAINT policy_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.posting_plan_rows
    ADD CONSTRAINT posting_plan_rows_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.posting_plan_rows
    ADD CONSTRAINT posting_plan_rows_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.posting_plan_rows
    ADD CONSTRAINT posting_plan_rows_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.posting_plan_rows
    ADD CONSTRAINT posting_plan_rows_marked_by_fkey FOREIGN KEY (marked_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.posting_plan_rows
    ADD CONSTRAINT posting_plan_rows_model_id_account_id_surface_id_fkey FOREIGN KEY (model_id, account_id, surface_id) REFERENCES public.surfaces(model_id, account_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.posting_plan_rows
    ADD CONSTRAINT posting_plan_rows_model_id_input_manifest_id_fkey FOREIGN KEY (model_id, input_manifest_id) REFERENCES public.asset_manifests(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.posting_plan_rows
    ADD CONSTRAINT posting_plan_rows_model_id_item_id_fkey FOREIGN KEY (model_id, item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.posting_plan_rows
    ADD CONSTRAINT posting_plan_rows_model_id_manifest_id_fkey FOREIGN KEY (model_id, manifest_id) REFERENCES public.asset_manifests(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.posting_plan_rows
    ADD CONSTRAINT posting_plan_rows_model_id_marked_manifest_id_fkey FOREIGN KEY (model_id, marked_manifest_id) REFERENCES public.asset_manifests(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.posting_plan_rows
    ADD CONSTRAINT posting_plan_rows_model_id_release_id_item_id_fkey FOREIGN KEY (model_id, release_id, item_id) REFERENCES public.ppv_releases(model_id, id, item_id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.ppv_releases
    ADD CONSTRAINT ppv_releases_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.ppv_releases
    ADD CONSTRAINT ppv_releases_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.ppv_releases
    ADD CONSTRAINT ppv_releases_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.ppv_releases
    ADD CONSTRAINT ppv_releases_model_id_item_id_item_type_fkey FOREIGN KEY (model_id, item_id, item_type) REFERENCES public.content_items(model_id, id, type) ON DELETE RESTRICT;

ALTER TABLE ONLY public.principal_grants
    ADD CONSTRAINT principal_grants_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.principal_grants
    ADD CONSTRAINT principal_grants_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.principal_grants
    ADD CONSTRAINT principal_grants_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.promo_channels
    ADD CONSTRAINT promo_channels_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.promo_deliveries
    ADD CONSTRAINT promo_deliveries_model_id_channel_id_fkey FOREIGN KEY (model_id, channel_id) REFERENCES public.promo_channels(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.promo_deliveries
    ADD CONSTRAINT promo_deliveries_model_id_contractor_id_fkey FOREIGN KEY (model_id, contractor_id) REFERENCES public.contractors(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.promo_deliveries
    ADD CONSTRAINT promo_deliveries_model_id_corrects_id_fkey FOREIGN KEY (model_id, corrects_id) REFERENCES public.promo_deliveries(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.promo_deliveries
    ADD CONSTRAINT promo_deliveries_model_id_manifest_id_fkey FOREIGN KEY (model_id, manifest_id) REFERENCES public.asset_manifests(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.promo_deliveries
    ADD CONSTRAINT promo_deliveries_model_id_receipt_id_fkey FOREIGN KEY (model_id, receipt_id) REFERENCES public.download_receipts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.promo_deliveries
    ADD CONSTRAINT promo_deliveries_package_fkey FOREIGN KEY (model_id, package_item_id, package_item_type) REFERENCES public.content_items(model_id, id, type) ON DELETE RESTRICT;

ALTER TABLE ONLY public.promo_deliveries
    ADD CONSTRAINT promo_deliveries_prepared_by_fkey FOREIGN KEY (prepared_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.promo_deliveries
    ADD CONSTRAINT promo_deliveries_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.provenance
    ADD CONSTRAINT provenance_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.provenance
    ADD CONSTRAINT provenance_model_id_child_item_id_fkey FOREIGN KEY (model_id, child_item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.provenance
    ADD CONSTRAINT provenance_model_id_child_version_id_fkey FOREIGN KEY (model_id, child_version_id) REFERENCES public.asset_versions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.provenance
    ADD CONSTRAINT provenance_model_id_parent_item_id_fkey FOREIGN KEY (model_id, parent_item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.provenance
    ADD CONSTRAINT provenance_model_id_parent_version_id_fkey FOREIGN KEY (model_id, parent_version_id) REFERENCES public.asset_versions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.provenance
    ADD CONSTRAINT provenance_model_id_voided_by_id_fkey FOREIGN KEY (model_id, voided_by_id) REFERENCES public.provenance(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.provenance
    ADD CONSTRAINT provenance_model_id_work_id_fkey FOREIGN KEY (model_id, work_id) REFERENCES public.work_operations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.rendition_artifacts
    ADD CONSTRAINT rendition_artifacts_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES public.rendition_generations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.rendition_generations
    ADD CONSTRAINT rendition_generations_work_id_fkey FOREIGN KEY (work_id) REFERENCES public.work_operations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.review_cases
    ADD CONSTRAINT review_cases_counterpart_model_id_fkey FOREIGN KEY (counterpart_model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.review_cases
    ADD CONSTRAINT review_cases_model_id_draft_id_fkey FOREIGN KEY (model_id, draft_id) REFERENCES public.inbox_drafts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.review_cases
    ADD CONSTRAINT review_cases_model_id_item_id_fkey FOREIGN KEY (model_id, item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.review_cases
    ADD CONSTRAINT review_cases_model_id_source_object_id_fkey FOREIGN KEY (model_id, source_object_id) REFERENCES public.source_objects(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.review_cases
    ADD CONSTRAINT review_cases_model_id_version_id_fkey FOREIGN KEY (model_id, version_id) REFERENCES public.asset_versions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.review_cases
    ADD CONSTRAINT review_cases_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_replaced_by_id_fkey FOREIGN KEY (replaced_by_id) REFERENCES public.sessions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.source_objects
    ADD CONSTRAINT source_objects_model_id_archive_revision_id_fkey FOREIGN KEY (model_id, archive_revision_id) REFERENCES public.source_revisions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.source_objects
    ADD CONSTRAINT source_objects_model_id_id_current_revision_id_fkey FOREIGN KEY (model_id, id, current_revision_id) REFERENCES public.source_revisions(model_id, source_object_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.source_objects
    ADD CONSTRAINT source_objects_model_id_parent_id_fkey FOREIGN KEY (model_id, parent_id) REFERENCES public.source_objects(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.source_objects
    ADD CONSTRAINT source_objects_model_id_source_id_fkey FOREIGN KEY (model_id, source_id) REFERENCES public.sources(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.source_paths
    ADD CONSTRAINT source_paths_model_id_source_object_id_fkey FOREIGN KEY (model_id, source_object_id) REFERENCES public.source_objects(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.source_revisions
    ADD CONSTRAINT source_revisions_model_id_frozen_by_work_id_fkey FOREIGN KEY (model_id, frozen_by_work_id) REFERENCES public.work_operations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.source_revisions
    ADD CONSTRAINT source_revisions_model_id_previous_id_fkey FOREIGN KEY (model_id, previous_id) REFERENCES public.source_revisions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.source_revisions
    ADD CONSTRAINT source_revisions_model_id_scan_work_id_fkey FOREIGN KEY (model_id, scan_work_id) REFERENCES public.work_operations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.source_revisions
    ADD CONSTRAINT source_revisions_model_id_source_object_id_fkey FOREIGN KEY (model_id, source_object_id) REFERENCES public.source_objects(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.surfaces
    ADD CONSTRAINT surfaces_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_merged_into_tag_id_fkey FOREIGN KEY (merged_into_tag_id) REFERENCES public.tags(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.web_uploads
    ADD CONSTRAINT web_uploads_model_id_plan_row_id_fkey FOREIGN KEY (model_id, plan_row_id) REFERENCES public.posting_plan_rows(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.web_uploads
    ADD CONSTRAINT web_uploads_model_id_target_item_id_fkey FOREIGN KEY (model_id, target_item_id) REFERENCES public.content_items(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.web_uploads
    ADD CONSTRAINT web_uploads_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.web_uploads
    ADD CONSTRAINT web_uploads_sha256_fkey FOREIGN KEY (sha256) REFERENCES public.blobs(sha256) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_generation_id_fkey FOREIGN KEY (generation_id) REFERENCES public.rendition_generations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_model_id_asset_version_id_fkey FOREIGN KEY (model_id, asset_version_id) REFERENCES public.asset_versions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_model_id_draft_id_fkey FOREIGN KEY (model_id, draft_id) REFERENCES public.inbox_drafts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_model_id_manifest_id_fkey FOREIGN KEY (model_id, manifest_id) REFERENCES public.asset_manifests(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_model_id_receipt_id_fkey FOREIGN KEY (model_id, receipt_id) REFERENCES public.download_receipts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_model_id_source_revision_id_fkey FOREIGN KEY (model_id, source_revision_id) REFERENCES public.source_revisions(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_output_sha256_fkey FOREIGN KEY (output_sha256) REFERENCES public.blobs(sha256) ON DELETE RESTRICT;

REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO contentops_app;

GRANT SELECT,INSERT ON TABLE public.asset_versions TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.inbox_drafts TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.web_uploads TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.work_operations TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.aliases TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.chronology_entries TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.content_items TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_memberships TO contentops_app;

GRANT SELECT,INSERT ON TABLE public.asset_manifest_entries TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.assets TO contentops_app;

GRANT SELECT,INSERT ON TABLE public.custom_order_deliveries TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.accounts TO contentops_app;

GRANT SELECT,INSERT ON TABLE public.action_log TO contentops_app;

GRANT SELECT,USAGE ON SEQUENCE public.action_log_id_seq TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.annotation_fields TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.api_tokens TO contentops_app;

GRANT SELECT,INSERT ON TABLE public.asset_manifests TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.blob_phashes TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.blob_probes TO contentops_app;

GRANT SELECT,INSERT,UPDATE ON TABLE public.blobs TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.custom_orders TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_tags TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.promo_channels TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provenance TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.rendition_generations TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_revisions TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tags TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.catalog_index TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.contractors TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.custom_order_messages TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.custom_order_revisions TO contentops_app;

GRANT SELECT,INSERT ON TABLE public.download_receipt_entries TO contentops_app;

GRANT SELECT,INSERT ON TABLE public.download_receipts TO contentops_app;

GRANT SELECT,INSERT ON TABLE public.hub_observations TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hub_post_attachments TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hub_posts TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hub_raw_media TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hub_sync_state TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hub_vault_albums TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.hub_vault_media TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.id_counters TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.idempotency_keys TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.inbox_draft_candidates TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.inbox_groups TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.legacy_claims TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.legacy_number_claims TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.master_checks TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.models TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pipeline_versions TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.placement_assets TO contentops_app;

GRANT SELECT,INSERT ON TABLE public.placement_evidence TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.placements TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.platform_texts TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.policy_settings TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.posting_plan_rows TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ppv_releases TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.principal_grants TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.principals TO contentops_app;

GRANT SELECT,INSERT,UPDATE ON TABLE public.promo_deliveries TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.rendition_artifacts TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.review_cases TO contentops_app;

GRANT SELECT ON TABLE public.schema_migrations TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sessions TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_objects TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_paths TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sources TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.storage_operations TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.surfaces TO contentops_app;

ALTER DEFAULT PRIVILEGES FOR ROLE contentops_migrate IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO contentops_app;

ALTER DEFAULT PRIVILEGES FOR ROLE contentops_migrate IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO contentops_app;
