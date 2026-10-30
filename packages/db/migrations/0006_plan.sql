-- 0006_plan: the posting plan of stage 4а (schema §3.5, §9.2, §9.5) — PPV releases and plan
-- rows with the publication fields, and the plan-row links of placements, receipts and uploads.
--
-- A plan row holds the three facts' first two: the slot (and what to post — a sealed
-- composition) and the KM mark; the third, evidence, lives on placements (SPEC §5). «Пропущена»,
-- «слишком рано», gaps against the norm are computed, never stored. Tasks of a day are rows by
-- date and assignee — there is no task table (SPEC §4). The one hard rule lives here, so that
-- an agent and a person meet it alike and a race cannot slip past it: an object with a second
-- person in frame, or not checked for one, never goes to OnlyFans (SPEC §7, schema §9.2).
-- Value lists are text + CHECK; the same lists live in `src/values.ts`.

-- ---------------------------------------------------------------------------
-- PPV releases (schema §3.5)
-- ---------------------------------------------------------------------------

-- A release of a PPV on one page: rows of the wall, the mass message, the story teaser and the
-- vault share it and are counted once against the norm. «Поставить выпуск» on several pages
-- makes one release per page in one command.
CREATE TABLE ppv_releases (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  account_id uuid NOT NULL,
  item_id uuid NOT NULL,
  -- Type copy (schema §9.2): only a PPV is released.
  item_type text NOT NULL DEFAULT 'PPV' CHECK (item_type = 'PPV'),
  -- In the model's timezone: the norm counts by it (a vault upload on Sunday is no release).
  release_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  -- Target of FK (model_id, release_id, item_id): a row of a release ships its object.
  UNIQUE (model_id, id, item_id),
  FOREIGN KEY (model_id, account_id) REFERENCES accounts (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, item_id, item_type) REFERENCES content_items (model_id, id, type)
    ON DELETE RESTRICT,
  CONSTRAINT ppv_releases_cancelled CHECK (cancelled_by IS NULL OR cancelled_at IS NOT NULL)
);
CREATE INDEX ppv_releases_page ON ppv_releases (model_id, account_id, release_date DESC);

-- ---------------------------------------------------------------------------
-- Plan rows (schema §3.5, §9.2)
-- ---------------------------------------------------------------------------

-- A row of the plan: object, page, surface, slot, assignee, the sealed composition, the KM
-- mark and the cancellation; for publishing through Hub (5б) — caption, Fansly audience (empty
-- tiers — subscribers), price, repeat flag and vault album name. A row waiting for a montage has
-- no object yet: the expected type and the composition of its sources. No uniqueness by slot:
-- two posts in one slot are shown as a conflict.
CREATE TABLE posting_plan_rows (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  item_id uuid,
  account_id uuid NOT NULL,
  surface_id uuid NOT NULL,
  slot_date date NOT NULL,
  -- NULL — «весь день»: missed at the end of the local day.
  slot_time time,
  -- Copied from `models.timezone`; `slot_at` is checked against it (trigger `posting_plan_rows_slot`).
  slot_tz text NOT NULL,
  slot_at timestamptz NOT NULL,
  -- Empty — the page's `default_assignee_id`; written only for «Передать другому».
  assignee_id uuid REFERENCES principals (id) ON DELETE RESTRICT,
  release_id uuid,
  release_surface_kind text CHECK (release_surface_kind IN ('wall', 'story', 'vault', 'mass_dm')),
  manifest_id uuid,
  -- The composition the mark refers to: «отметка относится к прежнему составу» when replaced.
  marked_manifest_id uuid,
  -- A row waiting for a montage (FYP or PPV from raw) or for the teaser of its own PPV.
  expected_type text CHECK (expected_type IN ('FYP', 'PPV')),
  expected_role text CONSTRAINT posting_plan_rows_expected_role CHECK (expected_role = 'teaser'),
  input_manifest_id uuid,
  -- A FYP on another page ships its unique version `uN` («Версии для Fansly 2, 3», SPEC §4);
  -- a version still being built leaves the composition empty until `uniq_render` seals it.
  uniq_variant_no integer CONSTRAINT posting_plan_rows_uniq_variant CHECK (uniq_variant_no > 0),
  marked_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  marked_at timestamptz,
  -- «выложено» / «в планировщике» (SPEC §5).
  mark_kind text CHECK (mark_kind IN ('posted', 'scheduled')),
  -- Stories and mass messages: when it went out, as the KM says.
  stated_occurred_at timestamptz,
  requires_new_upload boolean NOT NULL DEFAULT false,
  -- Publication through Hub (SPEC §4, §7; decision 29.10.2026).
  caption text,
  tier_refs text[],
  price_mills bigint CONSTRAINT posting_plan_rows_price CHECK (price_mills >= 0),
  repost boolean NOT NULL DEFAULT false,
  album_name text,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  -- Optional; `second_person` — the late flag cancelled the row (trigger below).
  cancel_reason text CHECK (cancel_reason IN ('late', 'replaced', 'paused', 'second_person')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  FOREIGN KEY (model_id, item_id) REFERENCES content_items (model_id, id) ON DELETE RESTRICT,
  -- The surface belongs to the page.
  FOREIGN KEY (model_id, account_id, surface_id) REFERENCES surfaces (model_id, account_id, id)
    ON DELETE RESTRICT,
  -- A row of a release ships the release's object; its page is checked by the slot trigger.
  FOREIGN KEY (model_id, release_id, item_id) REFERENCES ppv_releases (model_id, id, item_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, manifest_id) REFERENCES asset_manifests (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, marked_manifest_id) REFERENCES asset_manifests (model_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, input_manifest_id) REFERENCES asset_manifests (model_id, id)
    ON DELETE RESTRICT,
  -- A marked row is not cancelled; take the mark off first.
  CONSTRAINT posting_plan_rows_marked_cancelled CHECK (marked_at IS NULL OR cancelled_at IS NULL),
  CONSTRAINT posting_plan_rows_release_item CHECK (release_id IS NULL OR item_id IS NOT NULL),
  CONSTRAINT posting_plan_rows_release_kind
    CHECK ((release_id IS NULL) = (release_surface_kind IS NULL)),
  -- What the row ships: a composition, or what it waits for.
  CONSTRAINT posting_plan_rows_ships CHECK (
    manifest_id IS NOT NULL OR expected_type IS NOT NULL OR expected_role IS NOT NULL
    OR uniq_variant_no IS NOT NULL
  ),
  CONSTRAINT posting_plan_rows_object CHECK (item_id IS NOT NULL OR expected_type IS NOT NULL),
  CONSTRAINT posting_plan_rows_inputs
    CHECK (input_manifest_id IS NULL OR expected_type IS NOT NULL OR expected_role IS NOT NULL),
  -- A mark is the person, the time, the kind and the composition it refers to; raw is never
  -- posted, so a row still waiting is not marked.
  CONSTRAINT posting_plan_rows_mark CHECK (
    CASE WHEN marked_at IS NULL
      THEN num_nonnulls(marked_by, mark_kind, marked_manifest_id, stated_occurred_at) = 0
      ELSE num_nulls(marked_by, mark_kind, marked_manifest_id, manifest_id) = 0
    END
  ),
  CONSTRAINT posting_plan_rows_cancel CHECK (
    cancelled_at IS NOT NULL OR (cancelled_by IS NULL AND cancel_reason IS NULL)
  )
);
-- Tasks of a day: rows by date and assignee.
CREATE INDEX posting_plan_rows_tasks ON posting_plan_rows (model_id, assignee_id, slot_date);
-- Norm and gaps of a page.
CREATE INDEX posting_plan_rows_page ON posting_plan_rows (model_id, account_id, slot_at);
-- «Слишком рано», «уже в плане».
CREATE INDEX posting_plan_rows_item ON posting_plan_rows (model_id, item_id, slot_at DESC);
-- «Пропущена» is computed from these.
CREATE INDEX posting_plan_rows_open ON posting_plan_rows (model_id, slot_at)
  WHERE marked_at IS NULL AND cancelled_at IS NULL;
-- Rows waiting for a unique FYP version: `uniq_render` fills them when the version is built.
CREATE INDEX posting_plan_rows_uniq_waiting ON posting_plan_rows (model_id, item_id, uniq_variant_no)
  WHERE manifest_id IS NULL AND uniq_variant_no IS NOT NULL;
-- One live row per surface of a release.
CREATE UNIQUE INDEX posting_plan_rows_release_surface
  ON posting_plan_rows (model_id, release_id, release_surface_kind)
  WHERE release_id IS NOT NULL AND cancelled_at IS NULL;

-- The slot of a row (schema §9.2): `slot_tz` defaults to the model's timezone; `slot_at` is
-- `slot_date + slot_time` there (midnight for «весь день»). The command may leave it empty;
-- a value that disagrees is refused. A row of a release stays on its release's page and names
-- its own surface kind.
CREATE FUNCTION posting_plan_row_slot() RETURNS trigger
  LANGUAGE plpgsql AS $$
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

-- An object with a second person in frame, or not checked for one (legacy, empty flag), is
-- never put on OnlyFans: not by a new row, not by a moved row, not by replacing the composition,
-- not by inserting a ready montage (schema §9.2, §9.4). The row lock on the object serialises
-- with a late flag: whichever commits first, the other sees it.
CREATE FUNCTION posting_plan_row_second_person() RETURNS trigger
  LANGUAGE plpgsql AS $$
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

-- A late flag cancels the unmarked rows of the object on OnlyFans; marked rows stay as history
-- and show «нельзя на OnlyFans». The cancellation is journaled with the flag's actor.
CREATE FUNCTION content_item_second_person_late() RETURNS trigger
  LANGUAGE plpgsql AS $$
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

CREATE TRIGGER posting_plan_rows_slot
  BEFORE INSERT OR UPDATE OF slot_date, slot_time, slot_tz, slot_at, release_id, account_id, surface_id
  ON posting_plan_rows
  FOR EACH ROW EXECUTE FUNCTION posting_plan_row_slot();
CREATE TRIGGER posting_plan_rows_second_person
  BEFORE INSERT OR UPDATE OF item_id, manifest_id, account_id ON posting_plan_rows
  FOR EACH ROW EXECUTE FUNCTION posting_plan_row_second_person();
CREATE TRIGGER content_items_second_person_late
  AFTER UPDATE OF has_second_person ON content_items
  FOR EACH ROW WHEN (NEW.has_second_person IS TRUE AND OLD.has_second_person IS NOT TRUE)
  EXECUTE FUNCTION content_item_second_person_late();

-- ---------------------------------------------------------------------------
-- Plan-row links of placements, receipts and uploads (schema §3.4–3.6)
-- ---------------------------------------------------------------------------

-- The row a placement fulfils (a KM mark, «Отметить и подтвердить», a matched observation).
ALTER TABLE placements
  ADD COLUMN plan_row_id uuid,
  ADD FOREIGN KEY (model_id, plan_row_id) REFERENCES posting_plan_rows (model_id, id)
    ON DELETE RESTRICT;
CREATE INDEX placements_plan_row ON placements (model_id, plan_row_id) WHERE plan_row_id IS NOT NULL;

-- A receipt keeps its plan row and the name suffix: moving the slot later renames nothing.
ALTER TABLE download_receipts
  ADD COLUMN plan_row_id uuid,
  ADD FOREIGN KEY (model_id, plan_row_id) REFERENCES posting_plan_rows (model_id, id)
    ON DELETE RESTRICT;
CREATE INDEX download_receipts_plan_row ON download_receipts (model_id, plan_row_id)
  WHERE plan_row_id IS NOT NULL;

-- A montage uploaded for a row: the accepted FYP is put into this row (schema §3.5).
ALTER TABLE web_uploads
  ADD COLUMN plan_row_id uuid,
  ADD FOREIGN KEY (model_id, plan_row_id) REFERENCES posting_plan_rows (model_id, id)
    ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Fixed columns and the journal (schema §9.3, §9.4)
-- ---------------------------------------------------------------------------

CREATE TRIGGER ppv_releases_fixed BEFORE UPDATE ON ppv_releases
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'account_id', 'item_id', 'item_type');
CREATE TRIGGER posting_plan_rows_fixed BEFORE UPDATE ON posting_plan_rows
  FOR EACH ROW EXECUTE FUNCTION forbid_change(
    'model_id', 'id', 'release_id', 'release_surface_kind', 'created_at', 'created_by'
  );

CREATE TRIGGER ppv_releases_journal AFTER INSERT OR UPDATE OR DELETE ON ppv_releases
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER posting_plan_rows_journal AFTER INSERT OR UPDATE OR DELETE ON posting_plan_rows
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
