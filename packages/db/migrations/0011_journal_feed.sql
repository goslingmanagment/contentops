-- 0011_journal_feed: the journal without the work queue's own rows (DESIGN §4.18).
--
-- The runner writes a `work.<outcome>` action row for every attempt of every work (schema §9.3):
-- 1.25 million `work.deferred` alone in the first days of the pilot, against a few hundred rows
-- of what people, agents and the import did. The feed of a model and the «История» of an object
-- show those few by default; this index holds only them, so a page reads tens of rows instead of
-- the whole journal. The predicate is the literal of `SERVICE_ACTION_PATTERN`
-- (`apps/server/src/journal/describe.ts`) — the query must say it the same way.
CREATE INDEX action_log_feed ON action_log (model_id, at DESC, id DESC)
  WHERE entry_kind = 'action' AND action NOT LIKE 'work.%';
