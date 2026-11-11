-- 0018_custom_copies: a copy of a custom outside the customs section (SPEC §6.2, §7; schema
-- §3.4, §9.5).
--
-- 10–11.11.2026 cuts of a fan's paid custom stood on a model's wall: the model had put a copy of
-- the custom, byte for byte, into `2. FYP`, and a FYP was cut from it. Decision of the owner
-- 11.11.2026: a custom and whatever is made from it never goes to the wall or FYP, and a copy
-- of a custom outside its section is seen the same day. The signal is a review case of its own
-- kind: one per custom and path (`dedup_key`), open until the owner says «Понятно»
-- (`dismissed`). Nothing else changes: the table holds it as it is.

ALTER TABLE review_cases DROP CONSTRAINT review_cases_kind_check;
ALTER TABLE review_cases ADD CONSTRAINT review_cases_kind_check
  CHECK (kind IN (
    'cross_model_duplicate', 'legacy_unparsed', 'merge_split', 'unreadable_input', 'smm_folder',
    'number_hole', 'custom_copy'
  ));
