CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';

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
    CONSTRAINT work_operations_attempt_no_check CHECK ((attempt_no >= 0)),
    CONSTRAINT work_operations_failure_kind_check CHECK ((failure_kind = ANY (ARRAY['transient'::text, 'permanent'::text]))),
    CONSTRAINT work_operations_finished_at CHECK (((state = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) = (finished_at IS NOT NULL))),
    CONSTRAINT work_operations_global_kinds CHECK (((model_id IS NULL) = (kind = ANY (ARRAY['verify_blobs'::text, 'backup'::text])))),
    CONSTRAINT work_operations_input_sha256_check CHECK ((octet_length(input_sha256) = 32)),
    CONSTRAINT work_operations_kind_check CHECK ((kind = ANY (ARRAY['scan'::text, 'fetch'::text, 'hash'::text, 'unpack_archive'::text, 'import_parse'::text, 'register'::text, 'propose'::text, 'export'::text, 'hub_sync'::text, 'hub_history'::text, 'hub_publish'::text, 'annotate'::text, 'verify_blobs'::text, 'backup'::text, 'derive_video'::text, 'encode_master'::text, 'verify_master'::text, 'render'::text, 'uniq_render'::text, 'render_compat'::text, 'extract_frame'::text, 'derive_image'::text]))),
    CONSTRAINT work_operations_model_targets CHECK (((model_id IS NOT NULL) OR (account_id IS NULL))),
    CONSTRAINT work_operations_output_sha256_check CHECK ((octet_length(output_sha256) = 32)),
    CONSTRAINT work_operations_paused_reason_format CHECK ((paused_reason ~ '^switch_off:.+$'::text)),
    CONSTRAINT work_operations_running_lease CHECK (((state <> 'running'::text) OR ((lease_owner IS NOT NULL) AND (lease_until IS NOT NULL)))),
    CONSTRAINT work_operations_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'retry_wait'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

ALTER TABLE public.work_operations OWNER TO contentops_migrate;

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

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.id_counters
    ADD CONSTRAINT id_counters_pkey PRIMARY KEY (model_id, type);

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_principal_id_operation_key_key UNIQUE (principal_id, operation, key);

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_code_key UNIQUE (code);

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.policy_settings
    ADD CONSTRAINT policy_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.policy_settings
    ADD CONSTRAINT policy_settings_scope UNIQUE NULLS NOT DISTINCT (model_id, account_id, item_type, key);

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

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.surfaces
    ADD CONSTRAINT surfaces_account_id_kind_key UNIQUE (account_id, kind);

ALTER TABLE ONLY public.surfaces
    ADD CONSTRAINT surfaces_model_id_account_id_id_key UNIQUE (model_id, account_id, id);

ALTER TABLE ONLY public.surfaces
    ADD CONSTRAINT surfaces_pkey PRIMARY KEY (model_id, id);

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

CREATE UNIQUE INDEX principal_grants_live_key ON public.principal_grants USING btree (principal_id, model_id) WHERE (revoked_at IS NULL);

CREATE INDEX work_operations_due ON public.work_operations USING btree (next_attempt_at, priority) WHERE (state = ANY (ARRAY['pending'::text, 'retry_wait'::text]));

CREATE INDEX work_operations_lease ON public.work_operations USING btree (lease_until) WHERE (state = 'running'::text);

CREATE UNIQUE INDEX work_operations_stream_key ON public.work_operations USING btree (model_id, kind, stream_key) NULLS NOT DISTINCT WHERE ((stream_key IS NOT NULL) AND (state = ANY (ARRAY['pending'::text, 'running'::text, 'retry_wait'::text])));

CREATE TRIGGER accounts_fixed BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id');

CREATE TRIGGER accounts_journal AFTER INSERT OR DELETE OR UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER action_log_append_only BEFORE DELETE OR UPDATE ON public.action_log FOR EACH ROW EXECUTE FUNCTION public.forbid_update_delete();

CREATE TRIGGER id_counters_fixed BEFORE UPDATE ON public.id_counters FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'type');

CREATE TRIGGER id_counters_journal AFTER INSERT OR DELETE OR UPDATE ON public.id_counters FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'type');

CREATE TRIGGER models_journal AFTER INSERT OR DELETE OR UPDATE ON public.models FOR EACH ROW EXECUTE FUNCTION public.log_row_change('id');

CREATE TRIGGER policy_settings_fixed BEFORE UPDATE ON public.policy_settings FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'account_id', 'item_type', 'key');

CREATE TRIGGER policy_settings_journal AFTER INSERT OR DELETE OR UPDATE ON public.policy_settings FOR EACH ROW EXECUTE FUNCTION public.log_row_change('id');

CREATE TRIGGER principal_grants_fixed BEFORE UPDATE ON public.principal_grants FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'principal_id');

CREATE TRIGGER principal_grants_journal AFTER INSERT OR DELETE OR UPDATE ON public.principal_grants FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER promo_channels_fixed BEFORE UPDATE ON public.promo_channels FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id');

CREATE TRIGGER promo_channels_journal AFTER INSERT OR DELETE OR UPDATE ON public.promo_channels FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER surfaces_fixed BEFORE UPDATE ON public.surfaces FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'id', 'account_id', 'kind');

CREATE TRIGGER surfaces_journal AFTER INSERT OR DELETE OR UPDATE ON public.surfaces FOR EACH ROW EXECUTE FUNCTION public.log_row_change('model_id', 'id');

CREATE TRIGGER work_operations_inputs_fixed BEFORE UPDATE ON public.work_operations FOR EACH ROW EXECUTE FUNCTION public.forbid_change('model_id', 'kind', 'work_key', 'account_id', 'dataset', 'scope', 'window_from', 'window_to');

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

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.id_counters
    ADD CONSTRAINT id_counters_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.id_counters
    ADD CONSTRAINT id_counters_model_id_legacy_reserved_work_id_fkey FOREIGN KEY (model_id, legacy_reserved_work_id) REFERENCES public.work_operations(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.policy_settings
    ADD CONSTRAINT policy_settings_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.policy_settings
    ADD CONSTRAINT policy_settings_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.policy_settings
    ADD CONSTRAINT policy_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.principal_grants
    ADD CONSTRAINT principal_grants_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.principal_grants
    ADD CONSTRAINT principal_grants_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.principal_grants
    ADD CONSTRAINT principal_grants_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.promo_channels
    ADD CONSTRAINT promo_channels_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES public.principals(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_replaced_by_id_fkey FOREIGN KEY (replaced_by_id) REFERENCES public.sessions(id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.surfaces
    ADD CONSTRAINT surfaces_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_model_id_account_id_fkey FOREIGN KEY (model_id, account_id) REFERENCES public.accounts(model_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.work_operations
    ADD CONSTRAINT work_operations_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON DELETE RESTRICT;

REVOKE USAGE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.accounts TO contentops_app;

GRANT SELECT,INSERT ON TABLE public.action_log TO contentops_app;

GRANT SELECT,USAGE ON SEQUENCE public.action_log_id_seq TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.api_tokens TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.id_counters TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.idempotency_keys TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.models TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.policy_settings TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.principal_grants TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.principals TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.promo_channels TO contentops_app;

GRANT SELECT ON TABLE public.schema_migrations TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sessions TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.surfaces TO contentops_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.work_operations TO contentops_app;

ALTER DEFAULT PRIVILEGES FOR ROLE contentops_migrate IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO contentops_app;

ALTER DEFAULT PRIVILEGES FOR ROLE contentops_migrate IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO contentops_app;
