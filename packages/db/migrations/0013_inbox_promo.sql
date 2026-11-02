-- 0013_inbox_promo: a pack of «Приехало» can become a collection of «Промо» (SPEC §6.1, §7.1).
--
-- A leaf folder under `9. SMM` is a collection of its channel, as the import of the old disk
-- makes it (SPEC §6.3): discovery recognises the channel from the path, the KM may choose
-- another one («Канал ▾») and a collection to add to («Подборка: новая / PRM-015 ▾», DESIGN
-- §4.8). Both are fields of the future object, like the other `proposed_*` columns; without a
-- collection «Принять» makes a new one.
ALTER TABLE inbox_groups
  ADD COLUMN proposed_channel_id uuid,
  ADD COLUMN proposed_collection_id uuid,
  ADD FOREIGN KEY (model_id, proposed_channel_id) REFERENCES promo_channels (model_id, id)
    ON DELETE RESTRICT,
  ADD FOREIGN KEY (model_id, proposed_collection_id) REFERENCES content_items (model_id, id)
    ON DELETE RESTRICT;
