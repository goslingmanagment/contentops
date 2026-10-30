-- 0001_foundation: the 13 tables of stage 1 (schema §9.5) and the runner's ledger.
--
-- Runs as `contentops_migrate` inside one transaction together with its
-- `schema_migrations` row. The roles `contentops_migrate` (owns the database and the
-- schema, DDL) and `contentops_app` (DML) are created by the host script, not here:
-- `CREATE ROLE` would fail on the second run in the same cluster.
-- Value lists are text + CHECK; the same lists live in `src/values.ts`.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO contentops_app;

-- Every table of this and later migrations gets DML for the app role; append-only
-- tables revoke UPDATE and DELETE in the migration that creates them.
ALTER DEFAULT PRIVILEGES FOR ROLE contentops_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO contentops_app;
ALTER DEFAULT PRIVILEGES FOR ROLE contentops_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO contentops_app;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- True when a JSON document carries a secret under a well-known key at any depth.
-- Guards `action_log` and `idempotency_keys`: secrets are never written there.
CREATE FUNCTION jsonb_has_secret(doc jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN doc IS NOT NULL AND jsonb_path_exists(
    doc,
    'strict $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "^(password|password_hash|token|token_hash|secret|cookie|set-cookie|authorization)$" flag "i")',
    '{}',
    true
  );

-- Append-only tables and frozen rows: any UPDATE or DELETE is an error.
CREATE FUNCTION forbid_update_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on %: rows are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'CO002';
END
$$;

-- Columns named in the trigger arguments never change: forbid_change('model_id', 'type').
CREATE FUNCTION forbid_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
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

-- Journal trigger (schema §9.3). The transaction must carry its context:
--   SET LOCAL app.actor_type / app.actor_id / app.actor_label / app.action / app.request_id
--   (+ optional app.item_id, app.work_id); `app.actor_id` may be empty only for `system`.
-- INSERT and DELETE log the whole row, UPDATE only the keys that changed plus the row key
-- (trigger arguments). Technical marks alone are not logged; secrets are never logged.
CREATE FUNCTION log_row_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
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

-- ---------------------------------------------------------------------------
-- Model and access (schema §3.1)
-- ---------------------------------------------------------------------------

CREATE TABLE models (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  code text NOT NULL UNIQUE
    CONSTRAINT models_code_format CHECK (code ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  title text NOT NULL,
  title_genitive text NOT NULL,
  timezone text NOT NULL DEFAULT 'Europe/Moscow',
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT models_code_reserved CHECK (code NOT IN ('admin', 'auth'))
);

CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  kind text NOT NULL CHECK (kind IN ('human', 'agent')),
  login text NOT NULL UNIQUE
    CONSTRAINT principals_login_format CHECK (login ~ '^[a-z0-9][a-z0-9._-]*$'),
  display_name text NOT NULL,
  gender text CHECK (gender IN ('f', 'm')),
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'reader')),
  password_hash text,
  ui_skin text NOT NULL DEFAULT 'blue' CHECK (ui_skin IN ('blue', 'focus')),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT principals_password_humans_only CHECK (password_hash IS NULL OR kind = 'human'),
  CONSTRAINT principals_gender_of_humans CHECK (gender IS NOT NULL OR kind = 'agent')
);

CREATE TABLE accounts (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7(),
  code text NOT NULL UNIQUE
    CONSTRAINT accounts_code_format CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  platform text NOT NULL CHECK (platform IN ('fansly', 'onlyfans')),
  title text NOT NULL,
  handle text NOT NULL,
  position integer NOT NULL,
  hub_page_ref text UNIQUE,
  week_norm jsonb CONSTRAINT accounts_week_norm_object
    CHECK (week_norm IS NULL OR jsonb_typeof(week_norm) = 'object'),
  default_assignee_id uuid REFERENCES principals (id) ON DELETE RESTRICT,
  default_uniq_level text CHECK (default_uniq_level IN ('soft', 'trim', 'mirror')),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, code)
);

CREATE TABLE surfaces (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('wall', 'fyp', 'story', 'vault', 'mass_dm')),
  auto_match boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  UNIQUE (account_id, kind),
  -- Target of FK (model_id, account_id, surface_id): a surface always belongs to its page.
  UNIQUE (model_id, account_id, id),
  FOREIGN KEY (model_id, account_id) REFERENCES accounts (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT surfaces_auto_match_kind CHECK (auto_match = false OR kind IN ('wall', 'fyp', 'vault'))
);

CREATE TABLE promo_channels (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7(),
  code text NOT NULL
    CONSTRAINT promo_channels_code_format CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  UNIQUE (model_id, code)
);

-- Rights on a model; no rights on a page (SPEC §11.1). A historical grant stays a row.
CREATE TABLE principal_grants (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7(),
  principal_id uuid NOT NULL REFERENCES principals (id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  PRIMARY KEY (model_id, id)
);
CREATE UNIQUE INDEX principal_grants_live_key ON principal_grants (principal_id, model_id)
  WHERE revoked_at IS NULL;

-- Password sessions of people, 30 days (SPEC §12.0); only the SHA-256 of the token is stored.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  principal_id uuid NOT NULL REFERENCES principals (id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CONSTRAINT sessions_token_hash_sha256
    CHECK (octet_length(token_hash) = 32),
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  replaced_by_id uuid REFERENCES sessions (id) ON DELETE RESTRICT
);

-- Bearer tokens of agents: shown once, only the SHA-256 is stored.
CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  principal_id uuid NOT NULL REFERENCES principals (id) ON DELETE RESTRICT,
  name text NOT NULL,
  token_hash bytea NOT NULL UNIQUE CONSTRAINT api_tokens_token_hash_sha256
    CHECK (octet_length(token_hash) = 32),
  token_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Background work (schema §3.4, §9.2). Targets of later stages (draft, revision,
-- version, manifest, receipt, generation) arrive with the migration of their tables.
-- ---------------------------------------------------------------------------

CREATE TABLE work_operations (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  model_id uuid REFERENCES models (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN (
    'scan', 'fetch', 'hash', 'unpack_archive', 'import_parse', 'register', 'propose',
    'export', 'hub_sync', 'hub_history', 'hub_publish', 'annotate', 'verify_blobs', 'backup',
    'derive_video', 'encode_master', 'verify_master', 'render', 'uniq_render',
    'render_compat', 'extract_frame', 'derive_image'
  )),
  work_key text NOT NULL,
  account_id uuid,
  dataset text,
  scope text,
  window_from timestamptz,
  window_to timestamptz,
  pipeline_version text,
  recipe_digest text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN (
    'pending', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'
  )),
  paused_reason text CONSTRAINT work_operations_paused_reason_format
    CHECK (paused_reason ~ '^switch_off:.+$'),
  priority integer NOT NULL DEFAULT 0,
  attempt_no integer NOT NULL DEFAULT 0 CONSTRAINT work_operations_attempt_no_check
    CHECK (attempt_no >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  fence_generation bigint NOT NULL DEFAULT 0,
  heartbeat_at timestamptz,
  input_sha256 bytea CONSTRAINT work_operations_input_sha256_check
    CHECK (octet_length(input_sha256) = 32),
  output_sha256 bytea CONSTRAINT work_operations_output_sha256_check
    CHECK (octet_length(output_sha256) = 32),
  output_ref text,
  progress_num bigint,
  progress_den bigint,
  progress_note text,
  checkpoint jsonb,
  failure_kind text CHECK (failure_kind IN ('transient', 'permanent')),
  error_code text,
  error_text text,
  report jsonb,
  stream_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- A repeated enqueue never creates a second work.
  CONSTRAINT work_operations_work_key UNIQUE NULLS NOT DISTINCT (model_id, kind, work_key),
  -- Target of composite references (model_id, work_id) from model tables.
  UNIQUE (model_id, id),
  FOREIGN KEY (model_id, account_id) REFERENCES accounts (model_id, id) ON DELETE RESTRICT,
  -- System-wide kinds have no model; everything else belongs to one.
  CONSTRAINT work_operations_global_kinds
    CHECK ((model_id IS NULL) = (kind IN ('verify_blobs', 'backup'))),
  -- A row without a model carries no model targets.
  CONSTRAINT work_operations_model_targets CHECK (model_id IS NOT NULL OR account_id IS NULL),
  CONSTRAINT work_operations_running_lease
    CHECK (state <> 'running' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT work_operations_finished_at
    CHECK ((state IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);
-- A stream (`hub:<account>:<dataset>`, `scan:<source>`, `backup`) has at most one unfinished row.
CREATE UNIQUE INDEX work_operations_stream_key ON work_operations (model_id, kind, stream_key)
  NULLS NOT DISTINCT
  WHERE stream_key IS NOT NULL AND state IN ('pending', 'running', 'retry_wait');
CREATE INDEX work_operations_due ON work_operations (next_attempt_at, priority)
  WHERE state IN ('pending', 'retry_wait');
CREATE INDEX work_operations_lease ON work_operations (lease_until)
  WHERE state = 'running';

-- Inputs never change; a success is final.
CREATE TRIGGER work_operations_inputs_fixed
  BEFORE UPDATE ON work_operations
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'kind', 'work_key', 'account_id', 'dataset', 'scope', 'window_from', 'window_to'
  );
CREATE TRIGGER work_operations_success_final
  BEFORE UPDATE OR DELETE ON work_operations
  FOR EACH ROW WHEN (OLD.state = 'succeeded') EXECUTE FUNCTION forbid_update_delete();

-- ---------------------------------------------------------------------------
-- Counters and settings
-- ---------------------------------------------------------------------------

-- Live ID counter (SPEC §4.1, §6.4): `next_number` is set by bootstrap; acceptance takes
-- `UPDATE … SET next_number = next_number + 1 RETURNING next_number - 1`.
CREATE TABLE id_counters (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  type text NOT NULL CHECK (type IN ('PPV', 'SET', 'SXT', 'CUS', 'FYP', 'LIFE', 'RAW', 'PRM')),
  next_number integer NOT NULL CHECK (next_number >= 1),
  legacy_reserved_at timestamptz,
  legacy_reserved_work_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, type),
  FOREIGN KEY (model_id, legacy_reserved_work_id) REFERENCES work_operations (model_id, id)
    ON DELETE RESTRICT
);

-- Thresholds of §13 and kill switches of SPEC §8. NULL model — a global row; SQL NULL value —
-- not set, i.e. off; JSON null is rejected. Priority and the switch rule — schema §9.2.
CREATE TABLE policy_settings (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  model_id uuid REFERENCES models (id) ON DELETE RESTRICT,
  account_id uuid,
  item_type text CHECK (item_type IN ('PPV', 'SET', 'SXT', 'CUS', 'FYP', 'LIFE', 'RAW', 'PRM')),
  key text NOT NULL,
  value jsonb CONSTRAINT policy_settings_value_not_json_null
    CHECK (value IS NULL OR jsonb_typeof(value) <> 'null'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  row_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT policy_settings_scope UNIQUE NULLS NOT DISTINCT (model_id, account_id, item_type, key),
  FOREIGN KEY (model_id, account_id) REFERENCES accounts (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT policy_settings_global_scope CHECK (model_id IS NOT NULL OR account_id IS NULL)
);

-- ---------------------------------------------------------------------------
-- Service tables (schema §3.9)
-- ---------------------------------------------------------------------------

-- Repeatable commands (SPEC §11.2). A response with a secret is not stored (`no_replay`).
CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  model_id uuid REFERENCES models (id) ON DELETE RESTRICT,
  principal_id uuid NOT NULL REFERENCES principals (id) ON DELETE RESTRICT,
  operation text NOT NULL,
  key text NOT NULL,
  request_digest bytea NOT NULL CONSTRAINT idempotency_keys_request_digest_sha256
    CHECK (octet_length(request_digest) = 32),
  state text NOT NULL CHECK (state IN ('committed', 'no_replay')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  UNIQUE (principal_id, operation, key),
  CONSTRAINT idempotency_keys_no_replay_response CHECK (state <> 'no_replay' OR response IS NULL),
  CONSTRAINT idempotency_keys_no_secrets CHECK (NOT jsonb_has_secret(response))
);

-- Who, what, with what, where and when (SPEC §4, §11.1). Insert only.
CREATE TABLE action_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  model_id uuid REFERENCES models (id) ON DELETE RESTRICT,
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  actor_id uuid REFERENCES principals (id) ON DELETE RESTRICT,
  actor_label text NOT NULL,
  action text NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN ('action', 'change')),
  item_id uuid,
  request_id text,
  work_id uuid REFERENCES work_operations (id) ON DELETE RESTRICT,
  subject_kind text NOT NULL,
  subject_id uuid,
  subject_label text NOT NULL,
  before jsonb,
  after jsonb,
  result text NOT NULL DEFAULT 'ok' CHECK (result IN ('ok', 'denied', 'error')),
  payload_version integer NOT NULL DEFAULT 1,
  CONSTRAINT action_log_actor_id CHECK (actor_id IS NOT NULL OR actor_type = 'system'),
  CONSTRAINT action_log_no_secrets
    CHECK (NOT jsonb_has_secret(before) AND NOT jsonb_has_secret(after))
);
CREATE INDEX action_log_at_brin ON action_log USING brin (at);
CREATE INDEX action_log_subject ON action_log (model_id, subject_kind, subject_id, at DESC);
CREATE INDEX action_log_model_at ON action_log (model_id, at DESC);
CREATE INDEX action_log_actor_at ON action_log (actor_id, at DESC);
-- «История» of an object reads only `action` rows.
CREATE INDEX action_log_item_history ON action_log (model_id, item_id, at DESC)
  WHERE entry_kind = 'action';

CREATE TRIGGER action_log_append_only
  BEFORE UPDATE OR DELETE ON action_log
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- The runner's ledger: one row per applied file, in the same transaction as the file.
CREATE TABLE schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Immutable columns
-- ---------------------------------------------------------------------------

CREATE TRIGGER accounts_fixed BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id');
CREATE TRIGGER surfaces_fixed BEFORE UPDATE ON surfaces
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'account_id', 'kind');
CREATE TRIGGER promo_channels_fixed BEFORE UPDATE ON promo_channels
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id');
CREATE TRIGGER principal_grants_fixed BEFORE UPDATE ON principal_grants
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'principal_id');
CREATE TRIGGER id_counters_fixed BEFORE UPDATE ON id_counters
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'type');
CREATE TRIGGER policy_settings_fixed BEFORE UPDATE ON policy_settings
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'account_id', 'item_type', 'key');

-- ---------------------------------------------------------------------------
-- Journal: every mutable table except work, principals, sessions and tokens (schema §9.3)
-- ---------------------------------------------------------------------------

CREATE TRIGGER models_journal AFTER INSERT OR UPDATE OR DELETE ON models
  FOR EACH ROW EXECUTE FUNCTION log_row_change('id');
CREATE TRIGGER accounts_journal AFTER INSERT OR UPDATE OR DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER surfaces_journal AFTER INSERT OR UPDATE OR DELETE ON surfaces
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER promo_channels_journal AFTER INSERT OR UPDATE OR DELETE ON promo_channels
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER principal_grants_journal AFTER INSERT OR UPDATE OR DELETE ON principal_grants
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER id_counters_journal AFTER INSERT OR UPDATE OR DELETE ON id_counters
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'type');
CREATE TRIGGER policy_settings_journal AFTER INSERT OR UPDATE OR DELETE ON policy_settings
  FOR EACH ROW EXECUTE FUNCTION log_row_change('id');

-- ---------------------------------------------------------------------------
-- Append-only and ledger privileges of the app role
-- ---------------------------------------------------------------------------

REVOKE UPDATE, DELETE ON action_log FROM contentops_app;
REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM contentops_app;
