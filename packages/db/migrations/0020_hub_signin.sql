-- 0020_hub_signin: «Войти через хаб» (SPEC §11.1; schema §3.1; ecosystem plan 12.11.2026, package
-- B3). No tables: the link of a person to Agency Hub lives on the principal, the hub's sign-in on
-- the session. Only nullable columns: the previous image reads and writes these tables as before.
--
-- A person signed in to the hub opens ContentOps without a second password: the hub tells this
-- server who the person is for a one-time code, and ContentOps opens its own session for the
-- principal linked to that hub person. The link is explicit (the configured owner, SPEC §11.1),
-- never by name.
--
--   principals.hub_user_id — the hub's id of the person (`users.id` there); one principal per
--                            hub person, people only;
--   principals.hub_login   — the hub's login of that person, for display; it follows the hub
--                            at every sign-in;
--   sessions.hub_grant     — the hub's opaque grant of a session opened through the hub: the
--                            server asks the hub with it whether the person is still signed in
--                            there (`sso/check`); null — a password session;
--   sessions.hub_checked_at — the hub's last answer «still signed in»: while the hub does not
--                            answer, the session lives on that answer for a bounded time.
ALTER TABLE principals
  ADD COLUMN hub_user_id bigint
    CONSTRAINT principals_hub_user_id_positive CHECK (hub_user_id > 0),
  ADD COLUMN hub_login text,
  ADD CONSTRAINT principals_hub_user_id_key UNIQUE (hub_user_id),
  ADD CONSTRAINT principals_hub_link_humans_only CHECK (hub_user_id IS NULL OR kind = 'human'),
  ADD CONSTRAINT principals_hub_login_with_link CHECK (hub_login IS NULL OR hub_user_id IS NOT NULL);

ALTER TABLE sessions
  ADD COLUMN hub_grant text,
  ADD COLUMN hub_checked_at timestamptz,
  ADD CONSTRAINT sessions_hub_checked_with_grant CHECK (hub_checked_at IS NULL OR hub_grant IS NOT NULL);
