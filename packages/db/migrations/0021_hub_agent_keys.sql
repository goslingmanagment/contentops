-- 0021_hub_agent_keys: one key for an agent (SPEC §11.1; schema §3.1; ecosystem plan 12.11.2026,
-- package M2). An agent may call ContentOps with its Agency Hub key instead of a token of ours: the
-- server asks the hub whose key it is (only the key's sha256, with ContentOps' own hub key holding
-- `introspect:agent_keys`) and acts as the local agent linked to that hub agent. Additions only:
-- the previous image reads and writes these tables as before and never looks at the new ones.
--
--   principals.hub_agent_code — the hub's code of the agent person (`gengar`) whose hub key acts as
--                               this agent principal; agents only, one principal per code. Set by
--                               the owner (`ops.js hub-agent`), never by name; null — no hub key
--                               acts as this agent;
--   hub_agent_calls           — every call made with a hub key, under the agent's code: what was
--                               asked, which principal acted, whether the hub's last answer was
--                               held while the hub did not answer. No key and no digest.
ALTER TABLE principals
  ADD COLUMN hub_agent_code text
    CONSTRAINT principals_hub_agent_code_format CHECK (hub_agent_code ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  ADD CONSTRAINT principals_hub_agent_code_key UNIQUE (hub_agent_code),
  ADD CONSTRAINT principals_hub_agent_code_agents_only
    CHECK (hub_agent_code IS NULL OR kind = 'agent');

CREATE TABLE hub_agent_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  agent_code text NOT NULL,
  principal_id uuid REFERENCES principals (id) ON DELETE RESTRICT,
  method text NOT NULL,
  url text NOT NULL,
  request_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'not_linked')),
  held boolean NOT NULL DEFAULT false,
  CONSTRAINT hub_agent_calls_principal_when_ok CHECK (outcome <> 'ok' OR principal_id IS NOT NULL)
);
CREATE INDEX hub_agent_calls_at_brin ON hub_agent_calls USING brin (at);
CREATE INDEX hub_agent_calls_agent_at ON hub_agent_calls (agent_code, at DESC);

CREATE TRIGGER hub_agent_calls_append_only
  BEFORE UPDATE OR DELETE ON hub_agent_calls
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
REVOKE UPDATE, DELETE ON hub_agent_calls FROM contentops_app;
