-- 0024_shooting_tasks: «Съёмка › ТЗ» (products plan 15.11.2026 §2.4, package C3). A task for the model
-- that is not a fan's order — a set, a batch of FYP — with a deadline and a hand-in. Kept here: a fan's
-- custom order lives in Agency Hub (its tab «Кастомы» reads Hub), a task of the content plan does not.
-- One new table: the previous image never names it.
--
--   kind          set — a photo set; fyp — a batch for the For You page; other — anything else;
--   deadline_on   until when, by Moscow; null — no date;
--   handed_in_at  the model handed it in (a person said so here); null — still waited for;
--   cancelled_at  dropped; it stays in the history.
CREATE TABLE shooting_tasks (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind IN ('set', 'fyp', 'other')),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  deadline_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES principals (id) ON DELETE RESTRICT,
  handed_in_at timestamptz,
  handed_in_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, id),
  CONSTRAINT shooting_tasks_handed_in CHECK ((handed_in_at IS NULL) = (handed_in_by IS NULL)),
  CONSTRAINT shooting_tasks_cancelled CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE INDEX shooting_tasks_open ON shooting_tasks (model_id, deadline_on)
  WHERE handed_in_at IS NULL AND cancelled_at IS NULL;

-- A task is the people's own record: every change is in the journal, as a plan row's.
CREATE TRIGGER shooting_tasks_journal AFTER INSERT OR UPDATE OR DELETE ON shooting_tasks
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
