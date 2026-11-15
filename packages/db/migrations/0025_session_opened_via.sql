-- 0025_session_opened_via: how a session over Hub's grant was opened (package C4, review round 2 P3-6). One nullable
-- column: the previous image reads and writes sessions as before and never sees it.
--
--   sessions.opened_via — `hub`: the one-step sign-in through Hub (`/auth/hub/…`, the owner); `form`: ContentOps' own
--                         form asked Hub for the login and the password; `link`: «Придумайте пароль» of an
--                         invitation. Null — a password session of ContentOps' own (or one opened before this column).
--                         The profile names only the first «через хаб»: the others are a sign-in by password.
ALTER TABLE sessions
  ADD COLUMN opened_via text
    CONSTRAINT sessions_opened_via_check CHECK (opened_via IN ('hub', 'form', 'link'));
