-- 0004_orders: custom orders (schema §3.7, §9.2), the order links of intake (`inbox_groups`,
-- `inbox_draft_candidates`) and the custom fields of `catalog_index`.
--
-- An order is `open → delivered → closed`, or `cancelled` with a reason (SPEC §5). Between
-- `open` and `delivered` the status is derived here from the part marks: the command sets
-- `video_completed_at/by`, `photos_completed_at/by`, the database checks each mark against the
-- live deliveries of its part. Every change of an order — a delivery, a retraction, a revision,
-- a mark, closing — takes the lock of the order row first, so they are serialised.
-- Value lists are text + CHECK; the same lists live in `src/values.ts`.

-- ---------------------------------------------------------------------------
-- Orders (schema §3.7, §9.2; SPEC §8.2)
-- ---------------------------------------------------------------------------

-- An order as the Telegram card describes it. The order has no public ID: its identity is the
-- card `tg:<chat>/<topic>/<message_id>`; a repost of the card is a message, not a second order.
CREATE TABLE custom_orders (
  model_id uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT uuidv7(),
  account_id uuid,
  tg_chat text NOT NULL,
  tg_topic bigint,
  tg_message_id bigint NOT NULL,
  card_author text NOT NULL,
  card_at timestamptz NOT NULL,
  -- Visible on the card and in the list; never put into file names or publications.
  buyer_name text,
  brief text NOT NULL,
  -- As the card says: «8-10 минут», «10 минут - 20 фото»; some cards have none.
  ordered_duration_raw text,
  duration_min_s integer CHECK (duration_min_s >= 0),
  duration_max_s integer,
  expects_video boolean NOT NULL,
  expects_photos boolean NOT NULL,
  photo_count integer,
  due_at timestamptz,
  -- `open | delivered` follow the part marks (trigger `custom_orders_status`).
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'delivered', 'closed', 'cancelled')),
  -- «Имя фана в ролике»: one field of the order; a CUS of the order shows the same value.
  name_in_media text NOT NULL DEFAULT 'unknown' CHECK (name_in_media IN ('yes', 'no', 'unknown')),
  -- A part is complete when the command says so (several clips are one part «video», marked
  -- when all of them came); the mark needs live deliveries of the part (schema §9.2).
  video_completed_at timestamptz,
  video_completed_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  photos_completed_at timestamptz,
  photos_completed_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  closed_at timestamptz,
  closed_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  CONSTRAINT custom_orders_card UNIQUE NULLS NOT DISTINCT (model_id, tg_chat, tg_topic, tg_message_id),
  FOREIGN KEY (model_id, account_id) REFERENCES accounts (model_id, id) ON DELETE RESTRICT,
  CONSTRAINT custom_orders_duration CHECK (duration_max_s >= coalesce(duration_min_s, 0)),
  CONSTRAINT custom_orders_parts CHECK (expects_video OR expects_photos),
  CONSTRAINT custom_orders_photo_count CHECK (photo_count IS NULL OR (photo_count > 0 AND expects_photos)),
  CONSTRAINT custom_orders_video_mark CHECK (
    (video_completed_at IS NULL OR expects_video)
    AND (video_completed_by IS NULL OR video_completed_at IS NOT NULL)
  ),
  CONSTRAINT custom_orders_photos_mark CHECK (
    (photos_completed_at IS NULL OR expects_photos)
    AND (photos_completed_by IS NULL OR photos_completed_at IS NOT NULL)
  ),
  CONSTRAINT custom_orders_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT custom_orders_cancelled
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX custom_orders_status ON custom_orders (model_id, status, due_at);
CREATE INDEX custom_orders_buyer ON custom_orders (model_id, lower(buyer_name));
CREATE INDEX custom_orders_brief_trgm ON custom_orders USING gin (brief gin_trgm_ops);

-- Significant messages and reposts with a link; no full copy of the chat.
CREATE TABLE custom_order_messages (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  order_id uuid NOT NULL,
  tg_ref text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('card', 'repost', 'delivery', 'revision', 'confirmation', 'note')),
  message_at timestamptz NOT NULL,
  author text NOT NULL,
  excerpt text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  PRIMARY KEY (model_id, id),
  CONSTRAINT custom_order_messages_ref UNIQUE (model_id, order_id, tg_ref, kind),
  FOREIGN KEY (model_id, order_id) REFERENCES custom_orders (model_id, id) ON DELETE RESTRICT
);

-- A delivery of one part of an order: a CUS and the sealed composition of its versions. Never
-- edited: a wrong link is retracted by a new row with `retracts_id` (same order, no manifest),
-- one retraction per delivery. A delivery is live while nothing retracts it. A CUS that brings
-- both parts is two rows, one manifest per part.
CREATE TABLE custom_order_deliveries (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  order_id uuid NOT NULL,
  part text CHECK (part IN ('video', 'photos')),
  item_id uuid,
  -- Type copy (schema §9.2): only a CUS is delivered.
  item_type text NOT NULL DEFAULT 'CUS' CHECK (item_type = 'CUS'),
  manifest_id uuid,
  draft_id uuid,
  -- When the files appeared in the source (SPEC §8.2): `remote_created_at` of the revision, the
  -- time of the message for a delivery from Telegram, else of the upload; not of acceptance.
  delivered_at timestamptz,
  -- Which signals matched (reply, name, section, duration, window) and the sources.
  basis jsonb,
  evidence_refs jsonb NOT NULL DEFAULT '[]',
  linked_at timestamptz NOT NULL DEFAULT now(),
  linked_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  -- «подтверждено» by a person or an agent when signals disagreed.
  confirmed_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  retracts_id uuid,
  retract_reason text,
  PRIMARY KEY (model_id, id),
  -- Target of FK (model_id, order_id, delivery_id): a fix and a retraction stay in the order.
  UNIQUE (model_id, order_id, id),
  -- NULLs are distinct: retractions carry no manifest and do not collide.
  CONSTRAINT custom_order_deliveries_manifest UNIQUE (model_id, order_id, manifest_id),
  CONSTRAINT custom_order_deliveries_retracts_once UNIQUE (retracts_id),
  FOREIGN KEY (model_id, order_id) REFERENCES custom_orders (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, item_id, item_type) REFERENCES content_items (model_id, id, type)
    ON DELETE RESTRICT,
  FOREIGN KEY (model_id, manifest_id) REFERENCES asset_manifests (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, draft_id) REFERENCES inbox_drafts (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, order_id, retracts_id) REFERENCES custom_order_deliveries (model_id, order_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT custom_order_deliveries_shape CHECK (
    CASE WHEN retracts_id IS NULL
      THEN num_nulls(part, item_id, manifest_id, delivered_at, basis) = 0 AND retract_reason IS NULL
      ELSE num_nonnulls(part, item_id, manifest_id, delivered_at, basis, draft_id, confirmed_by) = 0
           AND retract_reason IS NOT NULL
    END
  ),
  CONSTRAINT custom_order_deliveries_not_self CHECK (retracts_id <> id)
);
CREATE INDEX custom_order_deliveries_item ON custom_order_deliveries (model_id, item_id)
  WHERE item_id IS NOT NULL;

-- A revision request. Binding a new version does not close it: the agent marks it done with a
-- basis («Правка не закрывается одной привязкой версии», schema §4). «Сдано, требуется правка»
-- is a query: the order is delivered and has a revision with `done = false`.
CREATE TABLE custom_order_revisions (
  model_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT uuidv7(),
  order_id uuid NOT NULL,
  requirement text NOT NULL,
  request_tg_ref text NOT NULL,
  -- One message may carry several requirements.
  request_ordinal integer NOT NULL DEFAULT 1 CHECK (request_ordinal >= 1),
  requested_at timestamptz NOT NULL,
  done boolean NOT NULL DEFAULT false,
  done_basis text,
  fixed_delivery_id uuid,
  done_at timestamptz,
  done_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  reopened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES principals (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (model_id, id),
  CONSTRAINT custom_order_revisions_request UNIQUE (model_id, order_id, request_tg_ref, request_ordinal),
  FOREIGN KEY (model_id, order_id) REFERENCES custom_orders (model_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id, order_id, fixed_delivery_id)
    REFERENCES custom_order_deliveries (model_id, order_id, id) ON DELETE RESTRICT,
  CONSTRAINT custom_order_revisions_done_at CHECK (done = (done_at IS NOT NULL)),
  CONSTRAINT custom_order_revisions_done_basis CHECK (NOT done OR done_basis IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Parts, status and serialisation (schema §9.2, §9.4)
-- ---------------------------------------------------------------------------

-- Distinct logical files of the part's media in the live deliveries of the part: videos for
-- `video`, images for `photos`. A version of the same file counts once.
CREATE FUNCTION custom_order_live_files(p_model_id uuid, p_order_id uuid, p_part text)
  RETURNS integer
  LANGUAGE sql STABLE PARALLEL SAFE
  RETURN (
    SELECT count(DISTINCT e.asset_id)::integer
      FROM custom_order_deliveries d
      JOIN asset_manifest_entries e ON e.model_id = d.model_id AND e.manifest_id = d.manifest_id
      JOIN assets a ON a.model_id = e.model_id AND a.id = e.asset_id
     WHERE d.model_id = p_model_id AND d.order_id = p_order_id AND d.part = p_part
       AND a.media_kind = CASE p_part WHEN 'video' THEN 'video' ELSE 'image' END
       AND NOT EXISTS (SELECT 1 FROM custom_order_deliveries r WHERE r.retracts_id = d.id)
  );

-- Status of an order (SPEC §5, §8.2). A part mark stands only on live deliveries of the part
-- (photos: at least `photo_count` distinct files, when set); `open ⇔ delivered` follows the
-- marks; `closed` needs every expected part and no open revision; `closed` and `cancelled` are
-- final. The row lock of the UPDATE is taken before this trigger runs, so its reads see every
-- delivery and revision committed before it (they take the same lock).
CREATE FUNCTION custom_order_status() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  parts_done boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('closed', 'cancelled') THEN
    IF NEW.status <> OLD.status
       OR (NEW.expects_video, NEW.expects_photos, NEW.photo_count, NEW.video_completed_at,
           NEW.photos_completed_at)
          IS DISTINCT FROM
          (OLD.expects_video, OLD.expects_photos, OLD.photo_count, OLD.video_completed_at,
           OLD.photos_completed_at) THEN
      RAISE EXCEPTION 'order %: % is final', OLD.id, OLD.status
        USING ERRCODE = 'CO005';
    END IF;
    RETURN NEW;
  END IF;

  -- A mark of a part that was not ordered is left to CHECK `custom_orders_*_mark`.
  IF NEW.video_completed_at IS NOT NULL AND NEW.expects_video
     AND custom_order_live_files(NEW.model_id, NEW.id, 'video') = 0 THEN
    RAISE EXCEPTION 'order %: the video part has no live delivery', NEW.id
      USING ERRCODE = 'CO005';
  END IF;
  IF NEW.photos_completed_at IS NOT NULL AND NEW.expects_photos
     AND custom_order_live_files(NEW.model_id, NEW.id, 'photos') < coalesce(NEW.photo_count, 1) THEN
    RAISE EXCEPTION 'order %: % of % photos delivered',
      NEW.id, custom_order_live_files(NEW.model_id, NEW.id, 'photos'), coalesce(NEW.photo_count, 1)
      USING ERRCODE = 'CO005';
  END IF;

  parts_done := (NOT NEW.expects_video OR NEW.video_completed_at IS NOT NULL)
            AND (NOT NEW.expects_photos OR NEW.photos_completed_at IS NOT NULL);
  IF NEW.status IN ('open', 'delivered') THEN
    NEW.status := CASE WHEN parts_done THEN 'delivered' ELSE 'open' END;
  ELSIF NEW.status = 'closed' THEN
    IF NOT parts_done THEN
      RAISE EXCEPTION 'order %: not every ordered part is delivered', NEW.id
        USING ERRCODE = 'CO005';
    END IF;
    IF EXISTS (SELECT 1 FROM custom_order_revisions
                WHERE model_id = NEW.model_id AND order_id = NEW.id AND NOT done) THEN
      RAISE EXCEPTION 'order %: a revision is open', NEW.id
        USING ERRCODE = 'CO005';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- A delivery or a retraction locks its order first; a final order takes neither. A retraction
-- removes the mark of the retracted part: the command marks it again if it still holds. A
-- retraction is never retracted. An order or delivery of another order is left to the FKs.
CREATE FUNCTION custom_order_delivery_lock() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  order_status text;
  target_part text;
  target_retracts uuid;
BEGIN
  SELECT status INTO order_status FROM custom_orders
   WHERE model_id = NEW.model_id AND id = NEW.order_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF order_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'order %: % takes no delivery or retraction', NEW.order_id, order_status
      USING ERRCODE = 'CO005';
  END IF;
  IF NEW.retracts_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT part, retracts_id INTO target_part, target_retracts FROM custom_order_deliveries
   WHERE model_id = NEW.model_id AND order_id = NEW.order_id AND id = NEW.retracts_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF target_retracts IS NOT NULL THEN
    RAISE EXCEPTION 'delivery %: a retraction is not retracted', NEW.retracts_id
      USING ERRCODE = 'CO005';
  END IF;
  IF target_part = 'video' THEN
    UPDATE custom_orders SET video_completed_at = NULL, video_completed_by = NULL
     WHERE model_id = NEW.model_id AND id = NEW.order_id AND video_completed_at IS NOT NULL;
  ELSE
    UPDATE custom_orders SET photos_completed_at = NULL, photos_completed_by = NULL
     WHERE model_id = NEW.model_id AND id = NEW.order_id AND photos_completed_at IS NOT NULL;
  END IF;
  RETURN NEW;
END
$$;

-- A revision locks its order first; a closed order has no open revision.
CREATE FUNCTION custom_order_revision_lock() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  order_status text;
BEGIN
  SELECT status INTO order_status FROM custom_orders
   WHERE model_id = NEW.model_id AND id = NEW.order_id
     FOR NO KEY UPDATE;
  IF order_status = 'closed' AND NOT NEW.done THEN
    RAISE EXCEPTION 'order %: closed, a revision cannot be open', NEW.order_id
      USING ERRCODE = 'CO005';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER custom_orders_status BEFORE INSERT OR UPDATE ON custom_orders
  FOR EACH ROW EXECUTE FUNCTION custom_order_status();
CREATE TRIGGER custom_order_deliveries_lock BEFORE INSERT ON custom_order_deliveries
  FOR EACH ROW EXECUTE FUNCTION custom_order_delivery_lock();
CREATE TRIGGER custom_order_revisions_lock BEFORE INSERT OR UPDATE ON custom_order_revisions
  FOR EACH ROW EXECUTE FUNCTION custom_order_revision_lock();

-- ---------------------------------------------------------------------------
-- Order links of intake (schema §3.4, §9.5)
-- ---------------------------------------------------------------------------

-- The order the future CUS of the group is delivered for (field «Заказ» of the group).
ALTER TABLE inbox_groups
  ADD COLUMN custom_order_id uuid,
  ADD FOREIGN KEY (model_id, custom_order_id) REFERENCES custom_orders (model_id, id)
    ON DELETE RESTRICT;
ALTER TABLE inbox_draft_candidates
  ADD FOREIGN KEY (model_id, order_id) REFERENCES custom_orders (model_id, id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Append-only deliveries, fixed columns and the journal (schema §9.3, §9.4)
-- ---------------------------------------------------------------------------

-- A delivery is a fact: its journal is the `action` row of the command that inserts it.
CREATE TRIGGER custom_order_deliveries_append_only BEFORE UPDATE OR DELETE ON custom_order_deliveries
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
REVOKE UPDATE, DELETE ON custom_order_deliveries FROM contentops_app;

CREATE TRIGGER custom_orders_fixed BEFORE UPDATE ON custom_orders
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id');
CREATE TRIGGER custom_order_messages_fixed BEFORE UPDATE ON custom_order_messages
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'order_id');
CREATE TRIGGER custom_order_revisions_fixed BEFORE UPDATE ON custom_order_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_change('model_id', 'id', 'order_id');

CREATE TRIGGER custom_orders_journal AFTER INSERT OR UPDATE OR DELETE ON custom_orders
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER custom_order_messages_journal AFTER INSERT OR UPDATE OR DELETE ON custom_order_messages
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');
CREATE TRIGGER custom_order_revisions_journal AFTER INSERT OR UPDATE OR DELETE ON custom_order_revisions
  FOR EACH ROW EXECUTE FUNCTION log_row_change('model_id', 'id');

-- ---------------------------------------------------------------------------
-- Compact catalog index with the custom fields (SPEC §12.0 «Интерфейс»)
-- ---------------------------------------------------------------------------

-- As in 0003, plus for a CUS: `order_id` and `delivered_at` of its first live delivery, and
-- `name_in_media` of that order (a CUS without an order keeps its own value).
CREATE OR REPLACE VIEW catalog_index WITH (security_invoker = true) AS
SELECT
  i.model_id,
  i.id AS item_id,
  public_item_id(i.type, i.number) AS public_id,
  i.type,
  i.number,
  i.title,
  i.title_en,
  coalesce(tg.slugs, '{}'::text[]) AS tags,
  CASE
    WHEN af.confirmed > 0 AND af.confirmed = af.total THEN 'confirmed'
    WHEN af.confirmed > 0 THEN 'partial'
    ELSE 'draft'
  END AS markup_state,
  cv.version_id AS cover_version_id,
  cv.width AS cover_width,
  cv.height AS cover_height,
  cv.thumb320_generation_id AS cover_thumb320_generation_id,
  cv.thumb640_generation_id AS cover_thumb640_generation_id,
  m.duration_ms,
  m.photo_count,
  m.video_count,
  m.version_count,
  coalesce(m.has_teaser, false) AS has_teaser,
  m.size_bytes,
  coalesce(arrival.arrived_at, i.created_at) AS arrived_at,
  i.shot_on,
  i.ppv_kind,
  i.raw_purpose,
  ppv.public_id AS ppv_made_as,
  coalesce(cd.name_in_media, i.name_in_media) AS name_in_media,
  i.has_second_person,
  CASE WHEN i.type = 'SET' THEN coalesce(m.selected_count, 0) END AS selected_count,
  CASE WHEN i.type = 'SET' THEN coalesce(m.processed_count, 0) END AS processed_count,
  CASE WHEN i.type = 'LIFE' THEN coalesce(m.life_unassigned, 0) END AS life_unassigned,
  CASE WHEN i.type = 'LIFE' THEN coalesce(m.life_chat_count, 0) END AS life_chat_count,
  CASE WHEN i.type = 'LIFE' THEN coalesce(m.life_feed_count, 0) END AS life_feed_count,
  (i.type = 'CUS' AND coalesce(m.video_count, 0) = 0 AND coalesce(m.photo_count, 0) > 0) AS photo_custom,
  coalesce(al.aliases, '{}'::text[]) AS aliases,
  pc.code AS promo_channel_code,
  i.created_at,
  i.updated_at,
  cd.order_id,
  cd.delivered_at
FROM content_items i
LEFT JOIN promo_channels pc ON pc.model_id = i.model_id AND pc.id = i.promo_channel_id
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT coalesce(merged.slug, t.slug) ORDER BY coalesce(merged.slug, t.slug)) AS slugs
    FROM item_tags it
    JOIN tags t ON t.id = it.tag_id
    LEFT JOIN tags merged ON merged.id = t.merged_into_tag_id
   WHERE it.model_id = i.model_id AND it.item_id = i.id
) tg ON true
-- Fields of the object and of its files' current versions: two index lookups, not an OR
-- that scans every field of the model for each object (docs/reference/infrastructure.md §5).
-- A field has exactly one target (annotation_fields_one_target): nothing is counted twice.
LEFT JOIN LATERAL (
  SELECT count(*) AS total,
         count(*) FILTER (WHERE f.confirmed_value_version = f.value_version) AS confirmed
    FROM (
      SELECT f.value_version, f.confirmed_value_version
        FROM annotation_fields f
       WHERE f.model_id = i.model_id AND f.item_id = i.id
      UNION ALL
      SELECT f.value_version, f.confirmed_value_version
        FROM annotation_fields f
       WHERE f.model_id = i.model_id
         AND f.version_id IN (
           SELECT a.current_version_id
             FROM item_memberships im
             JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
            WHERE im.model_id = i.model_id AND im.item_id = i.id
              AND im.kind = 'owned' AND im.removed_at IS NULL
         )
    ) f
) af ON true
LEFT JOIN LATERAL (
  SELECT v.id AS version_id, v.width, v.height,
         (SELECT g.id FROM rendition_generations g
           WHERE g.master_sha256 = v.master_sha256 AND g.kind = 'thumb320' AND g.is_active
             AND g.state = 'ready' AND NOT g.meta_stripped
           ORDER BY g.ready_at DESC LIMIT 1) AS thumb320_generation_id,
         (SELECT g.id FROM rendition_generations g
           WHERE g.master_sha256 = v.master_sha256 AND g.kind = 'thumb640' AND g.is_active
             AND g.state = 'ready' AND NOT g.meta_stripped
           ORDER BY g.ready_at DESC LIMIT 1) AS thumb640_generation_id
    FROM item_memberships im
    JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
    JOIN asset_versions v ON v.model_id = a.model_id
                         AND v.id = coalesce(im.pinned_version_id, a.current_version_id)
   WHERE im.model_id = i.model_id AND im.item_id = i.id
     AND (im.id = i.cover_membership_id OR (i.cover_membership_id IS NULL AND im.removed_at IS NULL))
   ORDER BY im.display_position NULLS LAST, im.added_at, im.id
   LIMIT 1
) cv ON true
LEFT JOIN LATERAL (
  SELECT (count(*) FILTER (WHERE a.media_kind = 'image' AND im.variant_no = 0))::integer AS photo_count,
         (count(*) FILTER (WHERE a.media_kind = 'video' AND im.variant_no = 0))::integer AS video_count,
         max(v.version_no) FILTER (WHERE im.kind = 'owned') AS version_count,
         bool_or(im.kind = 'owned' AND im.role = 'teaser') AS has_teaser,
         coalesce(
           max(v.duration_ms) FILTER (WHERE im.kind = 'owned' AND im.role = 'master' AND im.variant_no = 0),
           (sum(v.duration_ms) FILTER (WHERE a.media_kind = 'video' AND im.variant_no = 0))::bigint
         ) AS duration_ms,
         sum(b.byte_size)::bigint AS size_bytes,
         (count(*) FILTER (WHERE im.selected))::integer AS selected_count,
         (count(*) FILTER (WHERE im.role = 'ed'))::integer AS processed_count,
         (count(*) FILTER (WHERE im.life_use IS NULL))::integer AS life_unassigned,
         (count(*) FILTER (WHERE im.life_use IN ('chats', 'both')))::integer AS life_chat_count,
         (count(*) FILTER (WHERE im.life_use IN ('feed', 'both')))::integer AS life_feed_count
    FROM item_memberships im
    JOIN assets a ON a.model_id = im.model_id AND a.id = im.asset_id
    JOIN asset_versions v ON v.model_id = a.model_id
                         AND v.id = coalesce(im.pinned_version_id, a.current_version_id)
    JOIN blobs b ON b.sha256 = v.master_sha256
   WHERE im.model_id = i.model_id AND im.item_id = i.id AND im.removed_at IS NULL
) m ON true
LEFT JOIN LATERAL (
  SELECT min(coalesce(r.remote_created_at, r.detected_at)) AS arrived_at
    FROM item_memberships im
    JOIN asset_versions v ON v.model_id = im.model_id AND v.asset_id = im.asset_id
    JOIN source_revisions r ON r.model_id = v.model_id AND r.id = v.source_revision_id
   WHERE im.model_id = i.model_id AND im.item_id = i.id AND im.kind = 'owned'
) arrival ON true
LEFT JOIN LATERAL (
  SELECT public_item_id(c.type, c.number) AS public_id
    FROM provenance p
    JOIN content_items c ON c.model_id = p.model_id AND c.id = p.child_item_id
   WHERE p.model_id = i.model_id AND p.parent_item_id = i.id AND p.relation = 'ppv_from_custom'
     AND p.voided_by_id IS NULL AND c.deleted_at IS NULL
   ORDER BY c.number
   LIMIT 1
) ppv ON i.type = 'CUS'
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT a.value_raw ORDER BY a.value_raw) AS aliases
    FROM aliases a
   WHERE a.model_id = i.model_id AND a.item_id = i.id
     AND a.kind IN ('legacy_id', 'merged_id', 'vault_album')
) al ON true
LEFT JOIN LATERAL (
  SELECT d.order_id, d.delivered_at, o.name_in_media
    FROM custom_order_deliveries d
    JOIN custom_orders o ON o.model_id = d.model_id AND o.id = d.order_id
   WHERE d.model_id = i.model_id AND d.item_id = i.id
     AND NOT EXISTS (SELECT 1 FROM custom_order_deliveries r WHERE r.retracts_id = d.id)
   ORDER BY d.delivered_at, d.id
   LIMIT 1
) cd ON i.type = 'CUS'
WHERE i.deleted_at IS NULL;
