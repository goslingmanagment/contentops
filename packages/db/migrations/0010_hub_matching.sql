-- 0010_hub_matching: the surface of a placement may be a hint of Hub (SPEC §7, schema §9.6).
--
-- A post of the page's history or a post without plan bound by a person may have no proven
-- surface: Hub proves FYP only by For You views (from 22.07.2026, read from 22.10.2026) and the
-- wall only by flag 4 or no video. Such a placement keeps the surface Hub's shape suggests — a
-- single video without a preview is how FYP posts look, anything else the wall — with
-- `surface_source = 'hub_hint'`, and stays out of the surface norms like `plan`.
ALTER TABLE placements DROP CONSTRAINT placements_surface_source_check;
ALTER TABLE placements ADD CONSTRAINT placements_surface_source_check
  CHECK (surface_source IN ('hub', 'km_mark', 'km', 'plan', 'import', 'hub_hint'));
