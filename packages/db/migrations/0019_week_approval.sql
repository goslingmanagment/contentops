-- 0019_week_approval: the owner's «Утвердить неделю» on the plan rows (schema §3.5, §9.5; SPEC §7
-- «Публикация через Hub», §11.1; decision of the owner 11.11.2026). No tables: the stamp lives on
-- the row.
--
-- An agent sends free posts of a week the owner approved once; paid posts and prices still need
-- the owner every time. What is approved is the set of rows as the owner saw them: the stamp
-- names the row version he saw, any later edit (fields, composition, price, move, mark, cancel,
-- montage) bumps `row_version` and so leaves the row unapproved; stamping itself changes no
-- version. A stamp is good for one send: once Hub's publication of the row leaves the draft
-- (sent, cancelled, withdrawn) the stamp is cleared and the row needs the owner again.
--
--   approved_at       — when the owner approved the row (the latest «Утвердить неделю»);
--   approved_by       — the owner, a person;
--   approved_version  — the row version he saw: the row is approved while it equals
--                       `row_version`.
ALTER TABLE posting_plan_rows
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN approved_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  ADD COLUMN approved_version bigint
    CONSTRAINT posting_plan_rows_approved_version_positive CHECK (approved_version > 0),
  -- A stamp is the time, the person and the version together, or nothing.
  ADD CONSTRAINT posting_plan_rows_approval CHECK (
    num_nonnulls(approved_at, approved_by, approved_version) = 0
    OR num_nulls(approved_at, approved_by, approved_version) = 0
  );
