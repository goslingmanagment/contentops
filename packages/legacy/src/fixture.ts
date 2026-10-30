import type { LegacyListingEntry } from './plan.ts'

/**
 * A fictional old disk in the shapes of the real one (PLAN этап 3: «в публичном репо —
 * вымышленные имена в форме настоящих»). Nicks, descriptions and contractors are made up;
 * numbers, dates and the layout repeat the collisions of the real disk (legacy §4–5).
 */

export const FIXTURE_REGISTRY = `
| название папки | Тип контента | Действия | Атрибуты | Настроение | кол-во едениц контента | комментарий |
| --- | --- | --- | --- | --- | --- | --- |
| [PPV-001]_lotus_pose_7min_03.03.2025 | PPV одиночное | yoga stretching | leggings close up | calm | 1 | кастом (Fan_Orion) |
| [PPV-022]_velvet_chair_19.01.2026 | Бандл | tease dancing | velvet heels | playful | 10 | видео 9 мин |
| [PPV-023]_ribbon_play_20.12.2025 | Бандл | tease nipple play | ribbon stockings | sensual teasing | 12 | видео 7:12 мин |
| [PPV-023]_paint_body_21.11.2025 | Бандл | bodyart tease | naked | tease | 14 | видео 10:02 мин. озвучка англ |
| [PPV-024]_cotton_robe_02.12.2025 | Бандл | tease | robe | tease | 9 | видео 6 минут. used |
| [PPV-032]_tweed_suit_05.11.2025 | Бандл | striptease | tweed | tease | 13 | видео 8:20 |
| [PPV-032]_cocoa_cup_01.07.2025 | Бандл | tease | cocoa | tease | 17 | виде 10 минут. Разные образы. |
| [PPV-032]_pumpkin_night_30.10.2025 | Бандл | Get ready with me | corset choker | tease | 9 | вдео 4:56 мин. озвучка англ |
| [PPV-066]_rope_stretch_6min_X.X.X | PPV одиночное | yoga | knee socks | sensual | 2 | кастом без имен |
| [PPV-067]_glitter_Teasing_5min_10.04.2026 | Бандл | Teasing asmr | oil glitter | sensual teasing | 2 | англ озвучка |
| [PPV-068]_frost_blowjob_X | Бандл | blowjob | lingerie ice | sensual | 6 | кастом |
| [PPV-069]_lace_tease_21.05.26 | Бандл |  |  |  | 30 |  |
`

const file = (path: string, size = 1000, extra: Partial<LegacyListingEntry> = {}) => ({
  path: `disk:/${path}`,
  isDir: false,
  size,
  md5: null,
  createdAt: '2026-08-01T10:00:00+00:00',
  ...extra,
})
const dir = (path: string, extra: Partial<LegacyListingEntry> = {}) => ({
  path: `disk:/${path}`,
  isDir: true,
  ...extra,
})

export const FIXTURE_DISK: LegacyListingEntry[] = [
  dir('1. PPV'),
  dir('1. PPV/[PPV-001]_lotus_pose_7min_03.03.2025'),
  file(
    '1. PPV/[PPV-001]_lotus_pose_7min_03.03.2025/PPV_Лотос_7мин_03.03.25_кастом_Orion(Used1).MOV',
  ),
  dir('1. PPV/[PPV-066]_rope_stretch_6min_X.X.X'),
  file('1. PPV/[PPV-066]_rope_stretch_6min_X.X.X/Растяжка и верёвка.mov', 3_500_000, {
    md5: 'a'.repeat(32),
  }),
  file('1. PPV/[PPV-066]_rope_stretch_6min_X.X.X/lv_0_20260323145220.mp4'),
  dir('1. PPV/7.08.2026'),
  file('1. PPV/7.08.2026/IMG_8487.JPG'),
  file('1. PPV/7.08.2026/copy_0A1B2C3D-4E5F-4061-8293-A4B5C6D7E8F9.mov'),
  dir('1. PPV/Bundles'),
  dir('1. PPV/Bundles/[PPV-022]_velvet_chair_19.01.2026'),
  file('1. PPV/Bundles/[PPV-022]_velvet_chair_19.01.2026/9:02 бархатный стул.mov'),
  file('1. PPV/Bundles/[PPV-022]_velvet_chair_19.01.2026/promo2.MOV'),
  dir('1. PPV/Bundles/[PPV-023]_ribbon_play_20.12.2025'),
  file('1. PPV/Bundles/[PPV-023]_ribbon_play_20.12.2025/7:12 с лентой .mov'),
  dir('1. PPV/Bundles/[PPV-023]_paint_body_21.11.2025'),
  file('1. PPV/Bundles/[PPV-023]_paint_body_21.11.2025/Роспись.mov'),
  file('1. PPV/Bundles/[PPV-023]_paint_body_21.11.2025/promo.mov'),
  dir('1. PPV/Bundles/[PPV-024]_cotton_robe_02.12.2025'),
  file('1. PPV/Bundles/[PPV-024]_cotton_robe_02.12.2025/full.mov'),
  file('1. PPV/Bundles/[PPV-024]_cotton_robe_02.12.2025/13 минут(used1).mov'),
  file('1. PPV/Bundles/[PPV-024]_cotton_robe_02.12.2025/тизер.mp4'),
  file('1. PPV/Bundles/[PPV-024]_cotton_robe_02.12.2025/1.jpg'),
  dir('1. PPV/Bundles/[PPV-032]_tweed_suit_05.11.2025'),
  dir('1. PPV/Bundles/[PPV-032]_cocoa_cup_01.07.2025'),
  dir('1. PPV/Bundles/[PPV-032]_pumpkin_night_30.10.2025'),
  dir('1. PPV/Bundles/[PPV-066]_glitter_Teasing_5min_10.04.2026'),
  dir('1. PPV/Bundles/[PPV-068]_frost_blowjob_X'),
  dir('1. PPV/Bundles/[PPV-069]_lace_tease_21.05.26'),
  dir('1. PPV/Bundles/[PPV-070]_amber_dress_28.05.26'),
  dir('1. PPV/Bundles/[PPV-071]_slow_strip_tights_23.07.26'),
  dir('1. PPV/Bundles/[PPV-072]_quick_tease_sun_30.07.26'),
  file('1. PPV/Bundles/[PPV-072]_quick_tease_sun_30.07.26/IMG_7707.mov', 900, {
    md5: 'b'.repeat(32),
  }),
  dir('1. PPV/Bundles/posted_all_bundles_в_бане_14.09'),
  file('1. PPV/Bundles/posted_all_bundles_в_бане_14.09/used_all7:15 в бане.mov'),

  dir('2. FYP'),
  dir('2. FYP/August 2026'),
  file('2. FYP/August 2026/used3_04.08.26_used2_31.07.26.mov'),
  dir('2. FYP/Posted'),
  dir('2. FYP/Posted/May 2025(posted)'),
  file('2. FYP/Posted/May 2025(posted)/FYP_03_16.04.25.MOV'),
  dir('2. FYP/Posted/August 2025 (posted)'),
  dir('2. FYP/Posted/August 2025 (posted)/posted'),
  file('2. FYP/Posted/August 2025 (posted)/posted/used1_1_28.07.MOV'),
  file('2. FYP/Posted/August 2025 (posted)/posted/used_all_124.08_.MOV'),
  file('2. FYP/Posted/August 2025 (posted)/posted/al_used_all).MOV'),
  dir('2. FYP/SteadyContent'),
  dir('2. FYP/SteadyContent/January'),
  file('2. FYP/SteadyContent/January/11-2.MOV'),

  dir('3. Customs'),
  file('3. Customs/14:05 в синем платье .mov'),
  file('3. Customs/13:03 Орион .mov'),
  file('3. Customs/Кастом 10 минут для Ориона.mov'),
  file('3. Customs/Custom_в_халате_14мин_orionfan77_12.05.25.mov'),
  file('3. Customs/Пахнущие кеды.mov'),
  dir('3. Customs/Custom_фото_в_свитере_25шт_orionfan77_19.04.25'),
  dir('3. Customs/38 фото'),
  dir('3. Customs/орион фото видео'),
  dir('3. Customs/отобранное на PPV'),
  file('3. Customs/отобранное на PPV/Растяжка и верёвка.mov', 3_500_000, { md5: 'a'.repeat(32) }),

  dir('4. Sets'),
  dir('4. Sets/non used_used__20.07_set_летний_сад_10.07'),
  dir('4. Sets/non used_used__20.07_set_летний_сад_10.07/ed'),
  dir('4. Sets/Posted sets'),
  dir('4. Sets/Posted sets/[Set-002]_robe_on_table_26.04.25'),
  dir('4. Sets/Posted sets/[Set-002]_robe_on_table_26.04.25/original'),
  dir('4. Sets/Posted sets/set_на_подоконнике_11.07.25(used_all)'),
  dir('4. Sets/Posted sets/posted_all_set_голубые_носки_13.10.25'),
  dir('4. Sets/Posted sets/set_красная_пижама_18.06.26'),

  dir('5. Sextings'),
  dir('5. Sextings/sexting_001_homemade_blue_25.01.25'),
  dir('5. Sextings/sexting _002_homemade_robe_30.01.25'),
  dir('5. Sextings/sexting _002_homemade_robe_30.01.25/optional'),
  dir('5. Sextings/sexting_009_mesh_toy_27.08.25'),
  dir('5. Sextings/sexting_012_satin_heels_30.05.26'),
  file('5. Sextings/sexting_012_satin_heels_30.05.26/1.jpg'),
  file('5. Sextings/sexting feb.zip', 5_000),

  dir('6. Life'),
  dir('6. Life/posted'),
  dir('6. Life/posted/Life_прогулка_в_парке_09.12.25'),
  dir('6. Life/posted/Life_Rome_07.08.25'),
  dir('6. Life/posted/Life_Rome_07.08.25/hotel'),

  dir('7. Pictures'),
  file('7. Pictures/IMG_2552(used1_12.07).JPG'),
  file('7. Pictures/(2used_15.07)IMG_2555.JPG'),
  file('7. Pictures/used3_12.07.JPG'),
  file('7. Pictures/IMG_9001(used2).JPG'),

  dir('8. Other'),
  file('8. Other/IMG_1101.HEIC'),
  dir('8. Other/нюды'),
  dir('8. Other/ПЕРЕЕЗД'),
  dir('8. Other/Под рассылки'),
  file('8. Other/Под рассылки/IMG_2001.JPG'),

  dir('9. SMM'),
  file('9. SMM/IMG_8283.mov', 2_000, { createdAt: '2026-07-28T10:00:00+00:00' }),
  dir('9. SMM/Twitter'),
  dir('9. SMM/Twitter/zenpromo june'),
  dir('9. SMM/Twitter/zenpromo june/photos'),
  file('9. SMM/Twitter/zenpromo june/photos/june_photo_001_img_1234_0a1b2c3d4e.jpg', 300, {
    createdAt: '2025-06-02T10:00:00+00:00',
  }),
  file('9. SMM/Twitter/zenpromo june/photos/june_photo_002_img_1235_1b2c3d4e5f.jpg', 300, {
    createdAt: '2025-06-03T10:00:00+00:00',
  }),
  dir('9. SMM/YT'),
  dir('9. SMM/YT/Mirko'),
  dir('9. SMM/YT/Mirko/декабрь - ASMR - 6 видео '),
  dir('9. SMM/YT/Mirko/декабрь - ASMR - 6 видео /1 video'),
  file('9. SMM/YT/Mirko/декабрь - ASMR - 6 видео /1 video/1 video.mov'),

  dir('BG'),
  file('BG/13:08 кастом у окна.mov'),
  dir('BG/1. PPV'),
  file('BG/1. PPV/3-teaser.mov'),

  dir('Старый формат'),
  dir('Старый формат/PPV'),
  dir('Старый формат/PPV/old'),
  file('Старый формат/PPV/old/001 bndl 8min ванна(used_all).mov', 7_000),
  file('Старый формат/PPV/old/(used_all)016 bndl 2min душ.mov', 2_000),
  dir('Старый формат/Sets'),
  dir('Старый формат/Sets/014 на балконе'),
  dir('Старый формат/FYP'),
  file('Старый формат/FYP/IMG_3001(used2).MOV', 500),

  file('archive-2025-11-04_01-02-03.zip', 14_000),
  file('Bea FYP — монтаж (КМ) — 2026-08-18.zip', 6_500),
  file('IMG_7707.mov', 900, { md5: 'b'.repeat(32) }),
]
