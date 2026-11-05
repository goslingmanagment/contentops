-- 0014_custom_parts: a custom the model answered in several clips is one custom with parts
-- (SPEC §6.1, naming §3).
--
-- One card, one folder of the answer: Лора's Dropbox `3. Customs/4 Видео` («видео из 4 этапов»,
-- four clips and the montage of them), Ари's order folders `26.09.26 <покупатель> парное` with
-- the parts of one video. Its longest clip — the montage when there is one — is the master, the
-- other clips are its parts `clip01…`; before, each clip was a custom of its own.
CREATE OR REPLACE FUNCTION role_fits_type(item_type text, role text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN coalesce(CASE item_type
    WHEN 'PPV' THEN role IN ('master', 'teaser', 'pic', 'thumb')
    WHEN 'SET' THEN role IN ('raw', 'ed')
    WHEN 'SXT' THEN role IN ('pic', 'clip')
    WHEN 'CUS' THEN role IN ('master', 'pic', 'clip')
    WHEN 'FYP' THEN role = 'master'
    WHEN 'LIFE' THEN role IN ('pic', 'clip')
    WHEN 'RAW' THEN role = 'raw'
    WHEN 'PRM' THEN role IN ('pic', 'clip')
  END, false);
