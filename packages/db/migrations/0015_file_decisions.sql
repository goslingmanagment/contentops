-- 0015_file_decisions: a file accepted before can be decided again from its object (SPEC §6.1,
-- §6.2): «Это копия <файл>» makes its draft a duplicate alias of the original, «Не контент»
-- a refusal with its reason. Found by the repair of the catalog of 05.11.2026: the agents turned
-- this trigger off in their own transactions.
--
-- Only these two commands may do it (`app.action` of the journal context is the route), and only
-- after the file has left its object: the draft of a file still in the catalog stays accepted.
-- Everything else is as before: a resolved draft reopens only from `rejected`, into `ready`, and
-- only while its bytes are present.
CREATE OR REPLACE FUNCTION inbox_draft_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'resolved'
     AND (NEW.state, NEW.outcome) IS DISTINCT FROM (OLD.state, OLD.outcome) THEN
    IF OLD.outcome IN ('new_item', 'append') AND NEW.state = 'resolved'
       AND NEW.outcome IN ('alias', 'rejected')
       AND current_setting('app.action', true) IN ('objectFiles.copyOf', 'objectFiles.notContent')
       AND NOT EXISTS (
         SELECT 1 FROM asset_versions v
           JOIN item_memberships m ON m.model_id = v.model_id AND m.asset_id = v.asset_id
          WHERE v.model_id = OLD.model_id AND v.id = OLD.applied_version_id
            AND m.kind = 'owned' AND m.removed_at IS NULL) THEN
      RETURN NEW;
    END IF;
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
