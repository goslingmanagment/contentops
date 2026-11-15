-- 0023_hub_people: people come from Agency Hub (products plan 15.11.2026 §4.1, package C1; SPEC §11.1).
-- No tables: the person's link to Hub lives on the principal. Nullable columns and one more role value:
-- the previous image reads and writes these tables as before (it never meets a «только кастомы» person
-- until someone signs in through the new image).
--
-- Hub is the home of people: a content manager or a person who leads customs signs in through Hub, and
-- ContentOps makes ITS person from Hub's answer, changes its role and models at every re-check and
-- closes it when Hub closes the person. Nobody types a second registry.
--
--   principals.hub_person_code — the person's code in Hub's registry (`people.code`): set — the person
--                                came from Hub, whose role and models are Hub's (the owner's «Люди и
--                                доступ» shows them and does not edit them); null — made here;
--   principals.hub_products    — the products Hub gives the person (`auth/me` `products`), as at the
--                                last answer: the frame's switcher draws them; null — not known yet;
--   principals.first_day_closed_at — the person closed «Первый день» on «Сегодня»: never shown again;
--   role `customs`             — «только кастомы»: a person who leads customs sees the custom orders
--                                and «Ждут вас» of their models, nothing else.
ALTER TABLE principals
  ADD COLUMN hub_person_code text
    CONSTRAINT principals_hub_person_code_format CHECK (hub_person_code ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  ADD COLUMN hub_products text[],
  ADD COLUMN first_day_closed_at timestamptz,
  ADD CONSTRAINT principals_hub_person_code_key UNIQUE (hub_person_code),
  ADD CONSTRAINT principals_hub_person_with_link
    CHECK (hub_person_code IS NULL OR hub_user_id IS NOT NULL);

ALTER TABLE principals DROP CONSTRAINT principals_role_check;
ALTER TABLE principals ADD CONSTRAINT principals_role_check
  CHECK (role IN ('owner', 'manager', 'reader', 'customs'));
