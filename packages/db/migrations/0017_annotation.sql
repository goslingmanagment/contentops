-- 0017_annotation: cloud markup (SPEC §8.3, §12.0 `VisionProvider`; schema §3.2, §9.5, §9.8;
-- PLAN 8а). Runs and suggestions of the models; links to the runs from the fields, the
-- chronology and the texts.
--
-- A run is one request to one provider about one object: what the frames of a version show
-- (`observe`), the fields from those facts (`aggregate`), the selling texts from the cleaned
-- summary (`texts`). It holds the reserve before the send, the cost after it and the facts of
-- its receipt (the receipt itself is a journal event without content). A new attempt is a new
-- row: after a failure without an answer (429, 5xx, a network error) the same input goes again,
-- after a refusal or an unknown outcome it never does.
--
-- Suggestions lie apart and reach a field only while the field is a draft of the version the
-- run saw (schema §1 p. 7): a late answer cannot overwrite what a person confirmed. Values,
-- versions, confirmations and provenance written before stay as they are: the new links are
-- empty for them, nothing is rewritten.

CREATE TABLE annotation_runs (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  item_id uuid NOT NULL,
  -- The master version whose frames were seen; empty for photos of several files.
  version_id uuid,
  stage text NOT NULL CHECK (stage IN ('observe', 'aggregate', 'texts')),
  -- The run whose output this one read: the observations of `aggregate`, the facts of `texts`.
  parent_run_id uuid,
  attempt smallint NOT NULL DEFAULT 1 CONSTRAINT annotation_runs_attempt_check CHECK (attempt >= 1),
  -- 0 — the route's provider, 1 — its one independent spare (SPEC §8.3).
  route_position smallint NOT NULL DEFAULT 0
    CONSTRAINT annotation_runs_route_position_check CHECK (route_position BETWEEN 0 AND 1),
  -- A run of the measurement (PLAN 8а): its suggestions are compared, never applied.
  probe boolean NOT NULL DEFAULT false,
  -- `PPV.observe` — the route `annotation.route.PPV.observe`; `probe` for the measurement.
  route text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic')),
  model_name text NOT NULL,
  prompt_version text NOT NULL,
  -- The media bytes the input comes from: the master, or the digest of the photos' masters.
  input_sha256 bytea NOT NULL CONSTRAINT annotation_runs_input_sha256_check
    CHECK (octet_length(input_sha256) = 32),
  -- Stage, provider and model, prompt and schema, the cleaned inputs, the frames sent, the
  -- dependent run: another description or other frames make another run.
  config_digest text NOT NULL,
  -- References only: the frame artifacts sent, the fields asked and their versions seen.
  params jsonb NOT NULL DEFAULT '{}',
  frames_count integer NOT NULL DEFAULT 0 CONSTRAINT annotation_runs_frames_count_check
    CHECK (frames_count >= 0),
  -- Frames left out before the send (unreadable, wrong size): never sent.
  withheld_count integer NOT NULL DEFAULT 0 CONSTRAINT annotation_runs_withheld_count_check
    CHECK (withheld_count >= 0),
  -- The account the money goes from: the reserve is taken under its lock.
  billing_scope text NOT NULL,
  state text NOT NULL DEFAULT 'running' CHECK (state IN (
    'queued', 'running', 'succeeded', 'partial', 'refused', 'failed', 'cancelled', 'blocked'
  )),
  reserved_usd numeric(12, 6) CONSTRAINT annotation_runs_reserved_usd_check
    CHECK (reserved_usd >= 0),
  cost_usd numeric(12, 6) CONSTRAINT annotation_runs_cost_usd_check CHECK (cost_usd >= 0),
  tokens jsonb,
  -- What was sent, without the content: its hash and size (the receipt, SPEC §8.3).
  request_sha256 bytea CONSTRAINT annotation_runs_request_sha256_check
    CHECK (octet_length(request_sha256) = 32),
  request_bytes integer CONSTRAINT annotation_runs_request_bytes_check CHECK (request_bytes >= 0),
  provider_request_id text,
  sent_at timestamptz,
  -- A timeout or a cut after the send: whether the provider did it is not known.
  outcome_unknown boolean NOT NULL DEFAULT false,
  error_code text,
  refusal_reason text,
  error text,
  -- A cleaned diagnostic envelope (status, stop reason, usage), never an echo of the input.
  raw_response jsonb,
  work_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (model_id, id),
  CONSTRAINT annotation_runs_input UNIQUE (model_id, item_id, input_sha256, config_digest, attempt),
  FOREIGN KEY (model_id, item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, version_id) REFERENCES asset_versions (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, parent_run_id) REFERENCES annotation_runs (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, work_id) REFERENCES work_operations (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT annotation_runs_finished CHECK (
    (state IN ('succeeded', 'partial', 'refused', 'failed', 'cancelled', 'blocked'))
      = (finished_at IS NOT NULL)
  ),
  -- A request in flight holds its reserve.
  CONSTRAINT annotation_runs_reserved CHECK (state <> 'running' OR reserved_usd IS NOT NULL),
  -- Nothing is paid, answered or unknown without a send.
  CONSTRAINT annotation_runs_sent CHECK (
    sent_at IS NOT NULL
    OR (cost_usd IS NULL AND provider_request_id IS NULL AND request_sha256 IS NULL
        AND NOT outcome_unknown)
  ),
  CONSTRAINT annotation_runs_request CHECK ((request_sha256 IS NULL) = (request_bytes IS NULL)),
  CONSTRAINT annotation_runs_refused CHECK ((state = 'refused') = (refusal_reason IS NOT NULL)),
  CONSTRAINT annotation_runs_unknown CHECK (NOT outcome_unknown OR state = 'failed'),
  CONSTRAINT annotation_runs_params_object CHECK (jsonb_typeof(params) = 'object')
);
-- The latest run of an object and stage: «черновик · ИИ», «не удалось» and the next stage.
CREATE INDEX annotation_runs_item ON annotation_runs (model_id, item_id, stage, created_at DESC);
-- Money of a window (`annotation.budget.since`) and the breaker of a provider.
CREATE INDEX annotation_runs_created ON annotation_runs (created_at);
CREATE INDEX annotation_runs_provider ON annotation_runs (provider, finished_at);

-- A suggestion of a run for one field, or the reason the service gave none. `observations` and
-- `facts` are the inputs of the next stages and never reach a field.
CREATE TABLE annotation_suggestions (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  run_id uuid NOT NULL,
  field text NOT NULL CHECK (field IN (
    'observations', 'facts', 'title', 'title_en', 'description', 'tags', 'chronology',
    'purpose', 'second_person', 'platform_texts'
  )),
  value jsonb CONSTRAINT annotation_suggestions_value_not_json_null
    CHECK (value IS NULL OR jsonb_typeof(value) <> 'null'),
  -- A refusal is a reason, never an empty value (SPEC §8.3).
  refusal_reason text,
  applied_at timestamptz,
  applied_value_version bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, id),
  CONSTRAINT annotation_suggestions_field UNIQUE (model_id, run_id, field),
  FOREIGN KEY (model_id, run_id) REFERENCES annotation_runs (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT annotation_suggestions_outcome CHECK ((value IS NULL) <> (refusal_reason IS NULL)),
  CONSTRAINT annotation_suggestions_applied CHECK (
    (applied_at IS NULL) = (applied_value_version IS NULL)
    AND (applied_at IS NULL OR value IS NOT NULL)
  )
);

CREATE TRIGGER annotation_runs_fixed BEFORE UPDATE ON annotation_runs
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'item_id', 'version_id', 'stage', 'parent_run_id', 'attempt',
    'route_position', 'probe', 'route', 'provider', 'model_name', 'prompt_version',
    'input_sha256', 'config_digest', 'billing_scope'
  );
CREATE TRIGGER annotation_suggestions_fixed BEFORE UPDATE ON annotation_suggestions
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'run_id', 'field', 'value', 'refusal_reason');

-- Links to the runs. Earlier rows keep them empty: their values, versions, confirmations and
-- sources are not touched.
ALTER TABLE annotation_fields
  ADD COLUMN suggested_by_run_id uuid,
  ADD CONSTRAINT annotation_fields_suggested_by_run_id_fkey
    FOREIGN KEY (model_id, suggested_by_run_id) REFERENCES annotation_runs (model_id, id)
    ON DELETE RESTRICT;
ALTER TABLE chronology_entries
  ADD COLUMN run_id uuid,
  ADD CONSTRAINT chronology_entries_run_id_fkey
    FOREIGN KEY (model_id, run_id) REFERENCES annotation_runs (model_id, id) ON DELETE RESTRICT;
ALTER TABLE platform_texts
  ADD COLUMN run_id uuid,
  ADD CONSTRAINT platform_texts_run_id_fkey
    FOREIGN KEY (model_id, run_id) REFERENCES annotation_runs (model_id, id) ON DELETE RESTRICT;
