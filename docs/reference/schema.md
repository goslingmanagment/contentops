# Схема данных ядра

Сведено 08.09.2026 на коммите `1955e08` по SPEC §4 «Таблицы ядра». Основание:
четыре независимых проекта того же дня — три варианта (каталог, конвейер и Hub,
скептик) и проект кодекса (`~/Documents/Codex/2026-09-08/contentops-schema/`).
Правило сведения: модель версий, составов и истории — из проекта кодекса; каждая
таблица сверх ядра держится на сценарии из PRD или SPEC; глубина протоколов хранения
— уровень пилота на одну модель, не объектного хранилища.

Это задание на миграции по этапам PLAN; при расхождении с SPEC §4
побеждает SPEC. Уточнено 11.09.2026 по итогам конкурентного планирования (два
независимых планировщика, четыре раунда сверки, решения владельца 11.09): схема §9. При
расхождении схема §9 сильнее схемы §1–§7; колонки таблицы переходят в миграции и золотой
`schema.sql` вместе с миграцией её этапа (схема §9.5), и тогда её описание здесь ужимается до
принципов, транзакций, сценариев и решений. SQL не выполнялся; проверки конкурентности, падений и
восстановления — PLAN этапы 1–2. Имена таблиц и колонок — латиницей, множественное
число, snake_case; всё остальное по-русски. Ссылка «§N» без приписки ведёт в SPEC,
«схема §N» — в раздел этого файла.

## 1. Принципы

1. **Ключи и модель.** Внутренний ключ `id uuid DEFAULT uuidv7()`. У доменных таблиц
   `PRIMARY KEY (model_id, id)`, все доменные связи — составные
   `FOREIGN KEY (model_id, x_id)`. Это защита от смешивания данных двух моделей, не
   право доступа: кто что читает — решают код и отрицательные тесты (SPEC §11.1).
   Без `model_id` живут только таблицы, которые не содержат контента модели:
   модели и люди, словарь известных тегов, байты и их технические описания,
   производные, версии конвейера, бэкап и сверка хранилища.
2. **Номер выдаёт таблица-счётчик** в той же транзакции, что и создание объекта;
   отклонённый черновик номер не тратит, удалённый объект оставляет tombstone.
   Легаси: сначала проход по метаданным замороженного снимка, резерв старых номеров и
   счётчик выше фактического максимума, потом байты (SPEC §6.4).
3. **Логический файл и его версия — разные строки.** `assets` — стабильная единица
   («мастер PPV-073», «кадр ed07»), `asset_versions` — неизменяемая редакция с
   хэшем мастера. Правка даёт новую версию, старые строки не меняются. Участие файла
   в объекте — `item_memberships`: роль, номер, порядок, отбор, назначение. Владелец
   у файла один, остальные объекты (подборки `PRM`) держат ссылки.
4. **Состав действия неизменяем.** Строка плана, выдача, передача подрядчику и сдача
   кастома ссылаются на закрытый состав конкретных версий (`asset_manifests`).
   Решение владельца 08.09.2026: подготовленный план держит выбранную версию, пока
   человек явно её не заменит; живая подборка `PRM` следует текущей версии, а
   подготовленная и переданная выгрузка закреплены.
5. **Факты дописываются, состояния вычисляются.** Улики размещений, наблюдения Hub,
   квитанции выдач, журнал действий только вставляются. Исправление — новая строка со
   ссылкой на прежнюю; у прежней не больше одного преемника.
6. **Байты вне модели, доступ через версию.** Ссылкой на блоб считаются: хэш мастера
   любой версии (включая старые), хэши нерешённого черновика, выход незавершённой
   работы. Производные ссылкой не являются. Байты удаляются только при нуле ссылок,
   командой владельца по отчёту `verify-blobs`, после повторной проверки; карантина нет
   (30.10.2026).
7. **Разметка — типизированные поля со своим статусом у каждого.** Предложения ИИ
   лежат отдельно и применяются только к неподтверждённому полю с проверкой версии
   поля; «подтвердить всю разметку» подтверждает ровно те версии полей, которые видел
   человек.
8. **Зеркало Hub** — типизированные текущие строки плюс журнал наблюдений по
   порядковому номеру; уникальности по хэшу состояния нет, чтобы A→B→A давало три
   наблюдения.
9. **Фон живёт в доменной таблице** `work_operations`: аренда, поколение аренды,
   попытка, checkpoint, отпечаток входа. Исполнитель сам забирает созревшие строки
   (`FOR UPDATE SKIP LOCKED`), отдельной очереди нет (pg-boss снят 30.09.2026).
10. **Пороги §13 — строки настроек**, а не константы в коде.
11. **Время** — `timestamptz` в UTC; слот плана — `date` и `time`; длительности —
    `bigint` миллисекунд; SHA-256 — `bytea` из 32 байт, hex только на границе API и в
    именах файлов.
12. **Списки значений** — везде `text` + CHECK, enum Postgres не используются
    (11.09): значение enum нельзя убрать и нельзя использовать в той транзакции, где
    оно добавлено; один список в коде, тест сверяет с ним каждый CHECK.

## 2. Состав — 68 таблиц (30.10.2026)

| Область | Таблицы |
|---|---|
| Модель и доступ | `models`, `accounts`, `surfaces`, `promo_channels`, `principals`, `principal_grants`, `sessions`, `api_tokens`, `id_counters`, `policy_settings`, `pipeline_versions` |
| Каталог | `content_items`, `assets`, `asset_versions`, `item_memberships`, `asset_manifests`, `asset_manifest_entries`, `aliases`, `provenance`, `tags`, `item_tags`, `annotation_fields`, `annotation_runs`, `annotation_suggestions`, `chronology_entries`, `platform_texts` |
| Байты и производные | `blobs`, `blob_probes`, `blob_phashes`, `master_checks`, `storage_operations`, `rendition_generations`, `rendition_artifacts` |
| Источники, приёмка, фон | `sources`, `source_objects`, `source_paths`, `source_revisions`, `inbox_groups`, `inbox_drafts`, `inbox_draft_candidates`, `web_uploads`, `work_operations`, `legacy_claims`, `legacy_number_claims`, `review_cases` |
| План и выдача | `ppv_releases`, `posting_plan_rows`, `download_receipts`, `download_receipt_entries` |
| Размещения и Hub | `placements`, `placement_assets`, `placement_evidence`, `hub_sync_state`, `hub_observations`, `hub_posts`, `hub_post_attachments`, `hub_raw_media`, `hub_vault_albums`, `hub_vault_media` |
| Заказы кастомов | `custom_orders`, `custom_order_messages`, `custom_order_deliveries`, `custom_order_revisions` |
| Промо | `contractors`, `promo_deliveries` |
| Служебные | `idempotency_keys`, `action_log`, `backup_checkpoints` |

Чего нет намеренно: `tasks` и `week_templates` (решение 05.09: задачи — выборка строк
плана, норма недели — JSON на странице), матрицы прав (роль плюс список моделей),
хранимого статуса размещения (§5), таблицы состава промо-подборки
(это членство файла в объекте `PRM`), таблиц удержания файлов на время выдачи и
файловых замков (мастер с живой версией не удаляется никогда, производные
пересобираемы), редакций строки плана (изменения — в журнале, выданные имена — в
квитанции). Убрано 11.09.2026 (схема §9.1): `rendition_requests`, `promo_packages`,
`hub_sync_runs`, `backup_runs`, `storage_findings`, `hub_coverage`, `placement_checks`.
Убрано 30.10.2026: `contractor_profiles` — у подрядчика одно поле формата (схема §3.8).

## 3. Таблицы

Изменения 11.09.2026 по таблицам — в схеме §9.2; там, где схема §9 говорит иначе, она сильнее.
Колонки 13 таблиц `0001_foundation` (схема §9.5) и состояния `storage_operations` сведены
со схемой §9 30.09.2026. С 30.10.2026 колонки, ключи и ограничения этих 13 таблиц задают
`packages/db/migrations/0001_foundation.sql` и золотой `packages/db/schema.sql`, 32 таблиц
этапа 2а — `0002_bytes_sources.sql` и `0003_catalog.sql` (выборы — схема §9.2 «Миграции 0002
и 0003»), 4 таблиц заказов — `0004_orders.sql` (выборы — схема §9.2 «Миграция 0004»), 5 таблиц
этапа 3 — `0005_legacy_placements.sql`, 2 таблиц плана — `0006_plan.sql` (выборы — схема §9.2
«Миграции 0005 и 0006») и 2 таблиц промо — `0007_promo.sql` (выборы — схема §9.2 «Миграция
0007»); описание ниже — смысл и решения.

Сквозные соглашения: `created_at timestamptz NOT NULL DEFAULT now()`;
`created_by` → `principals` там, где действие инициировал человек или агент;
`row_version bigint` у всего, что правит человек на экране (запрос несёт ожидаемую
версию, потерянное обновление даёт конфликт); FK `ON DELETE RESTRICT`.

### 3.1. Модель и доступ

**`models`** — корень изоляции и рядов ID (§4, §11.1). `id`, `code` (`lora`;
UNIQUE; в URL, поэтому `admin` и `auth` запрещены), `title`, `title_genitive` («Лоры» — «ждём
от Лоры»), `timezone` (`Europe/Moscow`), `created_at`, `archived_at`, `row_version`.
Счётчика изменений каталога нет: индекс — view `catalog_index`, браузер обновляет
снимок модели целиком по ETag (§12.0).

**`accounts`** — страница модели (§4). `id`, `model_id`, `code` (`lora-1`, `lora-of`;
UNIQUE глобально — код попадает в имена файлов), `platform` (`fansly | onlyfans`),
`title`, `handle` (ник страницы на площадке), `position` (порядок страниц модели),
`hub_page_ref` (UNIQUE; по нему приходят строки Hub), `week_norm jsonb`
(норма недели, §4; проверяется по `schema_version`), `default_assignee_id`,
`default_uniq_level`, `archived_at`, `row_version`. UNIQUE `(model_id, code)`.
Политики второго человека нет: на OnlyFans ставится только объект с `has_second_person =
false`; отмеченный и не проверенный — нет (§7).

**`surfaces`** — место публикации на странице (§4, §7).
`id`, `model_id`, `account_id`, `kind` (`wall | fyp | story | vault | mass_dm`),
`auto_match boolean`. Внешнего промо-канала среди поверхностей нет: у него нет процесса
и источника факта (30.10.2026).
CHECK `auto_match = false OR kind IN ('wall','fyp','vault')` — исключение сториз и
рассылки из автосверки (решение 06.09) держится схемой;
UNIQUE `(account_id, kind)`; UNIQUE
`(model_id, account_id, id)` — цель FK `(model_id, account_id, surface_id)` у строк
плана и размещений: поверхность всегда своей страницы.

**`promo_channels`** — папки каналов раздела «Промо» (§7.1). `id`, `model_id`, `code`,
`title`, `archived_at`, `row_version`. UNIQUE `(model_id, code)`.

**`principals`** — люди и агенты (§11.1). `id`, `kind` (`human | agent`), `login`
(UNIQUE), `display_name`, `gender` (`f | m`; форма глагола в ленте: «отметила»; у агента
может быть пусто), `role` (`owner | manager | reader`), `password_hash`
(argon2; CHECK только у людей), `ui_skin` (`blue | focus`, по умолчанию `blue`; вид
интерфейса, DESIGN §7.10), `disabled_at`, `created_at`, `row_version`.

**`principal_grants`** — область прав (§11.1): права на модель, прав на страницу нет.
`id`, `principal_id`, `model_id`, `granted_at`, `granted_by`, `revoked_at`.
Частичный UNIQUE `(principal_id, model_id) WHERE revoked_at IS NULL` — один живой
грант. Историческая выдача остаётся строкой.

**`sessions`** — парольные сессии людей, 30 дней (§12.0): `id`, `principal_id`,
`token_hash` (UNIQUE), `user_agent`, `created_at`, `expires_at`, `last_seen_at`, `revoked_at`,
`replaced_by_id`. **`api_tokens`** — токены агентов: `id`, `principal_id`, `name`,
`token_hash` (UNIQUE), `token_prefix`, `created_at`, `expires_at`, `revoked_at`,
`last_used_at`.

**`id_counters`** — живой счётчик (§4.1, §6.4). PK `(model_id, type)`,
`next_number integer CHECK (>= 1)` (начальный задаёт bootstrap),
`legacy_reserved_at timestamptz?`, `legacy_reserved_work_id?` (работа `import_parse`,
поставившая отметку), `updated_at`. Выдача:
`UPDATE … SET next_number = next_number + 1 … RETURNING next_number - 1` в
транзакции принятия. Легаси: `reserve(model, type, n)` поднимает счётчик до
`GREATEST(next_number, n + 1)`; сам номер занимает строка `content_items`.
`legacy_reserved_at` ставит работа `import_parse` после полного прохода по читаемым
источникам (этап 3, §6.4) или bootstrap для типа без легаси; пока он пуст у типа, у
которого по конфигурации есть легаси, приёмка номер не выдаёт.

**`policy_settings`** — пороги §13 и выключатели SPEC §8. `id`, `model_id?` (NULL —
глобальная строка: выключатели и пороги защиты входа SPEC §11.1; общий запрет
сильнее разрешения по модели), `account_id?`, `item_type?`, `key`, `value jsonb?`,
`updated_at`, `updated_by`, `row_version`. UNIQUE NULLS NOT DISTINCT `(model_id, account_id,
item_type, key)`; CHECK: строка без модели не несёт `account_id`. Приоритет:
модель+аккаунт+тип → модель+аккаунт → модель+тип → модель → глобально; SQL NULL —
не задано, то есть выключено; JSON `null` отклоняется; валидатор на каждый ключ;
сидов нет. Выключатели SPEC §8: `hub.receive`, `hub.auto_match`, `hub.publish`
(публикация через Hub, с 5б), `ydisk.scan`, `dropbox.scan`, `agents.enabled`, `agents.token.<id>`,
`fyper.enabled`, `annotation.*` (SPEC §8.3). Пауза очереди «Состояния» — `queue.<очередь>`
(`fetch`, `preview`, `compress`, `frames`, `copies`; только глобальная строка): медиаобработка —
ядро, поэтому без строки очередь работает, держит её только явное `false` владельца
(«Пауза»), исполнитель проверяет его перед каждой попыткой (с 1а, решение по принципу MVP
30.10.2026). Пороги и настройки: `too_early_days`,
`phash_suggest_threshold`, `intake_auto_accept`,
`hub_candidate_tolerance`, `hub_exact_duration_ms`, `hub_wait_window`,
`hub_not_out_window`, `hub_vault_recheck` (SPEC §7), `hub_ad_markers` (признаки рекламы
чужой страницы) и `vault_bins` (корзины vault: `FYP YYYY-MM`, `Lifestyle`, PPV) — у
страницы (SPEC §7), `import_batch_scope` (схема §9.7); входы импорта легаси у модели —
`legacy.registry` (выгрузка реестра PPV текстом) и `legacy.vault_albums` (названия альбомов
vault, прочитанные агентом в Hub, — улики SXT-010/011) и `legacy.label.<метка>` (страница
метки старых имён, подтверждённая КМ: страницы, номер поста дня или «страница неизвестна»),
этап 3, 30.10.2026.
Порог меняется строкой, не миграцией; решения хранят снимок разрешённых значений и
версий, прошлые значения — в журнале.

**`pipeline_versions`** — что означает строка `pipeline_version`. `version` (PK),
`ffmpeg`, `svtav1`, `libvips`, `sharp`, `phash_algo`, `master_recipe jsonb`
(CRF 24, preset 6, tune 1, qm, GOP — §9.2), `rendition_recipes jsonb` (§9.3),
`recipe_digests jsonb` (по каждому виду, мастер тоже вид, — хэш канонического JSON его
рецепта и версий инструментов, которыми он собирается), `activated_at`,
`is_current` (частичный UNIQUE — ровно одна). Смена профиля мастера или производной —
новая строка и новый `pipeline_version`; ключ производной и `blob_probes` — по
`recipe_digest` своего вида, а не по общей версии, поэтому правка миниатюр пересобирает
фоном только миниатюры (30.10.2026).

### 3.2. Каталог

**`content_items`** — объект каталога (§4, §4.1).

| Колонка | Тип | Смысл |
|---|---|---|
| `id`, `model_id` | uuid | PK `(model_id, id)` |
| `type` | text | `PPV SET SXT CUS FYP LIFE RAW PRM` |
| `number` | integer | публичный номер; форма с паддингом вычисляется |
| `title` | text? | русское название (naming §4); статус — в `annotation_fields` |
| `title_en` | text? | необязательное короткое английское название, 2–5 слов, словарь как в хэштегах vault (naming §4); отдельный статус — в `annotation_fields` |
| `description` | text? | описание; оно же заметки КМ для разметки (§8.3; отдельного поля «заметка» нет, DESIGN) |
| `ppv_kind` | text? | `bundle \| dm`; CHECK только у PPV |
| `raw_purpose` | text? | назначение пачки RAW: `fyp \| ppv \| mass_dm \| unknown` |
| `shot_on` | date? | день съёмки (EXIF или подтверждённый) |
| `cover_membership_id` | uuid? | обложка карточки; FK отложенный |
| `has_second_person` | boolean? | флаг «второй человек в кадре» (§4, §7); пусто — не проверено (схема §9.2) |
| `name_in_media` | text? | `yes \| no \| unknown` — «имя есть / нет» у CUS без заказа; у CUS с заказом значение берётся из `custom_orders.name_in_media` |
| `created_from_group_id` | uuid? | группа приёмки, из которой создан; связь «объект ← приёмка» — только здесь и в `inbox_drafts.applied_*` |
| `origin` | text | `intake \| import \| manual` |
| `merged_into_item_id` | uuid? | при слиянии — выживший объект |
| `deleted_at/by`, `delete_reason` | ? | tombstone |
| `search_tsv` | tsvector STORED | `title`, `title_en` и описание, русский и английский |
| `row_version`, `created_at/by`, `updated_at` | | |

Slug в `content_items` не хранится: при скачивании вычисляется из заполненного
`title_en`, иначе — фиксированным транслитом `title` (naming §4).

Ключи: UNIQUE `(model_id, type, number)` — действует и на tombstone;
UNIQUE `(model_id, created_from_group_id)` — одна группа даёт не больше одного
объекта (две команды по половинам папки не создадут две карточки);
CHECK `(type = 'PPV') = (ppv_kind IS NOT NULL)`;
CHECK `merged_into_item_id IS NULL OR deleted_at IS NOT NULL`;
составной FK на `merged_into_item_id` — слияние только внутри модели.
Индексы: `(model_id, type, number)`; `(model_id, updated_at DESC)`; частичный
`(model_id, type) WHERE deleted_at IS NULL`; GIN `search_tsv`;
`(model_id, shot_on)`.

Смена типа после выдачи номера — не UPDATE: правильная переклассификация создаёт
новый объект с новым номером и перенаправление, файлы переходят в него (членства снимаются
и создаются заново), прежний ID остаётся алиасом. Смена типа и удаление запрещены, пока у
объекта есть строки плана, размещения, сдачи заказа или ссылки из промо. Удалённый объект
(не слитый и не сменивший тип) возвращается с тем же номером снятием tombstone (30.10.2026).

**`assets`** — логический файл (§4). `id`, `model_id`, `created_in_item_id`
(неизменяемый; объект, в котором файл появился), `media_kind` (`video | image`),
`current_version_id`, `variant_kind` (`none | uniq`), `variant_no?`, `uniq_level?`
(`soft | trim | mirror`), `retired_at`, `created_at/by`.
FK `(model_id, id, current_version_id)` → `asset_versions (model_id, asset_id, id)`
DEFERRABLE; CHECK `(variant_kind = 'uniq') = (variant_no IS NOT NULL AND uniq_level IS NOT NULL)`;
частичный UNIQUE `(model_id, created_in_item_id, variant_no) WHERE variant_kind = 'uniq'` —
`FYP-0012/u2`. Уникальная версия FYP — отдельный ассет с происхождением от мастера;
её переделка — следующая версия этого ассета (`u2_v2`). Самостоятельный новый монтаж
— новый объект.

**`asset_versions`** — неизменяемая редакция (§3, §4). `id`, `model_id`, `asset_id`,
`version_no` (с 1), `master_sha256` → `blobs`, `source_sha256?`, `source_revision_id?`,
`work_id?` (какая работа создала), `duration_ms`, `width`, `height` (фактические,
§9.3), `created_at/by`.
UNIQUE `(model_id, asset_id, version_no)`; UNIQUE `(model_id, asset_id, id)`;
индекс `(master_sha256)` — «какие версии держат этот блоб».
Уникальности по `(asset_id, master_sha256)` нет: повторное принятие прежних байт —
законная новая редакция. Строки не обновляются и не удаляются.

**`item_memberships`** — участие файла в объекте (§4, §7.1).

| Колонка | Смысл |
|---|---|
| `id`, `model_id`, `item_id`, `asset_id` | связь; `item_id` и `asset_id` неизменяемы |
| `kind` | `owned \| reference`; ссылка — подборка `PRM` |
| `role` | `master teaser pic raw ed clip thumb cap` (naming §3) |
| `ordinal` | номер порядковой роли `pic07`; CHECK `(role IN pic,raw,ed,clip) = (ordinal IS NOT NULL)` |
| `variant_no` | номер уникальной версии: 0 — базовый файл, 2 — `u2`; хендл (`ed07`, `u2`) не хранится, считается в view и коде (схема §9.2) |
| `display_position` | порядок показа; NULL у снятого |
| `selected` | отобран (кадры сета, §4) |
| `life_use` | `feed \| chats \| both` — только LIFE (§4); ставится по кадру, статус поля `purpose` — у версии (`version_id`) |
| `pinned_version_id` | только для `reference`; NULL — следовать текущей версии |
| `added_at/by`, `removed_at`, `row_version` | |

Ключи: частичный UNIQUE NULLS NOT DISTINCT `(model_id, item_id, role, ordinal,
variant_no) WHERE kind = 'owned'` — навсегда, включая снятые: под-хендл `SET-069/ed07`
никогда не достаётся другому файлу (повторное добавление того же файла восстанавливает
прежнюю строку); ссылки `reference` под этот ключ и под CHECK «роль подходит типу» не
попадают — подборка `PRM` держит два мастера и `ed`, `teaser` чужих объектов;
UNIQUE `(model_id, item_id, asset_id)`; частичный UNIQUE `(model_id, asset_id)
WHERE kind = 'owned' AND removed_at IS NULL` — владелец один;
UNIQUE `(model_id, item_id, display_position) DEFERRABLE` — перестановка одной
транзакцией; FK `(model_id, asset_id, pinned_version_id)` → `asset_versions`.
Индексы: `(model_id, item_id, removed_at, display_position)`;
`(model_id, asset_id, removed_at)` — «где ещё этот кадр».
Отбор и порядок принадлежат членству: перестановка в подборке не трогает сет.

**`asset_manifests`** и **`asset_manifest_entries`** — закрытый состав версий (§4, §7,
§7.1, §8.2). Заголовок: `id`, `model_id`, `purpose`
(`plan | download | delivery | submission`), `origin_item_id?`, `entry_count`,
`created_at/by`; состояния нет — состав вставляется закрытым одной короткой транзакцией
без медиа-операций (схема §9.2), потребители ссылаются на `(model_id, manifest_id)`.
Строки: `id`, `model_id`, `manifest_id`,
`position`, `item_id`, `membership_id?`, `asset_id`, `asset_version_id`,
`handle_snapshot`, `selected_snapshot?`, `life_use_snapshot?`.
UNIQUE `(model_id, manifest_id, position)`; FK `(model_id, asset_id, asset_version_id)`
→ `asset_versions (model_id, asset_id, id)`; FK на членство. Правка закрытого состава —
новый состав.

**`aliases`** — историческая ссылка (§4, §6.3, naming §9). `id`, `model_id`, `kind`
(`legacy_path | legacy_name | legacy_id | sub_handle | merged_id | vault_album |
tg_card | resource_id | registry_row`), `value_raw`,
`value_norm` (STORED: `lower(normalize(value_raw, NFC))`), `item_id?`, `asset_id?`,
`source_object_id?`, `note`, `created_at/by`. CHECK ровно одна цель из `item_id` /
`asset_id`.
Уникальности по значению нет: старый `PPV-032` относился к трём папкам; повтор
импорта не плодит строки благодаря UNIQUE NULLS NOT DISTINCT
`(model_id, kind, value_norm, item_id, asset_id)`.
Индексы: `(model_id, value_norm)`; GIN `pg_trgm (value_norm)`.
Алиасы, включая исходные пути и имена файлов, видит каждый, кто видит модель (решение
владельца 30.10.2026: ник фана в старом имени не прячется).

**`provenance`** — происхождение (§2.1 п. 5, §4). `id`, `model_id`, `relation`
(`montage_from | uniq_from | teaser_from | frame_from | processed_from |
ppv_from_custom | extracted_from | remaster_from | split_from | merged_from |
reencoded_from`; `extracted_from` — «выделен из» сырья, §6.1),
`child_item_id?`, `child_version_id?`, `parent_item_id?`, `parent_version_id?`,
`params jsonb` (уровень и номер уникальной версии, диапазоны нарезки), `basis`,
`work_id?`, `voided_by_id?`, `created_at/by`. CHECK ровно один ребёнок и ровно один
родитель; UNIQUE NULLS NOT DISTINCT по пяти полям связи; составные FK на все концы.
Объектные связи (`PPV ← CUS`) и связи версий (`ed07 v1 ← raw07 v1`) в одной
таблице с типизированными концами. Цикл проверяется в коде под блокировкой объектов.
Индексы в обе стороны; частичный по `relation = 'ppv_from_custom'` для плашки
«готов для PPV».

**`tags`** и **`item_tags`** (§8.3, naming §4). Словарь: `id`, `model_id?` (NULL —
общий известный тег), `slug`, `label_ru`, `tag_group?` (`action | attribute | mood`),
`merged_into_tag_id?`, `created_at/by`. UNIQUE NULLS NOT DISTINCT `(model_id, slug)`.
Свободный тег живёт в своей модели (подсказки одной модели не раскрывают текст
другой); группу ему можно проставить позже. Связь: `model_id`, `item_id`, `tag_id`,
`source` (`ai | human | import`), `group_at_import?`, `added_at/by`;
PK `(model_id, item_id, tag_id)`; индекс `(model_id, tag_id)` для сочетаний.

**`annotation_fields`** — статус каждого поля разметки (§5, §8.3).
Цель — ровно одна из `item_id?`, `version_id?`, `group_id?`, `draft_id?` (ключ и FK —
схема §9.2); `field` — `title | title_en | description | tags |
chronology | purpose | second_person`; `value_version bigint`
(растёт при каждой записи значения), `confirmed_value_version?`, `confirmed_at/by`,
`suggested_by_run_id?`, `updated_at/by`. Статус вычисляется:
`confirmed` ⇔ `confirmed_value_version = value_version`. Ручная правка поля —
значение + `value_version + 1` + подтверждение одним действием только в этом поле.
«Подтвердить всю разметку» получает с экрана список `(field, value_version)` и
подтверждает ровно их; появившееся после нажатия значение остаётся черновиком.
Статусы группы и черновика при принятии переносятся на объект и версию (UPDATE цели),
чтобы название сета, набранное до сжатия сорока фото, не потеряло подтверждения.

**`annotation_runs`** — прогон разметки (§8.3, §12.0). `id`, `model_id`,
`target_kind`, `target_id`, `input_kind` (`source | version`), `input_sha256`,
`provider`, `model_name`, `prompt_version`, `params jsonb`, `config_digest`,
`frames_count`, `work_id`, `state`, `cost_usd`, `tokens jsonb`, `raw_response jsonb`,
`refusal_reason`, `error`, `started_at`, `finished_at`.
UNIQUE `(model_id, target_kind, target_id, input_sha256, config_digest)`.
До готовности мастера вход — проверенный source; после принятия результат
привязывается к версии, а прогон не переписывается так, будто ИИ видел мастер.

**`annotation_suggestions`** — предложение по полю: `id`, `model_id`, `run_id`,
`field`, `value jsonb`, `applied_at?`, `applied_value_version?`, `rejected_at?`.
UNIQUE `(model_id, run_id, field)`. Применение — `UPDATE annotation_fields … WHERE
confirmed_value_version IS DISTINCT FROM value_version` (поле ещё черновик):
запоздалый ответ ИИ физически не может затереть подтверждённое.

**`chronology_entries`** — хронология по минутам (§8.3, PRD §5). `id`, `model_id`,
`item_id`, `asset_version_id`, `at_ms`, `end_ms?`, `text`, `source`, `run_id?`,
`frame_artifact_id?` (кадр — кандидат в тизер), `tsv STORED`.
UNIQUE `(model_id, asset_version_id, at_ms)`; индексы `(model_id, item_id, at_ms)`,
GIN `tsv`. Статус хронологии — строка `annotation_fields` с `version_id`:
после перемонтажа подтверждённая хронология v1 остаётся при v1 и показывается как
«подтверждено для прежней версии», v2 размечается заново черновиком. Поиск отвечает
версией и минутой.

**`platform_texts`** — продающие тексты и `platform_title` (PRD §5, naming §4). `id`,
`model_id`, `item_id`, `platform` (`generic | fansly | onlyfans`), `account_id?`,
`locale`, `variant_no`, `title`, `body`, `value_version`, `confirmed_value_version?`,
`confirmed_at/by`, `source`, `run_id?`. UNIQUE NULLS NOT DISTINCT
`(model_id, item_id, platform, account_id, locale, variant_no)`. Два английских
варианта PPV — строки `generic/en/1` и `generic/en/2`; вариант для аккаунта — своя
строка с происхождением от общей. В имена файлов и vault-альбомы не попадает.

### 3.3. Байты и производные

**`blobs`** — неизменяемые байты (§2.1 п. 4, §9.1). `sha256 bytea` PK
(CHECK `octet_length = 32`), `byte_size`, `mime`, `ext` (нижний регистр), `media_kind`,
`storage_key` (UNIQUE; `blobs/sha256/ab/cd/<hex>.<ext>`), `state`
(`present | purged | missing | corrupt`), `registered_at`, `purged_at`, `verified_at`.
Строка никогда не удаляется — иначе `verify-blobs` не отличит «удалили осознанно» от
«потеряли байты».
Карантина нет: байты без ссылок удаляет только команда владельца по отчёту
`verify-blobs` (30.10.2026). `backed_up_at` и индекс очереди бэкапа добавляет миграция
бэкапа (схема §9.5).
Счётчик ссылок не хранится: «нуль ссылок» — одна SQL-функция `blob_is_referenced`
по списку из принципа 6, и тест, который сверяет этот список с каталогом FK.

**`blob_probes`** — ffprobe и EXIF по ключу `(sha256, kind, recipe_digest)`
(§12.0): `duration_ms`, `width`, `height`, `rotation`, `fps_num`, `fps_den`,
`video_codec`, `pix_fmt`, `bit_rate`, `is_hdr`, `audio_tracks jsonb`,
`shot_at timestamptz?`, `shot_at_local timestamp?`, `shot_tz?` (EXIF без зоны не
превращается в выдуманный UTC), `camera jsonb`, `raw jsonb`, `computed_at`.
Индексы `(duration_ms, width, height)` — кандидаты по данным Hub (§7); `(shot_at)`.

**`blob_phashes`** — перцептивный хэш фото (§6.2, §12.0). PK `(sha256, algorithm,
algo_version, normalization)`, `phash bit(64)`, `computed_at`. Подсказка «похоже на
фото № 7 из сета 69» ищется по версиям текущей модели полным проходом с
`bit_count(phash # :probe)`; порог — `policy_settings`. Ничего не объединяет.

**`master_checks`** — как и чем получен мастер (§9.2): что сделано (`decision`), исход
проверки (`verdict`), кадры, звук, метаданные, размеры, время, отчёт; индекс
`(master_sha256)`. Колонки, списки, ключ и правило приёмки — схема §9.2.

**`storage_operations`** — намерение записать или удалить байты, чтобы падение
между файловой операцией и записью в БД было обнаружимо. `id`, `kind`
(`put | purge`), `blob_sha256`, `from_key`, `to_key`,
`state` (`intent | started | fs_done | committed | failed | cancelled`; отменить
можно только `intent`, SPEC §4.2), `owner`, `started_at`,
`finished_at`, `error`. Частичный UNIQUE активной операции по `blob_sha256`.
Порядок `put`: временный файл на том же томе → проверка и хэш → `fsync` файла →
`rename` без замены → `fsync` каталогов → `blobs.state = 'present'` в БД. Удаление
(`purge`, только командой владельца): `intent` в БД → `started` в БД → удаление файла →
`fs_done` → `purged` в БД. Файловых замков на SHA нет:
байты пишет и удаляет один процесс, а мастер с живой версией не удаляется вообще.

**`rendition_generations`** — физическая сборка производной (§9.1, §9.3). `id`; ключ
производной — `master_sha256?`, `kind` (`preview | poster | thumb320 | thumb640 |
preview2048 | frames | platform`), `recipe_digest` вида, `meta_stripped` — и `is_active`
(частичный UNIQUE по ключу `WHERE is_active`, схема §9.1); `input_kind` (`source |
master`), `input_sha256`, `state` (`building | ready | failed | evicted`), `work_id?`,
`created_at`, `ready_at`, `bound_at`. Готовая копия отдаётся из кэша, повторно не
кодируется. Первое поколение превью, миниатюр и
кадров строится из source при приёмке, когда хэша мастера ещё нет: `master_sha256` пуст,
адрес — по `id` поколения. После проверки мастера поколение один раз привязывается к
ключу (`bound_at`), адрес не меняется. Пересборка из мастера или по новому рецепту вида —
новое поколение; `is_active` переключается, прежнее поколение отдаётся, пока новое не
собрано, и не подменяется другими байтами под прежним адресом. Промо-копии и совместимой
копии H.264 среди производных нет: промо берёт копию для платформы или мастер, совместимая
копия — выдача (схема §3.5).

**`rendition_artifacts`** — файл внутри поколения. `id`, `generation_id`, `name`
(из манифеста производных §9.3: `preview.mp4`, `thumb-640.webp`, `frames/0042.webp`),
`output_sha256`, `byte_size`, `mime`, `width`, `height`, `duration_ms`, `frame_ms?`,
`storage_key` (UNIQUE; `derived/gen/<generation_id>/<name>`), `state`
(`ready | evicted | missing`), `created_at`, `last_used_at`.
UNIQUE `(generation_id, name)`; UNIQUE `(id, output_sha256)` — для квитанций выдачи.
Адрес наружу `/api/v1/<model>/g/<generation_id>/<name>` проверяет права по версии или
черновику, к которым относится поколение, и лишь потом `X-Accel-Redirect`.
Удаление файла меняет `state`, описание остаётся: квитанция выдачи всегда знает, что
именно уходило.

### 3.4. Источники, приёмка, фон

**`sources`** — откуда приходят байты и метаданные (§4, §6.1, §6.3). `id`,
`model_id`, `kind` (`yandex_disk | dropbox | web_upload | legacy_metadata`, схема §9.7; оба
облачных — за одним интерфейсом источника, SPEC §6.1), `label`,
`credentials_ref` (имя переменной окружения; сам токен в БД
не хранится), `root_path` (папка модели у источника, из конфигурации bootstrap), `read_only`,
`enabled`. UNIQUE `(model_id, label)`;
CHECK `kind NOT IN ('yandex_disk', 'dropbox') OR read_only` — инвариант §2.1 п. 6 в схеме;
у облачного источника `root_path` и `credentials_ref` обязательны. Курсор свежих изменений и
начало последнего полного обхода — в `report` последней успешной работы `scan` источника
(потоки `scan:<источник>` раз в 5 мин и `scan-full:<источник>` раз в сутки), отдельной
таблицы состояния скана нет (2в, 30.10.2026).
Локальная копия легаси — не вид источника: путь — переменная `LEGACY_SOURCE_ROOT`, байты
читаются как та же ревизия Я.Диска (`verified_route = local_copy`).

**`source_objects`** — внешний ресурс (§4, §6.1). `id`, `model_id`, `source_id`,
`resource_id?` (ID файла у источника: `resource_id` Я.Диска или `id` Dropbox), `upload_id?`
(веб), `current_path`, `current_name`, `is_dir`,
`parent_id?`, `archive_revision_id?`, `archive_entry_no?` (член распакованного архива:
`(ревизия архива, номер входа)`, а не только имя — одинаковые имена внутри ZIP различимы,
схема §9.7; снимок записывает их из оглавления ZIP без распаковки, путь — путь архива, `/` и
путь внутри),
`current_revision_id?`, `first_seen_at`, `last_seen_at`, `gone_since?`.
Частичные UNIQUE `(model_id, source_id, resource_id)` и
`(model_id, archive_revision_id, archive_entry_no)`; путь не уникален — на старом пути
может появиться новый ресурс. Индексы `(model_id, last_seen_at)`, GIN `pg_trgm` по
`current_path` (поиск по старому пути, §11.2).

**`source_paths`** — история путей и имён (§6.1: rename/move). `id`, `model_id`,
`source_object_id`, `path_raw`, `path_nfc`, `name`, `first_seen_at`, `last_seen_at`.
UNIQUE `(model_id, source_object_id, path_nfc)`. Переименование даёт новую строку и
алиас у привязанного ассета, не новый черновик.

**`source_revisions`** — наблюдённое состояние байтов (§6.1 «новое и
изменившееся»). `id`, `model_id`, `source_object_id`, `sequence_no`, `md5?` (Я.Диск),
`content_hash?` и `remote_rev?` (Dropbox), `byte_size`, `remote_created_at?` (время
появления в источнике: `created` Я.Диска, `server_modified` Dropbox; по нему дата прихода
и срок старых кастомов), `remote_modified_at?`, `remote_shot_at?` (время съёмки от источника:
EXIF Я.Диска, `media_info` Dropbox), `media_type?` (`media_type` Я.Диска; у Dropbox и членов
архива — по расширению), `crc32?` (член архива: CRC-32 из оглавления ZIP), `detected_at`,
`scan_work_id?`, `source_sha256?`,
`verified_at?` (сумма источника сошлась: MD5 Я.Диска или `content_hash` Dropbox; SHA-256
посчитан), `verified_route`
(`download | local_copy | upload`), `previous_id?`, `frozen_by_work_id?` и `frozen_path?`
(ревизию закрепил снимок `scan:freeze` и путь, на котором он её видел; пишутся вместе и один
раз, SPEC §6.3: снимок — эти строки в базе, полнота листинга каталогов — в `report` работы).
Член архива — тоже ревизия: размер без сжатия и CRC-32 из оглавления.

Снимок (`apps/server/src/intake/freeze.ts`, 2в, 30.10.2026) — работа `scan` с
`dataset = 'freeze'`, `scope` = источник, `work_key = scan:freeze:<дата>` (одна на модель и
дату); ставится только командой оператора (`ops.js freeze`), планировщик её не ставит. Проход
пишет объекты, пути и ревизии, но не группы и черновики; закрепляет ревизии только в той же
транзакции, что завершает работу. Каталог, изменившийся или пропавший во время листинга, и
оборванный проход — частичный проход: ничего не закрепляется, работа повторяется. Каталог с
нечитаемым ответом API и архив без оглавления (не ZIP, битый ZIP) — неполный вход: ревью-кейс
`unreadable_input` (ключ `dir:<id>` или `archive:<ревизия>`), снимок не держат. `report`:
`files`, `dirs`, `dirs_complete`, `incomplete_dirs` (путь и причина), `archives`,
`archives_read`, `unreadable_archives`, `members` (знаменатель участников), `pinned`,
`pinned_before` (закреплены более ранним снимком), `complete`. Выгрузка реестра — JSONL по
команде (`ops.js freeze-export`).
UNIQUE `(model_id, source_object_id, sequence_no)`; UNIQUE `(model_id,
source_object_id, id)`; уникальности по MD5 или SHA нет: A→B→A — три ревизии.
Индекс `(model_id, source_sha256)` — точные дубли (§6.2). Скачивание относится к
конкретной ревизии с ожидаемыми MD5 и размером: если файл изменился во время
скачивания, байты не приписываются старой ревизии, создаётся следующая.
Повтор неизменившегося состояния только обновляет `last_seen_at` у объекта.
Локальная копия легаси — способ чтения той же ревизии Я.Диска, не второй источник.

**`inbox_groups`** — папка или кластер как единица принятия (§4, §6.1, §6.3). `id`,
`model_id`, `source_id`, `group_key` — всегда с ID папки у источника, не путь:
`folder:<id папки>`, `exif-day:<id папки>:2026-08-07`, `upload-window:<id папки>:…`,
`single:<id файла>`, `split:<uuid>`, у веб-загрузки — `upload:<upload-id первого файла>`
(`manual`, источник `web_upload` «Веб-загрузка» модели заводится при первой загрузке);
`grouping` (`folder | exif_day | upload_cluster |
single | manual`; правило группировки — одно, SPEC §6.1; `manual` — новый файл в принятой
папке «отдельным объектом»),
`folder_object_id?`, `evidence jsonb`, `discovered_at`,
`closed_at`, `row_version`. UNIQUE `(model_id, source_id, group_key)`. Созданный объект
находится по `content_items.created_from_group_id`. Группа — предложение с уликами, до принятия её
можно разделить или объединить вручную. Разметка полей будущего объекта ведётся на
группе (`annotation_fields` с `group_id`) и переносится на объект; значения —
колонки группы, как в образце 1б: `proposed_type`, `proposed_title`, `proposed_title_en?`,
`proposed_description`, `proposed_tags jsonb`, `proposed_ppv_kind`, `proposed_purpose`,
`has_second_person`, `custom_order_id?`. Одиночный файл — группа из одного черновика
(`single`), поэтому `inbox_drafts.group_id` обязателен. ИИ предлагает оба названия
вместе; человек или агент утверждает каждое поле. `proposed_title_en` при принятии
переносится в `content_items.title_en`; отсутствие английского названия приёмку
не блокирует.

**`inbox_drafts`** — черновик приёмки с момента обнаружения (§5, §6.1).

| Колонка | Смысл |
|---|---|
| `id`, `model_id`, `group_id` | одиночный файл — группа из одного черновика |
| `source_revision_id?` / `web_upload_id?` / `from_version_id?` | ровно одно; UNIQUE по первым двум — одна ревизия = один черновик; `from_version_id` (составной FK на принятую версию) — «PPV из кастома как есть», «мастер PPV» и «исходник фупа» из сырья (SPEC §6.1): мастер и отметка проверки берутся из неё, повтор держит Idempotency-Key |
| `origin` | `disk_scan \| web_upload \| legacy_import \| archive \| derived` |
| `state` | `discovered \| processing \| ready \| resolved` (предварительно, §13) |
| `outcome?` | `new_item \| append \| alias \| rejected`; CHECK `(state = 'resolved') = (outcome IS NOT NULL)` |
| `priority` | новое и мелкое вперёд, старый корпус фоном (§12.0) |
| `discovered_at`, `ready_at`, `decided_at/by` | |
| `md5`, `byte_size`, `path`, `preview_url_at` | копия для экрана «Приехало» до скачивания |
| `source_sha256?`, `master_sha256?`, `master_verified_at?` | шаги 1 и 3 фона |
| `master_is_source` | мастер — сам исходник без перекодирования (§9.2; когда — схема §9.2 `master_checks`) |
| `proposed_role`, `proposed_ordinal`, `proposed_life_use?` | предложение шага 4 для файла, у лайфа — и назначение кадра; поля будущего объекта — на группе |
| `target_item_id?`, `target_asset_id?` | для «дополнение»: объект и, если это новая версия, файл |
| `duplicate_of_version_id?` | для «дубль-алиас» |
| `blocked_reason?` | `ambiguous_order \| video_in_set \| id_collision \| cross_model_dup \| master_failed \| needs_type \| source_unavailable \| deferred \| which_frame \| row_changed` (◆ «Подставить монтаж в строку?»: монтаж загружен для строки плана, которая уже не ждёт — отменена или занята; ◆ «К какому кадру?»: обработанный кадр, чьё имя не найдено в квитанциях выдачи, SPEC §6.1; найденный — `ed` с номером исходного кадра и происхождением `processed_from`) |
| `applied_item_id?`, `applied_version_id?` | результат принятия |
| `reject_reason`, `error`, `row_version`, `search_tsv STORED` | |

Цепочка (2в, 30.10.2026): обнаружение ставит `fetch:<ревизия>`; `fetch` кладёт сверенные байты
в `TMP_ROOT/staging/<sha256>.<ext>`, пишет `source_sha256` ревизии и черновика и ставит
`derive_video` + `encode_master` (видео) или `derive_image` (фото) с `draft_id`; мастер фото — сам
исходник после полного декодирования в `derive_image` (регистрируется блобом, §9.2 SPEC);
черновик с проверенным мастером — `ready`. Исходник в `staging/` удаляется, когда мастер
зарегистрирован и медиаработ этих байтов не осталось (у фото — атомарный перенос в `blobs/`,
иначе — проход `worker` раз в 5 мин и сразу после принятия). Точный дубль принятой версии модели закрывается
сам (`alias`), пути — алиасы файла; кастом ↔ PPV — кандидат `exact_duplicate`, не алиас. Черновики,
которые ещё ждут с теми же байтами, закрываются так же в транзакции принятия (кроме `derived`;
занятый параллельным принятием пропускается); близнецы внутри одной группы дают один файл, остальные —
алиасы без своего мастера (приёмка 2в, 30.10.2026). «Принять как есть» — `as_is` команды принятия.
Принятие группы, уже создавшей объект, дополняет этот объект. Роли нового объекта: PPV —
до двух видео (больший — мастер, второй — тизер) и фото; CUS — одно видео и фото; FYP —
один ролик; SET — только фото (видео — ◆ «Видео среди фото»); SXT, LIFE — клипы и фото;
RAW — всё сырьё; PRM в приёмке не создаётся (4в).

CHECK `outcome NOT IN ('new_item','append') OR master_verified_at IS NOT NULL` —
«принять можно только с проверенным мастером» (§6.1); для дубля и отказа мастер не
нужен. Индексы: `(model_id, state, priority DESC, discovered_at)`; частичный
`(model_id, blocked_reason) WHERE blocked_reason IS NOT NULL`; `(master_sha256)`,
`(source_sha256)`; GIN `search_tsv` — черновик сразу в поиске (PRD §5).
Черновик не удаляется: объект и версия ссылаются на него. Ошибка фона и отказ
человека — разные поля.

**`inbox_draft_candidates`** — кандидаты-связи с уликами (§6.1, §6.2, §8.2). `id`,
`model_id`, `draft_id`, `kind` (`order | existing_item | exact_duplicate |
similar_photo | legacy_id | source_parent | content_type`), `order_id?`, `item_id?`,
`version_id?`, `score`, `signals jsonb` (reply, имя, раздел, `resource_id`,
длительность, окно), `evidence_refs jsonb` (`tg:…`, путь), `conflicts_with uuid[]`,
`chosen`, `chosen_at/by`, `dismissed_at`.
UNIQUE NULLS NOT DISTINCT `(model_id, draft_id, kind, order_id, item_id, version_id)`;
частичный UNIQUE `(model_id, draft_id, kind) WHERE chosen`. Совпадение только по
длительности и дате автоматически не выбирается (§8.2).

**`web_uploads`** — веб-загрузка (§6.1). `id`, `model_id`, `upload_id`,
`principal_id`, `client_filename`, `declared_kind` (`fyp_edit | teaser |
processed_frames | master_version | other`), `target_item_id?`, `plan_row_id?`
(задача; исходники берутся из её `input_manifest_id`), `size_expected`,
`bytes_received`, `sha256?`, `state` (`receiving | received | verified |
registered | failed | abandoned`), `tmp_key`, `error`, `created_at`,
`completed_at`. UNIQUE `(model_id, upload_id)`; частичный индекс незавершённых. Черновик
загрузки — `inbox_drafts.web_upload_id` (UNIQUE: одна загрузка — один черновик); обратной
ссылки нет.
Порядок: файл докачан и сверен → блоб в `blobs/` → черновик обычной приёмки.
Как это сделано (2в, 30.10.2026): строка заводится при создании загрузки tus (`receiving`,
`tmp_key = inbox/web/<model>/<upload-id>/data` под `DATA_ROOT`), `bytes_received` пишется после
каждого куска, `received` — когда пришли все байты. Команда `POST …/uploads` сверяет размер,
считает SHA-256 и ссылкой переносит файл в `blobs/` по протоколу хранилища (`verified`, хэш);
затем одной транзакцией — группа и по черновику на загрузку (`registered`), с целью — там же
принятие. Блобом становится и «Другое», видео тоже: `encode_master` читает его из `blobs/`, в
`staging/` веб-загрузка не кладётся. Отмена в лотке — `abandoned`; сбой регистрации — `failed`
с `error`; брошенная загрузка остаётся `receiving`, уборки пока нет.

**`work_operations`** — фоновая работа в доменной таблице (§5, §12.0).

| Колонка | Смысл |
|---|---|
| `id`, `model_id?` | модель пуста у общесистемных (`verify_blobs`, `backup`) |
| `kind` | каждый вид ровно одной роли (SPEC §12.0). `worker`: `scan \| fetch \| hash \| unpack_archive \| import_parse \| register \| propose \| export \| hub_sync \| hub_history \| hub_publish \| annotate \| verify_blobs \| backup`; `worker-video`: `derive_video \| encode_master \| verify_master \| render \| uniq_render \| render_compat \| extract_frame`; `worker-image`: `derive_image`. `derive_*` — один проход: ffprobe или EXIF, превью, миниатюры, кадры, у фото и pHash (SPEC §12.0); `hub_history` — проход по истории страницы Fansly (на OnlyFans прохода нет); `hub_publish` — загрузка файлов, черновик, утверждение и отмена своей публикации Hub (5б); под `COPY_JOBS=1` рядом с кодерами — то, чего ждёт КМ: `render` (копия для платформы), `render_compat` (совместимая H.264), `extract_frame` (кадр в полном размере) |
| `work_key` | естественный ключ: `fetch:<revision>`, `master:<source_sha>:<recipe>`, `uniq:<parent_version>:<level>:<n>`, `export:<receipt>` |
| `draft_id?`, `source_revision_id?`, `asset_version_id?`, `manifest_id?`, `receipt_id?`, `generation_id?`, `account_id?` | типизированные цели |
| `dataset?`, `scope?`, `window_from?`, `window_to?` | входы опроса Hub и бэкапа; неизменны, окно входит в `work_key` — новый прогон или интервал даёт новую строку |
| `pipeline_version?`, `recipe_digest?` | у опроса Hub, скана и бэкапа версии конвейера нет |
| `state` | `pending \| running \| retry_wait \| succeeded \| failed \| cancelled` |
| `paused_reason?` | `switch_off:<ключ>` — работа выключенной области (SPEC §8) отпущена до включения (схема §9.2) |
| `priority`, `attempt_no`, `next_attempt_at` | политика повторов в домене; 429 Я.Диска — backoff |
| `lease_owner`, `lease_until`, `fence_generation`, `heartbeat_at` | аренда; истекла — работу можно взять снова; завершить результат может только держатель текущего поколения |
| `input_sha256`, `output_sha256`, `output_ref` | отпечатки входа и выхода |
| `progress_num`, `progress_den`, `progress_note`, `checkpoint jsonb` | «докачка 3,2 ГБ из 5,8», смещение, номер прохода |
| `failure_kind` (`transient \| permanent`, предварительно), `error_code`, `error_text` | `transient` — повтор с паузой, `permanent` — сразу `failed` |
| `report jsonb?` | итог прогона: отчёт `verify_blobs` (вместо `storage_findings`), итог опроса Hub и бэкапа; после успеха неизменен |
| `stream_key?` | поток периодической работы (`hub:<account>:<dataset>`, `scan:<source>`, `backup`); у потока не больше одной незавершённой строки |
| `created_at`, `started_at`, `finished_at` | |

UNIQUE `(model_id, kind, work_key)` NULLS NOT DISTINCT — повторная постановка не
создаёт вторую работу; частичный UNIQUE `(model_id, kind, stream_key)` NULLS NOT
DISTINCT `WHERE stream_key IS NOT NULL AND state IN ('pending','running','retry_wait')`; захват —
короткой транзакцией с `FOR UPDATE SKIP LOCKED` по видам своей роли, предикат
`paused_reason IS NULL AND state IN ('pending','retry_wait') AND next_attempt_at <= now()` или
`state = 'running' AND lease_until < now()`; поколение аренды проверяется на каждом
чекпойнте, продлении и завершении, потерявший аренду останавливает свой процесс;
успех неизменен. CHECK: строка без модели не несёт модельных целей; `model_id`
пустым бывает только здесь, в `idempotency_keys`, `action_log`, у глобальных строк
`policy_settings` и у общих тегов — список держит структурный тест. Частичные индексы
`(next_attempt_at, priority) WHERE state IN ('pending','retry_wait')`,
`(lease_until) WHERE state = 'running'`, `(draft_id)`. Готовый шаг с тем же
`input_sha256` выходит сразу. Долгий FFmpeg или HTTP не выполняется внутри
транзакции БД. Строка работы вставляется в той же транзакции, что и доменная запись;
отдельного уведомления нет.

**`legacy_claims`** — разобранные сведения старых имён (§6.3). `id`, `model_id`,
`source_object_id`, `source_revision_id?`, `parser_version`, `claim_key`,
`raw_fragment` (`used3_04.08.26`, `[Set-002]`, `X.X.X`), `claim_kind` (`number |
used | posted | date | role | registry_row | duration | title | tag | origin | unknown`;
`title` — хвост имени кастома и описание в имени папки, `tag` — `optional/`, `extra/`,
`нюды/`, BG, вендор, `origin` — улики `IMG_*`, `copy_*`, `lv_0_*`, `PMR*`, `кастом_<ник>`;
добавлены 30.10.2026 с парсером `packages/legacy`), `payload jsonb`,
`parse_work_id`, `resolution` (`pending | resolved | ignored`), `superseded_by_id?`
(незакрытая заявка прежней версии правил становится `ignored` со ссылкой на преемника,
заявки не удваиваются), `resolved_item_id?`,
`resolved_version_id?`, `resolved_alias_id?`, `resolved_evidence_id?`,
`resolved_order_id?`, `resolved_at/by`.
UNIQUE `(model_id, source_object_id, parser_version, claim_key)`; CHECK при
`resolved` ровно одна цель. `pending` — «неразобранные сведения остаются в очереди
со ссылкой на источник»; полезное материализуется в своих таблицах (поле объекта,
размещение с уликой `import`, связь с заказом), payload их не заменяет.

**`legacy_number_claims`** — заявки старых номеров (§6.4). `id`, `model_id`, `type`,
`claimed_number`, `source_object_id`, `claim_id` (заявка имени или строка реестра, из
которой номер), `registry_claim_id?`, `decision` (`keep |
renumber | typo | unclear`), `assigned_number?`, `target_item_id?`, `decided_at/by`.
Решение по SPEC §6.4 ставит проход (`decided_by` пуст — «по правилам»); человек
подтверждает или меняет его в «Разборе старого», и его решение переходит на заявку новой
версии правил.
Индекс `(model_id, type, claimed_number)`; уникальности по номеру нет — `PPV-032`
заявлен тремя папками. Порядок: до первого принятия по типу выполняется проход по
метаданным снимка, все заявки записываются, счётчик поднимается выше максимума;
только потом байты. Иначе коллизия `032` получит `073` раньше папки `[PPV-073]`.

**`review_cases`** — спорное, чьё решение надо записать (§6.3, §4,
`resolve_review_case` §12.0). `id`, `model_id`, `kind` (`cross_model_duplicate |
legacy_unparsed | merge_split | unreadable_input | smm_folder | number_hole`;
`unreadable_input` — нечитаемый архив или каталог снимка:
неполный вход, ворота не держит, §6.3; `smm_folder` — папка SMM, которую человек или агент
отмечает паком подрядчику или съёмкой вендора; `number_hole` — номер без источника,
SXT-010/011 по SPEC §6.4; `merge_split` из прохода — одиночки и пары в корне раздела),
`state` (`open | resolved | dismissed`),
`dedup_key`, `draft_id?`, `item_id?`, `version_id?`,
`source_object_id?`, `blob_sha256?`, `counterpart_model_id?` (виден только тому, у
кого права на обе модели), `details jsonb`, `resolution jsonb`, `resolved_at/by`.
UNIQUE `(model_id, kind, dedup_key)`. Сюда не кладётся вычисляемое из улик (два
кандидата, «пропущена», «слишком рано», конфликт размещения) — только то, что нельзя
пересчитать. Не дублируется и записанное на своём месте: спор о номере —
`legacy_number_claims.decision`, выбор заказа — `blocked_reason` и кандидаты
черновика (30.09.2026).

**Слияние и разделение пачек RAW** (§6.3, §4.1) — одна команда без своих таблиц:
членства, алиасы и tombstone — одной транзакцией с одним `request_id`; «что было до»
собирается из журнала по `request_id` (30.09.2026). Слияние: младший номер
остаётся, у прежних членств `removed_at`, в выжившем создаются новые с новыми
номерами, старые под-хендлы сохраняются алиасами `sub_handle`, проигравший — tombstone
и алиас `merged_id`. Разделение: одна часть остаётся под исходным номером, остальным
— новые номера той же транзакцией. Ни одна версия при этом не создаётся и не меняется.

### 3.5. План и выдача

**`ppv_releases`** — выпуск PPV (§4, §7). `id`, `model_id`, `account_id`, `item_id`,
`release_date` (по `Europe/Moscow`; по ней считается норма недели — предварительная
заливка в vault в воскресенье не создаёт второго выпуска), `created_at/by`,
`cancelled_at/by`. UNIQUE `(model_id, id, account_id, item_id)`; CHECK тип объекта
PPV (триггер).

**`posting_plan_rows`** — строка плана (§4, §7).

| Колонка | Смысл |
|---|---|
| `id`, `model_id` | |
| `item_id?` | пусто, пока строка ждёт монтаж |
| `account_id`, `surface_id` | куда |
| `slot_date`, `slot_time?`, `slot_at STORED` | плановая дата в имени скачивания — ISO (naming §6) |
| `assignee_id?` | исполнитель; пусто — текущий `default_assignee_id` страницы, заполняется только при выборе другого человека («Передать другому») |
| `release_id?`, `release_surface_kind?` | выпуск PPV; UNIQUE `(release_id, release_surface_kind)` частичный — по строке на поверхность |
| `manifest_id?` | закрытый состав выбранных версий (принцип 4) |
| `marked_manifest_id?` | какой состав был отмечен |
| `expected_type?`, `expected_role?`, `input_manifest_id?` | строка ждёт монтаж: ожидаемый тип и состав исходников (RAW не публикуется); `expected_role = 'teaser'` — ждёт тизер своего объекта (30.10.2026) |
| `marked_by`, `marked_at` | отметка КМ (§5) |
| `mark_kind?` | `posted \| scheduled` — «выложено» / «в планировщике» (SPEC §5, 28.09.2026) |
| `stated_occurred_at?` | фактическая дата, указанная КМ для сториз и рассылки (§7) |
| `caption?`, `tier_refs text[]?`, `price_mills?`, `repost`, `album_name?` | для публикации через Hub, с 4а: подпись; аудитория Fansly — пусто: подписчики, иначе тиры; цена в тысячных долях доллара, как у Hub (с ценой — `paid_post`); флаг повтора (`boolean NOT NULL DEFAULT false`); имя альбома vault |
| `hub_publication_id?`, `hub_status?`, `hub_status_reason?`, `platform_post_ref?` | с 5б: публикация Hub, её статус и причина как отдаёт Hub (опрос раз в 10 мин), пост или альбом на площадке — к посту Hub без сопоставления (схема §9.6) |
| `cancelled_at/by`, `cancel_reason` | |
| `note`, `row_version`, `created_at/by` | |

CHECK `marked_at IS NULL OR cancelled_at IS NULL`; CHECK `release_id IS NULL OR
item_id IS NOT NULL`; частичный UNIQUE `(hub_publication_id)`; FK на состав только
закрытый. Уникальности по слоту нет: два
поста в один слот представимы и показываются как конфликт. Индексы:
`(model_id, assignee_id, slot_date)` — задачи на день; `(model_id, account_id,
slot_at)` — норма и дыры; `(model_id, item_id, slot_at DESC)` — «слишком рано»;
частичный `(model_id, slot_at) WHERE marked_at IS NULL AND cancelled_at IS NULL` —
«пропущена» вычисляется.
Правило версий: замена состава — новый `manifest_id`; если после отметки состав
заменили, `marked_manifest_id <> manifest_id`, и экран показывает «отметка относится
к прежнему составу». Появление новой версии файла ничего в строке не меняет, рядом
показывается «есть новая версия».
Возврат монтажа: загрузка КМ привязана к строке (`web_uploads.plan_row_id`); приёмка
создаёт новый FYP с происхождением от версий из `input_manifest_id`, затем ставит
его в `item_id` и `manifest_id` этой же строки с проверкой `row_version`. Если строку
уже изменили или отменили, FYP остаётся в каталоге, подстановка — явное действие.

**`download_receipts`** — квитанция выдачи (§7, §9.3, naming §6). `id`, `model_id`,
`principal_id`, `kind` (`master | platform | edit | promo`),
`manifest_id` (закрытый состав; одиночное скачивание с карточки — состав из одной версии,
схема §9.2), `entry_count`, `corrects_id?` (исправление, у прежней один преемник),
`plan_row_id?`, `account_code_snapshot?`, `slot_date_snapshot?`,
`meta_stripped`, `zip_key?` (ZIP в папке выдач, ниже), `issued_at`, `delivery_id?`; состояния нет: квитанция
вставляется целиком и не меняется (схема §9.2). Индекс `(model_id, issued_at DESC)`.
Квитанция держит исходную строку плана и суффикс имени: перенос слота потом не
переименовывает прошлую выдачу. Заголовки HTTP не доказывают, что файл докачан.

**`download_receipt_entries`** — что именно уходило. `id`, `model_id`, `receipt_id`,
`position`, `asset_version_id`, `rendition_artifact_id?` (ровно одно из: артефакт
производной, `issued_master = true` для мастера без изменений, `export_key?` — файл в
папке выдач), `file_name`,
`file_name_norm STORED`, `output_sha256`, `byte_size`, `duration_ms`, `width`,
`height`. UNIQUE `(model_id, receipt_id, position)`; FK `(rendition_artifact_id,
output_sha256)` → `rendition_artifacts (id, output_sha256)`. Индексы
`(model_id, file_name_norm)`, `(model_id, asset_version_id, receipt_id)`.
Папка выдач `/srv/tmp/exports/<receipt_id>/` (30.10.2026): очищенный мастер или исходник,
совместимая копия H.264, ZIP; отдача через `X-Accel-Redirect`, удаление через сутки;
хэш и размер остаются в квитанции.
Это основание «точной» улики §7: Hub сравнивается с параметрами выданной копии
(очистка метаданных меняет байты даже у «скачать мастер»), а не всегда с мастером.

### 3.6. Размещения и Hub

**`placements`** — использование на аккаунте и поверхности (§4, §7). `id`,
`model_id`, `account_id`, `surface_id`,
`occurrence_kind` (`post | vault_member | manual`), `external_post_ref?`,
`external_album_ref?`, `external_media_ref?`, `manual_key?`, `item_id?` (у
найденной публикации появляется позже), `plan_row_id?`, `planned_at?`,
`occurred_at?`, `occurred_source?` (`hub | km | import`), `caption?` (подпись с
платформы), `views?`, `likes?`, `stats_at?` (только Fansly: сумма по файлам размещения
из Hub — `creator_stats_media_daily`, `creator_stats_media_likes`, с 22.10.2026; раньше —
только просмотры суточного топа), `out_of_catalog`, `origin` (`plan |
hub | manual | import`), `row_version`, `created_at/by`.
Частичные UNIQUE `(model_id, surface_id, external_post_ref)` и
`(model_id, surface_id, external_album_ref, external_media_ref)` — повторный опрос
и привязка к плану не создают второе размещение, а пост, найденный после отметки КМ,
ручного подтверждения или заявки, дописывает внешние ID в прежнее (§7); CHECK
`NOT out_of_catalog OR item_id IS NULL`; CHECK `planned_at IS NOT NULL OR occurred_at IS NOT NULL`.
Единица: для стены и FYP — пост (один пост на стене и в ленте — два размещения с
общим `external_post_ref`); для vault — файл в альбоме с названием (повторное
добавление того же файла даёт у Fansly новую запись, размещение то же; системные All,
Posts, Messages без названия размещений не дают, SPEC §7; одна строка плана может
закрываться несколькими файлами); сториз и рассылка — ручная отметка. Пустое
размещение «под план» не создаётся: пока нет наблюдения или отметки, есть только
строка плана. Индексы: `(model_id, item_id, occurred_at DESC)`, `(model_id,
account_id, surface_id, occurred_at DESC)`, частичный по `item_id IS NULL AND NOT
out_of_catalog` — очередь «пост без плана — привяжите».

**`placement_assets`** — состав размещения по версиям (§4 «пост из нескольких
кадров»). `model_id`, `placement_id`, `asset_version_id`, `position`,
`match_strength` (`none | candidate | exact`), `matched_media_ref?`,
`receipt_entry_id?` (какой выданный файл совпал), `bound_at/by`.
PK `(model_id, placement_id, asset_version_id)`; UNIQUE `(model_id, placement_id,
position)`. Совпадение одного файла из двенадцати — частичный результат: уровень
размещения считается по всем строкам, а не по одной.

**`placement_evidence`** — улики, только вставка (§4, §5, §7). `id`, `model_id`,
`placement_id`, `source` (`hub | manual | import`), `kind` (`observed |
manual_confirm | reused_pair | manual_reject | legacy_claim | outside_catalog | retract`;
`reused_pair` — новое наблюдение подтверждённой пары «версия — media ID», источник
`manual`, §7),
`strength` (`claim | candidate | exact`), `hub_observation_id?`, `external_ref?`,
`matched_version_id?`, `legacy_claim_id?`, `payload jsonb`, `event_at?`,
`recorded_at`, `recorded_by?`, `corrects_id?`, `dedup_key`.
UNIQUE `(model_id, placement_id, source, dedup_key)` — то же наблюдение второй раз
строки не даёт, изменённое (другая подпись) — даёт; UNIQUE `(corrects_id)` — у
исправления один преемник; CHECK `source = 'import' → strength = 'claim'`,
`source = 'manual' → strength = 'exact'`, `source = 'hub' → hub_observation_id
IS NOT NULL`. Уникальности по `external_ref` внутри размещения нет: два кандидата
обязаны ужиться (§7 «флаг, не догадка»). Роль приложения: `INSERT, SELECT`.

**`hub_sync_state`** — граница опроса (§8.1), строка на страницу и поток опроса
(`posts` — посты с вложениями, `capture_coverage` и `sync_streams`; `raw_media`;
`vault_media`; `creator_stats` — просмотры и лайки Fansly). PK `(model_id, account_id,
dataset, scope)`, `scope` = `page`; `id` — субъект журнала; `watermark_at` (прошлый успех
минус 3 ч, SPEC §8.1), `last_success_at` (начало прошлого успешного опроса ContentOps —
база следующего чтения), `last_daily_at` (прошлый суточный или полный опрос),
`next_full_at` (месяц после прошлой полной перечитки), `rebuilt_at?` (Hub отверг курсор
как выданный до rebuild — полная перечитка до следующей полной), `hub_succeeded_at?`
(последний успех потока самого Hub, `sync_streams.succeededAt` потока `posts`; у Fansly
строк `sync_streams` нет — Hub отдаёт агенту только потоки OnlyFans, поэтому берётся
последнее `lastObservedAt` постов страницы; в строке — «Hub · посты на 18:32», у vault —
последний полный обход альбома; с 5б — и у статусов публикаций; 30.10.2026),
`consecutive_failures` (из `sync_streams`), `available`, `unavailable_reason`,
`last_error`, `last_work_id`, `blockers?` (`conclusion.blockers` прошлого чтения); колонки
покрытия — схема §9.1, §9.6. Полная перечитка — при первом опросе, через месяц, после
неудачной работы потока, после rebuild и после разрыва длиннее суток. Граница
продвигается только после сохранения всех страниц окна — в транзакции завершения работы.
Точечного опроса альбома нет (решение владельца 30.09.2026). Опросы одного потока
сериализуются арендой в `work_operations`; у работ Hub свой слот исполнителя — медленный
или недоступный Hub не держит забор и выдачу.

**`hub_observations`** — журнал наблюдений (§5, §8.1). `id`, `model_id`,
`account_id`, `dataset` (`posts`, `post_attachments`, `raw_media`, `vault_media`,
`creator_stats_media_daily`, `creator_stats_media_likes`), `external_key` (стабильный ключ
строки Hub), `sequence_no`, `row_updated_at?`, `semantic_hash` (SHA-256 закреплённых полей
набора, SPEC §8.1, кроме служебных времён Hub — `firstObservedAt`, `lastObservedAt`,
`rowUpdatedAt`, `capturedAt` — и сведений об обходе альбома, они в `hub_vault_albums`),
`payload jsonb` (строка как её отдал Hub), `observed_at`, `run_id`, `run_attempt`,
`previous_id?`. UNIQUE `(model_id, account_id, dataset, external_key, sequence_no)`.
Уникальности по хэшу нет: A→B→A — три строки, повтор A — только `last_seen_at`
у типизированной строки. Улики ссылаются на наблюдение, а не на изменяемую
текущую строку. Показатели Fansly по файлу и дню типизированной строки не имеют: текущее
значение — последнее наблюдение ключа; к размещению они приходят через
`hub_post_attachments.media_offer_ref`.

**`hub_posts`** — текущая строка поста: `id`, `model_id`, `account_id`, `post_ref`,
`current_observation_id`, `published_at`, `caption`, `attachment_count`, `fyp_flags`
(`fypFlags` Hub как есть: 4 — не в ленте, SPEC §7), `wall_refs jsonb`, `first_observed_at`,
`last_observed_at`, `row_updated_at` (времена Hub), `last_seen_at`. UNIQUE `(model_id,
account_id, post_ref)`; индексы `(account_id, published_at DESC)`, `(account_id,
attachment_count, published_at)`. Связь с размещениями — по
`placements.external_post_ref` (схема §9.2). Пустой `wall_refs` не читается как «не на
стене»: поверхность размещения ставится только по доказанному признаку, иначе пост
остаётся в очереди разбора.

**`hub_post_attachments`**: `id`, `model_id`, `post_id`, `hub_key` (ключ строки Hub),
`current_observation_id`, `attachment_index`, `member_index`, `position`, `role`,
`content_type`, `content_ref` (offer или пачка поста), `bundle_ref`, `media_offer_ref`,
`preview_ref`, `media_ref`, `link_state` (семь значений Hub), `filename`, `mime`,
`duration_ms`, `orig_width`, `orig_height`, колонки совпадения и `last_seen_at`. Ключ и
колонки совпадения — схема §9.6. Набор затронутого поста заменяется целиком, в том числе
пустым; строка с тем же ключом и местом сохраняет совпадение, пока не изменилась.

**`hub_raw_media`** — файл платформы: `id`, `model_id`, `account_id`, `media_ref`,
`current_observation_id`, `filename`, `filename_norm STORED` (имя без расширения в нижнем
регистре), `mime`, `media_type`, `duration_ms`, `orig_width`, `orig_height`, `out_width`,
`out_height`, `fps_milli`, `created_at_platform`, `origin`, `first_observed_at`,
`row_updated_at`, `last_seen_at`. UNIQUE `(model_id, account_id, media_ref)`; индексы
`(model_id, filename_norm)` — имя скачивания ContentOps как точная улика; `(account_id,
duration_ms, orig_width, orig_height)` — кандидат по длительности и размерам.

**`hub_vault_albums`**: `id`, `model_id`, `account_id`, `album_ref`, `title`,
`last_full_walk_at`, `full_walk_ref`, `member_count` (число членов по полному обходу),
`last_seen_at`. Только vault создателя: пользовательский vault (лайки и покупки, чужие
файлы) не читается. Своих строк у альбома в Hub нет — сведения приходят со строками
`vault_media`; «ни разу не обойдён» — пустой `last_full_walk_at`. UNIQUE `(model_id,
account_id, album_ref)`; индекс по `lower(title)` — альбом `PPV-073 Йога, анал, гольфы`
ведёт к объекту (naming §7).

**`hub_vault_media`**: `id`, `model_id`, `account_id`, `album_id`, `member_ref`,
`current_observation_id`, `media_ref?`, `media_offer_ref?`, `custom_filename`, `filename`,
`mime`, `media_type`, `duration_ms`, `orig_width`, `orig_height`, `created_at_platform`,
`membership_at` (время события строки Hub — первое появление в альбоме),
`missing_since?`, `first_observed_at`, `last_observed_at`, `row_updated_at`,
`last_seen_at`. UNIQUE `(model_id, account_id, album_id, member_ref)`; `missing_since`
только после доказанного полного обхода; «был когда-то» и «есть сейчас» — разные факты.
В vault считается то, что лежит сейчас: файл с `missing_since` размещение не держит,
объект возвращается в «Ещё не залито» (30.10.2026).

### 3.7. Заказы кастомов

**`custom_orders`** (§8.2). `id`, `model_id`, `account_id?`, `tg_chat`, `tg_topic?`,
`tg_message_id`, `card_author`, `card_at`, `buyer_name?` (в файлы и публикации
не подставляется), `brief`, `ordered_duration_raw?` («8-10
минут», «10 минут - 20 фото»; у части карточек длительности нет), `duration_min_s?`, `duration_max_s?`,
`photo_count?`, `due_at?`, `status` (`open | delivered | closed | cancelled`), `name_in_media`
(`yes | no | unknown`; у кастома видно то же значение), `closed_at/by`,
`cancelled_at/by`, `cancel_reason?`, `row_version`, `created_at/by`, `updated_at`.
UNIQUE NULLS NOT DISTINCT `(model_id, tg_chat, tg_topic, tg_message_id)`;
CHECK `(status = 'closed') = (closed_at IS NOT NULL)`; CHECK `(status = 'cancelled') =
(cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)`. Индексы `(model_id, status,
due_at)`, `(model_id, lower(buyer_name))`, GIN `pg_trgm (brief)`.
Закрыть можно только при сдаче и без открытых правок — проверяет триггер на строке заказа
(схема §9.2 «Миграция 0004»); `closed` по-прежнему значит «сдан». `cancelled` — «снят» (возврат, отказ фана, ошибочная
карточка): причина обязательна, снять может человек или агент (автор — в журнале),
просрочки у снятого нет (30.10.2026).

**`custom_order_messages`** — значимые сообщения и перепосты (§8.2). `id`,
`model_id`, `order_id`, `tg_ref`, `kind` (`card | repost | delivery | revision |
confirmation | note`), `message_at`, `author`, `excerpt`, `recorded_at/by`.
UNIQUE `(model_id, order_id, tg_ref, kind)`. Перепост карточки — строка `repost`
после доказанного соответствия, а не второй заказ. Полной копии переписки нет.

**`custom_order_deliveries`** — сдача (§8.2). `id`, `model_id`, `order_id`,
`item_id` (CUS), `manifest_id` (закрытый состав версий), `draft_id?`,
`delivered_at` (у сдачи из Telegram — время сообщения, а не веб-загрузки), `basis jsonb`
(какие признаки сработали), `evidence_refs jsonb`
(`tg:…`, путь, `resource_id`), `linked_at/by`, `confirmed_by?`, `retracts_id?`,
`retract_reason?`. UNIQUE `(model_id, order_id, manifest_id)`; индекс
`(model_id, item_id)`. Один заказ — несколько сдач; ошибочная привязка отзывается
новой записью, не правкой (схема §9.2); строка сдачи не меняется.

**`custom_order_revisions`** — правка (§5, §8.2). `id`, `model_id`, `order_id`,
`requirement`, `request_tg_ref`, `request_ordinal` (одно сообщение может нести
несколько требований), `requested_at`, `done`, `done_basis?`, `fixed_delivery_id?`,
`done_at/by`, `reopened_at?`. UNIQUE `(model_id, order_id, request_tg_ref,
request_ordinal)`; CHECK `done = (done_at IS NOT NULL)`; CHECK `NOT done OR
done_basis IS NOT NULL` — привязка новой версии сама по себе правку не закрывает.
«Сдано, требуется правка» — запрос: есть сдача и есть `done = false`.

### 3.8. Промо

**`contractors`** — получатель без входа (§7.1). `id`, `model_id`, `name`, `contact`,
`channel_id?`, `format` (`upload | master | compat` — «для заливки»: копия для платформы и
отобранные кадры, «мастер», «совместимая для монтажа» H.264), `archived_at`, `row_version`
(формат меняется с `If-Match`). UNIQUE `(model_id, name)`. Версий профиля и отдельной
промо-копии нет (30.10.2026).

**`promo_deliveries`** — передача (§4, §7.1). `id`, `model_id`, `package_item_id`,
`channel_id`, `contractor_id`, `format?` (снимок формата подрядчика на момент подготовки),
`manifest_id` (закрытый состав версий
на момент подготовки), `receipt_id?` (готовая выгрузка: ZIP, `manifest.csv`, сводка —
имена и размеры в `download_receipt_entries`), `state` (`preparing | prepared |
sent`), `prepared_at/by`, `sent_at/by`, `recipient_note`, `summary jsonb`,
`origin` (`product | import`), `corrects_id?`, `row_version`.
Прошлый пак из `9. SMM` (SPEC §6.3) — `origin = 'import'`, `state = 'sent'` без
`prepared_at/by`, `sent_at/by` и формата; состав — по папке, дата папки — в `summary`;
то и другое — утверждение, не подтверждённая отправка.
CHECK `CASE origin WHEN 'import' THEN state = 'sent' AND sent_at IS NULL AND sent_by IS
NULL ELSE format IS NOT NULL AND (state = 'sent') = (sent_at IS NOT NULL AND
sent_by IS NOT NULL) END`;
UNIQUE `(corrects_id)`. Изменение выбора до «Передано» — новая подготовка (новый
состав и квитанция); после — новая передача. Повтор отметки идемпотентен
(`UPDATE … WHERE state = 'prepared'`). Передача не создаёт `placements` (§7).
Снимок «Передано» — запечатанные состав (`manifest_id`: порядок, ассеты, версии и через них
SHA-256 мастеров) и квитанция (`receipt_id`: имена, размеры и хэши выданных файлов) плюс
`format`; квитанция ссылается на тот же состав, отдельной копии при отметке нет
(подробнее — схема §9.2 «Миграция 0007»).

### 3.9. Служебные

**`idempotency_keys`** — повторяемые команды агентов и людей (SPEC §11.2).
`id`, `model_id?`, `principal_id`, `operation`, `key`, `request_digest` (SHA-256), `state`
(`committed | no_replay` — ответ с секретом не сохранён, повтор отвечает 409; предварительно),
`response jsonb` (секреты — токен, временный пароль, `Set-Cookie` — не пишутся: CHECK
`jsonb_has_secret()` отклоняет документ с такими ключами на любой глубине, он же стоит на
`action_log.before/after`), `created_at`, `committed_at`. UNIQUE `(principal_id, operation,
key)`; тот же ключ с другим запросом — конфликт. Доменная запись, ответ, журнал и
постановка работ фиксируются одной транзакцией.

**`action_log`** — кто, что, с чем, куда и когда (§4, §11.1).
`id bigint IDENTITY` (PK), `at`, `model_id?`, `actor_type` (`human | agent | system`),
`actor_id?`, `actor_label`, `action` (`draft.accept`, `placement.confirm`,
`promo.delivery.sent`, `blob.purge`, `order.revision.done`), `entry_kind`
(`action | change`), `item_id?`, `request_id?`,
`work_id?`, `subject_kind`, `subject_id?`, `subject_label` (`PPV-073`,
`PPV-073/teaser` — читается после удаления), `before jsonb?`, `after jsonb?`,
`result` (`ok | denied | error`), `payload_version`. Без партиций; BRIN по `at`;
индексы `(model_id, subject_kind, subject_id, at DESC)` — по объекту,
`(model_id, at DESC)` — по времени, `(actor_id, at DESC)`; частичный
`(model_id, item_id, at DESC) WHERE entry_kind = 'action'` — «История». Пишут триггер
`log_row_change()` и код типизированных событий; UPDATE и DELETE запрещены.
Секреты и сырые заголовки не пишутся; фон пишет итог шага, не каждый кадр.

**`backup_checkpoints`** — точка восстановления (§12.3). `id`, `run_id`,
`db_snapshot_at`, `dump_key`, `dump_sha256`, `required_manifest_key` (список нужных
SHA-256 мастеров и загрузок, снятый из того же снимка PostgreSQL, что и дамп, через
`pg_export_snapshot`), `required_count`, `missing_count`, `state` (`db_only |
complete | expired`), `repository`, `finalized_at`, `last_restore_test_at`.
`complete` — только когда каждый нужный хэш есть в снимке хранилища; дневной дамп при
ночных блобах — `db_only`. Экран состояния показывает последнюю полную точку отдельно
от последнего дампа.

## 4. Списки значений и ограничения

Все списки — `text` + CHECK (принцип 12). Закрытые списки (множество закрыто решениями
владельца): `content_type` (`PPV SET SXT CUS FYP LIFE RAW PRM`), `asset_role` (`master
teaser pic raw ed clip thumb cap`), `media_kind`, `platform` (`fansly onlyfans`),
`surface_kind`, `tag_group`, `annotation_field`, `provenance_relation`, `uniq_level`,
`principal_kind`, `principal_role`, `actor_type`, `rendition_kind`.

Предварительные списки (в §13 или в §5 названы предварительными; закрываются до тега
`schema-freeze`): состояние и исход
черновика, сила и вид улики, статус заказа, состояние блоба, состояние работы,
вид случая разбора, вердикт проверки.

Смысловые ограничения, которые обязаны попасть в миграцию, а не остаться
договорённостью:

| Правило | Где |
|---|---|
| Номер не переиспользуется, tombstone занимает его | UNIQUE `(model_id, type, number)` в `content_items` |
| Одна группа приёмки — не больше одного созданного объекта | UNIQUE `(model_id, created_from_group_id)` |
| Одна ревизия источника — один черновик | UNIQUE `inbox_drafts.source_revision_id` |
| Принять можно только с проверенным мастером | CHECK на `outcome` и `master_verified_at` |
| Под-хендл никогда не достаётся другому файлу | частичный UNIQUE `(model_id, item_id, role, ordinal, variant_no) WHERE kind = 'owned'` включая снятые членства |
| У файла один владелец | частичный UNIQUE `(model_id, asset_id) WHERE kind = 'owned' AND removed_at IS NULL` |
| Состав после закрытия не меняется | `entry_count` и отложенная сверка числа строк, запрет UPDATE и DELETE (схема §9.2) |
| Сториз и рассылка вне автосверки | CHECK `auto_match` в `surfaces` |
| Одна публикация — одно размещение | частичные UNIQUE по внешним ID в `placements` |
| Повтор наблюдения не даёт улики; у исправления один преемник | UNIQUE `(placement_id, source, dedup_key)`, UNIQUE `(corrects_id)` |
| Заявка легаси всегда `claim`, ручное всегда `exact` | CHECK в `placement_evidence` |
| Правка не закрывается одной привязкой версии | CHECK `NOT done OR done_basis IS NOT NULL` |
| Заказ сдан — только при всех частях; закрыт — только сданный и без открытых правок | триггеры `custom_orders_status`, `custom_order_deliveries_lock`, `custom_order_revisions_lock` (схема §9.2 «Миграция 0004») |
| Передача отмечена только с датой и автором (кроме прошлых паков из импорта) | CHECK в `promo_deliveries` |
| Смешать модели нельзя | составные FK `(model_id, …)` во всех доменных связях; структурный тест по `pg_constraint` |

Переходы §5, которые остаются в коде, а не в constraint: цепочка черновика
(предварительна), снятие подтверждения поля (SPEC не запрещает), цикл в
происхождении (проверка под блокировкой объектов), запрет смены типа и удаления объекта
при связях (проверяется командой).

## 5. Ключевые транзакции

**Принятие группы.** Медиа готовится вне транзакции (мастер проверен, байты в
`blobs/`). Транзакция: ключ идемпотентности → блокировка группы, черновиков, целевого
объекта и строки счётчика в одном порядке → проверка `row_version` и того, что все
выбранные файлы готовы или подтверждены дублями (частичная готовность — отказ,
а не тихое выпадение файла) → номер только для нового объекта → `content_items`,
`assets`, `asset_versions`, `item_memberships`, `aliases`, `provenance`, перенос
`annotation_fields` с группы и черновиков на объект и версии (статусы сохраняются),
`custom_order_deliveries` при выбранном заказе, `legacy_claims.resolution` →
`inbox_drafts.state = 'resolved'`, `outcome`, `applied_*` → `action_log` →
постановка работ → commit. Повтор с тем же ключом возвращает прежний результат;
сбой до commit номер не расходует. Новый файл, приехавший в ту же папку позже, —
отдельный черновик с предложением дополнить тот же объект.

**Удаление байтов.** Только командой владельца по отчёту `verify-blobs`; само ничего
не удаляется. Кандидат — блоб с `blob_is_referenced(sha256) = false`
(нет версий, живых черновиков и незавершённых работ). `storage_operations.intent`
в БД → повторная проверка ссылок под замком строки блоба → удаление → `purged`;
строка `blobs` остаётся. Производные не считаются ссылкой и удаляются вместе с мастером.

**Точка восстановления.** Барьер против удаления байтов на время снимка →
`REPEATABLE READ`, `pg_export_snapshot()` → из одного снимка: `pg_dump
--snapshot` и список нужных SHA-256 (мастера всех версий, зарегистрированные
загрузки, нерешённые черновики) → снимок хранилища недостающих блобов →
сверка каждого нужного хэша с содержимым снимка → `checkpoint.json` в репозиторий
бэкапа → `backup_checkpoints.state = 'complete'` → снятие барьера. Дневные дампы
между ночными снимками блобов — `db_only`. Восстановление: дамп → нужные блобы по
списку → сверка хэшей и замыкания ссылок → сверка незавершённых `storage_operations`
и работ → воркеры → пересборка производных.

## 6. Сценарии строками

**PPV-066 «Йога и анал» из кастома.** `source_objects` ×3 (папка, `.mov`, `lv_0_*.mp4`),
`source_revisions` ×2, `inbox_groups` ×1, `inbox_drafts` ×2, `blobs` ×3,
`master_checks` ×1, `legacy_number_claims` (`PPV`, 66, `keep`),
`content_items` (`PPV`, 66, `dm`), `assets` ×3 с `asset_versions` v1,
`item_memberships` `master`, `teaser`, `pic01`, `aliases` (путь папки и файла,
`PPV-066`, `resource_id`), `provenance`
`ppv_from_custom ← CUS-181` (общий блоб), `item_tags` из реестра с
`group_at_import`, `annotation_fields` (`title` подтверждено, остальное черновик),
`rendition_generations` ×1 (из source, привязано после мастера) с артефактами
превью, миниатюр и кадров; размещений нет: `X.X.X` — «дата не проставлена», а не
«не выпущен».

**Сет на трёх страницах.** `SET-069`: 34 `raw` + 12 `ed`, у каждого `ed` —
`provenance processed_from raw`. Один `asset_manifests` из 12 версий;
три `posting_plan_rows` (`lora-1/2/3`, `wall`) с тем же `manifest_id`;
три `download_receipts` с разными суффиксами аккаунта и даты; три `placements`
`post` с `placement_assets` ×12 на те же версии. Новых блобов и производных нет.

**FYP с уникальными версиями.** Веб-загрузка → `web_uploads` → черновик → `FYP-0412`,
`assets` мастер v1; система создаёт два `assets` с `variant_kind = 'uniq'`
(`u1 soft`, `u2 mirror`), у каждого своя версия и `provenance uniq_from`.
Три строки плана с составами из трёх разных версий. Пересдача `u2` — `u2 v2`,
`FYP-0412_slug_master_u2_v2.mp4` в имени (naming §5).

**Новая версия после плана.** `PPV-073` в плане на `lora-1` с составом
`{master v1, pic01 v1}`; КМ скачал и отметил. Приехала правка мастера →
`asset_versions` v2, `assets.current_version_id = v2`. Строка плана не меняется,
`marked_manifest_id = manifest_id`, экран показывает «есть новая версия».
Замена — новый состав с v2 и сброс сравнения отметки. Живая подборка `PRM-012`,
где мастер лежит ссылкой без `pinned_version_id`, теперь показывает v2; переданная
вчера выгрузка держит v1 через свой состав и квитанцию.

**Пост в Hub без плана.** Часовой опрос: `hub_observations` (пост, `sequence_no = 1`),
`hub_posts`, вложения, `hub_raw_media`. Строки плана нет → `placements`
(`post`, `item_id` пуст) + `placement_evidence` (`hub`, `observed`, `candidate`).
КМ привязывает `SET-069`: `item_id`, `placement_assets` ×12, вторая улика
`manual_confirm exact`. Повторный опрос той же строки: `semantic_hash` тот же —
наблюдения нет, улики нет; изменилась подпись — `sequence_no = 2` и новая улика с
другим `dedup_key`, старая остаётся.

**Кастом с правкой.** Карточка → `custom_orders`; файл `3. Customs/13:03 <фан>.mov`
→ черновик с двумя кандидатами (`order`, `signals` reply и длительность против
`duration_window` у второго, `conflicts_with`) → принятие `CUS-186` со сдачей
(`custom_order_deliveries`, состав `{master v1}`) → `custom_orders.status =
'delivered'` → правка (`custom_order_revisions`, `done = false`) → «Сдано, требуется
правка» → вторая версия → вторая сдача с составом `{master v2}` → агент отмечает
`done` с `done_basis` и `fixed_delivery_id` → закрытие. Алиас `13:03 <фан>.mov`
находится поиском.

**Отклонённый черновик.** `outcome = 'rejected'`; байты остаются в `blobs/`, пока
владелец не удалит их командой по отчёту `verify-blobs` (и то, если `blob_is_referenced`
ложно: на них не ссылаются версии, другие живые черновики и работы); до этого «Вернуть в
работу» — просто смена состояния. Хэши, проверки и записи прогонов остаются. Следующий
скан ту же ревизию не поднимает: черновик занимает `source_revision_id`.

**Коллизия PPV-032 при импорте.** Проход по метаданным снимка: три
`legacy_number_claims` на 032, счётчик поднят выше 072 (`[PPV-073]` на диске тоже
записан). Принятие: `milk` — `keep` 032; `halloween` и `brown_set` — `renumber`,
номера с живого счётчика уже после всех резервов. У всех трёх `aliases`
`legacy_id = 'PPV-032'` (`public`) — поиск «ппв 32» находит три карточки.

## 7. Развилки владельца, оставленные в SPEC §13

Схема выбирает значение по умолчанию и отмечает, что владелец не решал:

| Вопрос | По умолчанию в схеме |
|---|---|
| Менеджер с правом на одну страницу и общий каталог модели | читает общий каталог, меняет план и отметки своих страниц; приёмка, правка каталога и промо — право на модель |
| Хранение старых версий мастеров | хранятся все принятые версии; чистка принятых — отдельная политика, до неё места они занимают |
| Подтверждённая хронология после перемонтажа | остаётся при прежней версии с отметкой «для прежней версии», новая версия размечается черновиком |
| Задача «залить в vault» при уже лежащем файле | задача выполнена присутствием нужных версий в альбоме; требование именно новой заливки — отдельный признак строки |
| Человек и заказы через API | §8.2 как процесс и набор кнопок; скрытого запрета по типу принципала нет |
| Смена типа объекта после номера | новый объект и алиас, прямого UPDATE нет |
| Разделение пачки RAW | исходный номер остаётся у одной части, остальным — новые |

Решены 08.09.2026 и записаны в SPEC: подготовленный план держит выбранную версию
до явной замены; живая подборка `PRM` следует текущей версии, подготовленная и
переданная выгрузка закреплены.

Решены 11.09.2026. Владелец: прав на страницу нет (первая развилка снята, колонка
`principal_grants.account_id` убрана); все принятые версии хранятся, чистка — отдельная
политика после обкатки; люди правят заказы теми же командами, что агент. По поручению
владельца приняты умолчания схемы: подтверждённая хронология остаётся за прежней
версией, новая размечается черновиком; «залить в vault» выполнено наличием нужных
версий в альбоме, отдельная заливка — флаг `requires_new_upload` у строки плана;
смена типа — новый объект, алиас и перенаправление, прямого UPDATE нет; при
разделении пачки RAW номер оставляет часть, которую выбрал КМ (по умолчанию самая
большая), остальные получают новые номера, старые под-хендлы остаются алиасами.

## 8. Что изменено в норме вместе со схемой

SPEC §4 — сущности Asset, AssetVersion, ItemMembership, AssetManifest и абзац
«Таблицы ядра»; §6.4 — проход по метаданным до байтов; §7 и §7.1 — правило версий
в плане и подборке; §9.1 — производные по поколениям; §12.3 — точки «только БД» и
полные; §13 — сужен пункт о схеме, добавлены развилки. naming §3 и §5 — уникальная
версия `uN` перед `vN`.

11.09.2026: SPEC §4.2 (71 таблица, правила владения, закрытие составов и квитанций,
шаги файловых операций, `text` + CHECK), §4 и §7 (флаг «второй человек в кадре», запрет
OnlyFans без отметок верификации), §5 и §8.2 (заказ сдан при всех частях; люди правят
заказы), §11.1 (права на модель, не на страницу), §12.0 (миграции по этапам, без enum),
§13 (сняты пункты о втором лице, формате журнала и развилках схемы); PRD §5; PLAN
этапы 1–2. Остаётся в §13: числовые пороги, провайдер разметки, передача PII внешнему
LLM.

## 9. Изменения 11.09.2026

Итог конкурентного планирования (два независимых планировщика, четыре раунда
анонимной сверки, все спорные пункты закрыты обоюдным «да»; решения владельца 11.09).
Уровень колонок и ограничений; при расхождении со схемой §1–§7 сильнее этот раздел.

### 9.1. Убранные таблицы (78 → 71)

| Таблица | Куда ушло | Условие |
|---|---|---|
| `rendition_requests` | Ключ производной (`master_sha256?`, `kind`, `recipe_digest` вида, `meta_stripped`; с 30.10.2026 — без `pipeline_version` и `profile_key`) и `is_active` — на `rendition_generations`; частичный UNIQUE по ключу `WHERE is_active` | Первое поколение строится из исходника с пустым `master_sha256` и привязывается один раз после проверки мастера (UPDATE `master_sha256`, `is_active`, `bound_at`); адрес поколения не меняется; переключение активного поколения сериализовано по ключу |
| `promo_packages` | `content_items.promo_channel_id?`, `default_contractor_id?` | CHECK `(type = 'PRM') = (promo_channel_id IS NOT NULL)`; FK в пределах модели; сдача промо ссылается на карточку типа `PRM` через копию типа (схема §9.2) |
| `hub_sync_runs`, `backup_runs` | Строки `work_operations` видов `hub_sync` и `backup` | Типизированные `account_id`, `dataset`, `scope`, `window_from/to`; входы неизменны; `work_key` включает окно (иначе второй часовой опрос упрётся в UNIQUE `(model_id, kind, work_key)`); новый прогон — новая строка; результат неизменен; `backup_checkpoints.run_id` и `hub_observations.run_id` ссылаются на работу и попытку |
| `storage_findings` | Неизменный отчёт JSON на строке работы `verify_blobs` | Находка считается закрытой, когда следующий отчёт её не содержит (SPEC §9.1 «чистится вручную по отчёту»); отдельная таблица — только если появится рабочий процесс по находкам |
| `hub_coverage` | Колонки `hub_sync_state`: `expected_count`, `observed_count`, `stop_reason`, `blockers`, `proven_complete_at` | Отметка успешного опроса не означает покрытия; история изменений — в журнале (схема §9.3) |
| `placement_checks` | Не хранится: вердикт «ждём / не вышло / не удалось проверить» считается из улик, наблюдений, покрытия и настроек; прошлые входы восстановимы из журнала изменений `hub_sync_state` и `policy_settings` | Если на этапе 4 понадобится стабильная сводка спорных случаев — новая таблица-журнал вердиктов, без переделки ядра |

Оставлены, хотя обсуждались: `source_paths` (история путей до приёмки — не каталог),
`sessions` и `api_tokens` (разные контракты безопасности). Новых таблиц нет.

### 9.2. Изменения по таблицам

- **`models`**: убран `catalog_revision` (горячая строка). Индекс каталога — view
  `catalog_index` над `content_items`, `item_tags`, `annotation_fields`; браузер
  обновляет снимок модели целиком (ETag) в фоне, как разрешает SPEC §12.0. Инкремент по
  счётчику небезопасен: номер выдаётся при старте транзакции, не при коммите, и
  браузер может навсегда пропустить позднее закоммиченное изменение.
- **`content_items`**: убраны `tags_cache`, `markup_state`,
  `second_person_verified_at/by`; `has_second_person boolean` без умолчания: пусто —
  «не проверено» (импорт легаси), вопрос — один раз, при первой постановке на OnlyFans,
  ответить может и агент (30.10.2026; предлагаемое значение — на `inbox_groups`); на
  OnlyFans ставится только `false`, отмеченный и не проверенный — нет
  (команда плана, замена состава и вставка готового монтажа отклоняют; поздняя галочка
  отменяет невыполненные задания на OnlyFans, история остаётся); добавлены
  `promo_channel_id?`, `default_contractor_id?` (схема §9.1); UNIQUE `(model_id, id, type)`
  как цель для копии типа; `type`, `number`, `model_id` неизменны триггером.
- **Копия типа**: дочерние таблицы (`item_memberships`, `ppv_releases`,
  `custom_order_deliveries`, `promo_deliveries`, `placements` — `item_type?` в паре с
  `item_id?`) несут `item_type` с FK `(model_id, item_id, item_type)` и CHECK
  допустимых пар «тип — роль» из naming §3 — у членства только при `kind = 'owned'`,
  ссылки `PRM` его не проходят. Без триггеров.
- **Владение сквозь связи**: `item_memberships UNIQUE (model_id, item_id, id)` и
  отложенный FK обложки `(model_id, id, cover_membership_id)`; `surfaces UNIQUE
  (model_id, account_id, id)` и FK `(model_id, account_id, surface_id)` у строк плана и
  размещений; каждая ссылка на версию несёт `asset_id` и FK `(model_id, asset_id,
  version_id)` (членства, строки состава, `placement_assets`, квитанции);
  `custom_order_deliveries UNIQUE (model_id, order_id, id)` и FK `(model_id, order_id,
  delivery_id)` из `custom_order_revisions.fixed_delivery_id` и из
  `custom_order_deliveries.retracts_id`; `corrects_id` улики — составной FK на то же
  размещение, один преемник.
- **`assets` / `item_memberships`**: `variant_no int NOT NULL DEFAULT 0` на обеих
  таблицах (0 — базовый файл; `assets CHECK ((variant_kind = 'uniq') = (variant_no >
  0))`, naming §5 требует `_uN` при N ≥ 1); `assets UNIQUE (model_id, id, variant_no)`,
  членство копирует номер с FK `(model_id, asset_id, variant_no)` — NOT NULL с обеих
  сторон, иначе Postgres пропускает проверку при NULL; вычисляемого `handle` нет, хендл
  считается в view и коде; частичный UNIQUE `(model_id, item_id, role, ordinal,
  variant_no) WHERE kind = 'owned'` NULLS NOT DISTINCT по `ordinal`, так `master`, `u1`,
  `u2` живут рядом, а подборка `PRM` держит ссылками два мастера; снятые хендлы не
  переиспользуются; `created_in_item_id`, `item_id`, `asset_id`, `kind` членства
  неизменны.
- **`asset_versions`**: убран `retired_at` (владелец хранит все версии); строка
  неизменна; `master_sha256` — FK на `blobs`.
- **`asset_manifests`**: состояния нет — состав вставляется закрытым одной транзакцией;
  заголовок несёт `entry_count int NOT NULL CHECK (> 0)`, неизменен; позиции строк
  `1..entry_count`, UNIQUE `(model_id, manifest_id, position)`; отложенный триггер на
  коммите сверяет число строк с `entry_count`, поэтому поздняя вставка валит
  транзакцию; UPDATE и DELETE заголовка и строк запрещены триггером и REVOKE; потребители
  ссылаются на `(model_id, id)`. FK на константу `'sealed'` невозможен и не нужен.
  Проверки `xmin` нет: ломается под savepoint и ничего не добавляет.
- **`annotation_fields`**: вместо `target_kind/target_id` четыре ссылки `item_id?`,
  `version_id?`, `group_id?`, `draft_id?` с составными FK и CHECK «ровно одна»; UNIQUE
  NULLS NOT DISTINCT `(model_id, item_id, version_id, group_id, draft_id, field)`;
  предложение ИИ применяется только при совпадении ожидаемой версии поля и
  неподтверждённом поле; `platform_texts` держат свои `value_version` /
  `confirmed_value_version`, `platform_text` из `annotation_fields.field` убран.
- **`tags` / `item_tags`**: обычный FK `item_tags.tag_id → tags (id)` и триггер
  «тег общий (`model_id IS NULL`) или своей модели»; область тега неизменна. Составной
  FK на общие теги не работает: ссылающиеся колонки NOT NULL, проверка идёт и падает.
- **`posting_plan_rows`**: `slot_tz text NOT NULL` копируется из `models.timezone`,
  `slot_at timestamptz NOT NULL` пишет команда, триггер сверяет `slot_at = (slot_date +
  coalesce(slot_time,'00:00')) AT TIME ZONE slot_tz`; вычисляемой колонки нет
  (`timezone(text, timestamp)` не IMMUTABLE, пояс лежит в другой таблице); флаг
  `requires_new_upload boolean NOT NULL DEFAULT false`. То же для
  `ppv_releases.release_date`.
- **`download_receipts` / `download_receipt_entries`**: квитанция вставляется целиком,
  когда известны байты, имена и хэши; источник — `manifest_id` (карточка и план дают
  закрытый состав); строки несут `asset_version_id` плюс неизменный хэш исходника.
  Скачивание исходника и превью с черновика (SPEC §6.1) квитанции не пишет: ID у
  черновика нет, точной улики оно не даст; кто, что и когда скачал — в журнале
  (30.09.2026). Закрытие как у составов
  (`entry_count`, позиции, отложенная сверка, запрет UPDATE/DELETE); исправление —
  новая связанная квитанция; индекс `(model_id, asset_version_id, receipt_id)` (в схеме §3.5
  индекс ссылался на `issued_at` другой таблицы); выданный хэш хранится, даже если
  производная позже удалена; завершение и обрыв передачи — запись журнала.
- **`master_checks`**: `decision` — как получен мастер, CHECK `encode | copy | skipped_hdr |
  skipped_av1 | skipped_lowrate | skipped_audio` (`copy` — веб-загрузка результата КМ;
  «Другое» сжимается по общим правилам); `verdict` — исход
  проверки, без пропусков: исходы `tools/compress-library.sh` `ok`,
  `unreadable`, `bigger_than_source`, `timing_drift`, `timing_uncomparable`,
  `audio_mismatch`, `audio_offset`, `audio_tracks_lost`, `encode_failed`,
  `frame_mismatch`, `result_decode_errors`, `publish_failed`, `source_decode_errors`,
  `source_truncated` и `metadata_mismatch` (метаданные или размер с учётом поворота у
  результата не те, что у источника: SPEC §9.2 требует их сверки, у скрипта такого исхода
  нет; 30.10.2026); `decision` пуст только при `unreadable` — исходник не открылся, правило
  не применить; `enc_ms`, `verify_ms`, `src_frames`, `dst_frames`, `crf`,
  `report jsonb`; у проваленной проверки может не быть хэша мастера;
  результат на каждую попытку: UNIQUE `(source_sha256, recipe_digest, work_id,
  attempt)` (прежний ключ сталкивался на повторном `ok`). Принятие (30.10.2026): `encode`
  с `ok` — мастер из кодирования; `copy`, `skipped_*`, `bigger_than_source` и сбой
  кодирования — мастер сам исходник (`inbox_drafts.master_is_source`) после полного
  декода и probe с `ok`; битый исходник (`source_decode_errors`, `source_truncated`) —
  только «Принять как есть» КМ, если файл открывается и превью собралось (действие ставит
  `master_verified_at`, пишется в журнал); `unreadable` ждёт замены в черновике. Мастера,
  сжатые на winpc при замерах, в продукт не переносятся — всё пережимается.
- **`blobs`**: убраны `registered_from_draft_id`, `state_generation`; строка не
  удаляется никогда; состояние `purging` живёт в `storage_operations`, не в
  `blobs.state`. Ссылки-удержания — настоящие FK на `blobs (sha256)`:
  `asset_versions.master_sha256`, `inbox_drafts.master_sha256`,
  `inbox_drafts.source_blob_sha256?`, `web_uploads.sha256`,
  `work_operations.output_sha256`; колонки-отпечатки (`source_revisions.source_sha256`,
  `asset_versions.source_sha256`, `master_checks.*`) FK не являются и ничего не держат.
- **`source_revisions`**: наблюдённые идентификатор и метаданные неизменны, но
  `source_sha256`, `verified_at`, `verified_route` заполняются один раз (NULL → значение)
  после скачивания и проверки; триггер разрешает только этот переход.
- **`inbox_drafts`**: `rejected_at`, `reopened_at?`, `reopen_count`; переход `resolved →
  ready` только при `outcome = 'rejected'` и пока байты не удалены командой владельца
  (`blobs.state = 'present'`), срока нет (30.10.2026); принятые, дополнившие объект и
  дубли-алиасы заново не открываются.
- **`principal_grants`**: убран `account_id`; UNIQUE один живой грант на
  `(principal_id, model_id)`. Убраны `accounts.second_person_policy` и вид ревью
  `verification_required`.
- **`policy_settings`**: `model_id?` (NULL — глобальная строка: выключатели SPEC §8
  и, с 30.09.2026, пороги защиты входа SPEC §11.1; общий запрет сильнее разрешения по
  модели; изменение 13.09.2026, прежде глобальных строк не было), вторая модель
  получает модельные строки из bootstrap,
  `account_id?`, `item_type?`, `value jsonb?`, UNIQUE NULLS NOT DISTINCT
  `(model_id, account_id, item_type, key)`; приоритет модель+аккаунт+тип
  → модель+аккаунт → модель+тип → модель → глобально (так берутся пороги); выключатель
  включён, только если хотя бы на одном уровне от глобального до его области стоит
  «включено» и ни на одном — «выключено»; SQL NULL = не задано = выключено, JSON `null`
  отклоняется; валидатор на ключ; сидов нет; решения хранят снимок разрешённых
  значений и версий.
- **`id_counters`**: `legacy_reserved_at timestamptz?` — ставит проход по метаданным
  снимка на этапе 3 (SPEC §6.4) или bootstrap для модели и типа без легаси; пока пусто
  для типа, у которого по конфигурации есть легаси, приёмка номер не выдаёт (иначе PPV
  на этапе 2 получил бы `PPV-001` заново). Начальный `next_number` задаёт bootstrap.
- **`work_operations`**: `paused_reason text?` (`switch_off:<ключ>`) — исполнитель, взяв
  работу выключенной области (SPEC §8), ставит причину и отпускает работу; включение
  снимает причину у работ своего ключа и ставит `next_attempt_at = now()`; захват —
  `paused_reason IS NULL AND state IN ('pending','retry_wait') AND next_attempt_at <=
  now()` или `state = 'running' AND lease_until < now()`; прежний
  `state <> 'succeeded'` захватывал отменённые и проваленные; поколение аренды
  проверяется на каждом чекпойнте, продлении и завершении; потерявший аренду
  останавливает свой процесс; успех неизменен; выборка — `FOR UPDATE SKIP LOCKED` по
  видам своей роли; периодическая работа — новая строка на интервал (интервал в
  `work_key`, поток в `stream_key`); восстановление после падения — тот же захват по
  истёкшей аренде (продление аренды, выборка и периодика — 30.09.2026, pg-boss снят).
  `model_id` пустым бывает только здесь, в `idempotency_keys`, `action_log`, у глобальных
  строк `policy_settings` и у общих тегов; CHECK: строка без модели не несёт модельных
  целей; PK `id` и UNIQUE `(model_id, id)`: ссылки модельных таблиц на работу составные
  `(model_id, work_id)`, работа без модели в них не попадает; структурный тест держит
  этот список исключений и это правило.
  Исполнитель (`packages/db/src/work`, 30.10.2026): места внутри роли — `fetch`
  (`FETCH_JOBS`), `encode` (`ENCODE_JOBS`: `derive_video`, `encode_master`, `verify_master`,
  `uniq_render`), `copy` (`COPY_JOBS`: `render`, `render_compat`, `extract_frame`), `image`
  (`IMAGE_JOBS`) и `general` — остальные виды `worker`; больший `priority` идёт раньше;
  попытка считается при захвате, возврат при остановке и пауза выключателем её снимают,
  падение процесса — нет; итог и доменная запись результата (`commit`) — одна транзакция под
  проверкой поколения; исход каждой попытки — событие `work.succeeded | retry | failed |
  returned | paused` в журнале. Планировщик пишет `work_key = <stream_key>@<начало
  интервала>` по часам базы.
- **`custom_orders` / `custom_order_deliveries`**: `expects_video boolean NOT NULL`,
  `expects_photos boolean NOT NULL`, `photo_count?`, CHECK `(expects_video OR
  expects_photos)`; `video_completed_at/by?`, `photos_completed_at/by?` ставит команда
  агента (фото — число разных логических файлов по действующим сдачам ≥ `photo_count`,
  если задано; несколько роликов — одна часть «видео», отмечается, когда пришли все);
  `deliveries.part` CHECK `video | photos`; отзыв сдачи — новая строка с `retracts_id`
  (составной FK на тот же заказ), `manifest_id NULL`, UNIQUE `(retracts_id)`; UNIQUE
  `(model_id, order_id, manifest_id)` становится частичным `WHERE manifest_id IS NOT
  NULL`; `delivered` ⇔ все ожидаемые части сданы и не отозваны; `closed` требует
  `delivered` и отсутствия открытых правок; все изменения заказа сериализуются на строке
  заказа. Таблицы частей нет (заказы из нескольких видео редки — решение владельца
  11.09).
- **`placements` / `placement_evidence`**: время события может быть неизвестно, если
  есть улика (`event_precision`) — заявки легаси без даты; CHECK на тройку `(source,
  kind, strength)`: `manual_confirm` и `reused_pair → exact`, `import → claim`, `hub →
  hub_observation_id NOT NULL`, а у отрицающих видов `manual_reject | retract |
  outside_catalog` `strength IS NULL` — отказ ничего не утверждает и не должен
  считаться слабой положительной заявкой (прежний CHECK делал ручную улику точной
  всегда).
- **`hub_posts`**: убран `matched_placement_id` — один пост бывает двумя размещениями
  (стена и FYP с общим `external_post_ref`, схема §3.6); связь выводится из размещений по
  `external_post_ref` и поверхности, очередь неразобранных — `NOT EXISTS`.
- **`action_log`**: `id bigint IDENTITY`, `at`, `model_id?`, `actor_type (human | agent
  | system)`, `actor_id?`, `actor_label`, `action`, `entry_kind (action | change)`,
  `item_id?`, `request_id?`, `work_id?`,
  `subject_kind`, `subject_id?`, `subject_label`, `before jsonb?`, `after jsonb?`,
  `result (ok | denied | error)`, `payload_version`. Без партиций; BRIN по `at`; индексы
  `(model_id, subject_kind, subject_id, at DESC)`, `(model_id, at DESC)`, `(actor_id, at
  DESC)`. Механика — схема §9.3.
- **`sessions`, `api_tokens`**: без изменений, отдельно.
- **Миграции 0002 и 0003** (этап 2а, 30.10.2026) — где норма молчала, выбран самый простой
  вариант, который держит инварианты:
  - `0002_bytes_sources` — `pipeline_versions`, байты и производные (`blobs`, `blob_probes`,
    `blob_phashes`, `master_checks`, `storage_operations`, `rendition_generations`,
    `rendition_artifacts`), источники (`sources`, `source_objects`, `source_paths`,
    `source_revisions`) и FK `work_operations.output_sha256 → blobs`; `0003_catalog` —
    каталог, приёмка, квитанции выдачи, типизированные цели работ, `blob_is_referenced`,
    поиск и `catalog_index`. Колонки и FK на заказы (`inbox_groups.custom_order_id`,
    `inbox_draft_candidates.order_id`) добавляет `0004_orders`.
  - Отпечатки, а не ссылки (FK на `blobs` нет): `blob_probes.sha256`, `blob_phashes.sha256`,
    `master_checks.*`, `storage_operations.blob_sha256` (иначе операция удаления держала бы
    свой же блоб), `rendition_generations.master_sha256`, `review_cases.blob_sha256`.
    `blob_is_referenced(sha256)` держит: мастер любой версии; `master_sha256` и
    `source_blob_sha256` черновика, пока он не `resolved`; `web_uploads.sha256`, пока загрузка
    не дошла до черновика (`receiving | received | verified`); выход работы в `pending |
    running | retry_wait`. Тест сверяет список с каждым FK на `blobs (sha256)`. Строку
    `blobs` прикладная роль не удаляет (REVOKE DELETE).
  - Записанное однажды (функция `set_once`, NULL → значение): у ревизии `source_sha256`,
    `verified_at`, `verified_route`, `frozen_by_work_id`, `frozen_path` (три первых — только
    вместе, два последних — тоже); у
    поколения производной `master_sha256` и `bound_at`. Наблюдённые колонки ревизии, ключ
    поколения и байты артефакта — `forbid_change`.
  - `storage_operations`: отменить можно только `intent`, завершённая операция не меняется
    (триггер, код `CO005`); переходы между шагами — в коде.
  - Роль подходит типу — функция `role_fits_type(type, role)` по naming §3 (`cap` — файл
    скачивания, ни одному типу не подходит); `_uN` — только у мастера FYP; ссылка
    (`reference`) — только в `PRM`; `pinned_version_id` — только у ссылки. Сводка — в
    `values.rolesByType`, тест сверяет каждую пару.
  - `content_items`: `raw_purpose` обязателен ровно у RAW, `name_in_media` — только у CUS,
    `promo_channel_id` — ровно у PRM; триграммы по `title` и `title_en`. Публичный ID с
    паддингом — функция `public_item_id(type, number)`.
  - Квитанция выдачи всегда ссылается на закрытый состав (`manifest_id NOT NULL`, одиночное
    скачивание — состав из одной версии); строка — ровно один выданный файл: артефакт,
    мастер как есть или файл папки выдач; `UNIQUE (model_id, asset_version_id, id)` — цель
    FK совпадений Hub (схема §9.6). Состав и квитанция сверяются отложенным триггером
    `check_sealed_count` (число строк = `entry_count`, позиции `1..N`, код `CO004`).
  - Черновик: `master_verified_at` только с `master_sha256`; принятие (`new_item | append`)
    — с `applied_item_id`; `alias` — с `duplicate_of_version_id`; `rejected` — с
    `rejected_at`. Возврат из `resolved` — триггер `inbox_draft_transition`: только из
    `rejected`, только в `ready`, только пока байты черновика `present` (замок `FOR SHARE`
    на строках `blobs`, код `CO005`).
  - Тег чужой модели отклоняет триггер `item_tags_tag_scope` (код `CO006`); у `item_tags`
    есть `id` — субъект журнала, ключ по-прежнему `(model_id, item_id, tag_id)`.
  - Ссылки, где норма не задала форму: `asset_manifest_entries.membership_id`,
    `source_revisions.previous_id`, `provenance.voided_by_id` (исправление, один преемник) —
    составные FK `(model_id, …)` без доп. колонок. `master_checks.work_id` обязателен.
    `annotation_fields.value_version` начинается с 0 (поле подтверждено пустым).
  - Поиск: `search_tsv` объекта — `russian` по `title` и описанию, `english` по `title_en`
    (конфигурация `russian` и сама стеммит латиницу как английскую); функции
    `catalog_tsquery(q)` и `catalog_search(model_id, q)` — объекты модели по названиям и
    описанию, по подстроке алиаса (без учёта регистра, NFC) и по хронологии, без tombstone.
  - `catalog_index` (`security_invoker`): поля SPEC §12.0, кроме даты сдачи и ссылки на
    заказ (с `0004_orders`); теги — slug (после слияния тега — slug выжившего);
    «SteadyContent» — общий тег вендора `steadycontent`, отдельной колонки нет; обложка —
    `cover_membership_id`, иначе первое живое членство; миниатюры — ID активных готовых
    поколений `thumb320` / `thumb640`.
  - Зеркало Drizzle — только таблицы: drizzle-kit 0.31 превращает составной FK в связь по
    одному `model_id` и повторяет ключи, поэтому `relations.ts` не порождается; соединения
    пишутся в SQL.
- **Миграция 0004** (`0004_orders`, этап 2в, 30.10.2026) — где норма молчала, выбран самый
  простой вариант, который держит инварианты заказа в базе (ведение заказов — этап 4б):
  - Статус между `open` и `delivered` выводит триггер `custom_orders_status` из отметок
    частей; команда пишет отметки (`video_completed_at/by`, `photos_completed_at/by`),
    `closed` с `closed_at/by` или `cancelled` с причиной, сам `delivered` не пишет. Отметка
    стоит только на действующих сдачах своей части: видео — хотя бы один ролик, фото — не
    меньше `photo_count` разных файлов-изображений (без числа — хотя бы одно; функция
    `custom_order_live_files`). Отметку незаказанной части отклоняет CHECK, остальные отказы
    — код `CO005`.
  - `closed` — только при всех отметках и без открытых правок. `closed` и `cancelled`
    окончательны: статус, отметки и ожидаемые части не меняются, новых сдач, отзывов и
    открытых правок нет; поля карточки править можно. Возврата из «снят» нет
    (предварительно, список статусов закрывается до `schema-freeze`).
  - Сериализация: сдача, отзыв и правка первым делом берут замок строки заказа (`FOR NO KEY
    UPDATE`, триггеры `custom_order_deliveries_lock` и `custom_order_revisions_lock`),
    отметки и закрытие берут тот же замок своим UPDATE; проверка идёт после замка и видит
    всё, что закоммичено до него.
  - Сдача неизменна, как версия: UPDATE и DELETE запрещены, триггера журнала нет, её запись
    — строка `action` команды. Сдача — одной части; кастом с видео и фото — две сдачи со
    своими составами (`asset_manifests.purpose = 'submission'`). `item_type` по умолчанию
    `'CUS'`, CHECK `= 'CUS'`; основание (`basis`) и `delivered_at` обязательны. Отзыв —
    строка с `retracts_id` и `retract_reason`, без части, CUS, состава и даты; время отзыва
    — его `linked_at`, поэтому `retracted_at` не нужен. Отзыв снимает отметку своей части
    (команда ставит её снова, если часть всё ещё сдана); отзыв отзыва — `CO005`. UNIQUE
    `(model_id, order_id, manifest_id)` обычный: у отзывов состава нет, они не сталкиваются.
  - `ordered_duration_raw` может быть пустым: у 2 из 41 изученной карточки длительности нет
    (`legacy-and-import.md` §9.2); `duration_min_s/max_s` — целые секунды, как названы;
    `name_in_media` по умолчанию `unknown`; `done_basis` — свободный текст; `tg_topic` и
    `tg_message_id` — числа. Неизменны `model_id` и `id` заказа, у сообщений и правок ещё
    `order_id`.
  - `catalog_index`: в конце добавлены `order_id` и `delivered_at` первой действующей сдачи
    CUS; `name_in_media` у CUS с заказом берётся из заказа.
- **Миграция 0007** (`0007_promo`, этап 4в, 30.10.2026) — где норма молчала, выбран самый
  простой вариант:
  - `content_items.default_contractor_id` с составным FK и CHECK «только у `PRM`»; команда
    «Подготовить передачу» запоминает в нём выбранного подрядчика.
  - `promo_deliveries`: копия типа `package_item_type = 'PRM'`; `channel_id` — снимок канала
    подборки; `format` — снимок формата подрядчика при подготовке. CHECK
    `promo_deliveries_sent` — как в §3.8; CHECK `promo_deliveries_prepared`: у передачи из
    продукта есть `prepared_at/by`, а квитанция есть ровно в `prepared` и `sent`; у прошлого
    пака из импорта нет формата, подготовки, квитанции и `corrects_id`.
  - Переходы `preparing → prepared → sent` (триггер `promo_deliveries_transition`, отказ —
    `CO005`); отправленная передача заморожена (`forbid_update_delete` с условием `state =
    'sent'`), `receipt_id` пишется один раз (`set_once`), прикладная роль строку не удаляет.
    Неизменны модель, подборка, канал, подрядчик, формат, состав, источник, `corrects_id` и
    `prepared_at/by`.
  - Новая подготовка подборки тому же подрядчику до «Передано» заменяет прежнюю: новая строка
    с `corrects_id` (один преемник); заменённая из списков уходит, «Передано» на ней — 422
    `handoff_replaced`. «Не собралось» не хранится: это `preparing`, чья работа `export`
    упала; работа находится по типизированной цели `work_operations.manifest_id` (индекс
    `work_operations_manifest`), отдельной колонки работы у передачи нет.
  - Сборка — та же работа `export`, что у скачивания (схема §3.5): формат даёт вид копии
    («для заливки» — `platform`, «мастер» — мастер, «совместимая» — `compat`), готовые копии
    берутся из кэша, недостающие — `render`/`render_compat`; ZIP всегда один, `manifest.csv`
    последним (столбцы `prm, order, file_name, source_id, role, version, master_sha256,
    format, size_bytes`). Квитанция вида `promo` ссылается на состав передачи; та же
    транзакция переводит передачу в `prepared` и пишет в `summary` фактический объём файлов,
    объём и имя ZIP. Пока сборка идёт, `summary.estimated_bytes` — сумма готовых копий и
    мастеров.
  - `blob_is_referenced` не менялась: передача держит версии через состав, мастер любой
    версии уже ссылка на байты, версии не удаляются.
  - Ссылка в подборке получает в ней свою роль `clip`/`pic` и следующий номер (не больше 999
    на роль); материал на экранах называется файлом источника (`RAW-0213/raw03`). Повторное
    добавление снятой ссылки возвращает прежнее членство.

- **Миграции 0005 и 0006** (`0005_legacy_placements` — таблицы этапа 3, `0006_plan` — 4а,
  30.10.2026) — где норма молчала, выбран самый простой вариант, который держит инварианты в базе
  (импортёр — этап 3, команды плана — 4а):
  - Второй человек в кадре: триггер `posting_plan_rows_second_person` отклоняет строку на
    OnlyFans (новую, перенос, новый состав, вставку монтажа) кодом `CO007` с `DETAIL`
    `second_person` или `unchecked` (пустой флаг — «не проверено»); перед проверкой берёт
    `FOR SHARE` на объект, поэтому гонка с галочкой сериализуется. Поздняя галочка (триггер
    `content_items_second_person_late`) отменяет неотмеченные строки объекта на OnlyFans с
    причиной `second_person` (в списке причин отмены, людям не предлагается); отмеченные
    остаются историей и показываются «нельзя на OnlyFans».
  - Слот: `slot_tz` по умолчанию берётся из модели, `slot_at` команда может не писать —
    триггер `posting_plan_rows_slot` считает его сам, несогласное значение — `CO005`; перенос
    пересчитывает. Тот же триггер держит строку выпуска на странице выпуска и сверяет
    `release_surface_kind` с видом поверхности (составной FK с аккаунтом и видом не проходит
    общий отрицательный тест: у строки два FK на поверхность). FK выпуска — `(model_id,
    release_id, item_id)`, цель — UNIQUE `(model_id, id, item_id)`; одна живая строка на
    поверхность выпуска — частичный UNIQUE без отменённых. `ppv_releases.release_date` —
    просто дата модели.
  - Строка: отметка — автор, время, вид и отмеченный состав вместе (строка, ждущая монтаж или
    тизер, не отмечается); строка везёт состав или то, чего ждёт (`expected_type` FYP или PPV,
    `expected_role = 'teaser'`) или несобранную уникальную версию фупа (`uniq_variant_no` —
    номер `uN`, состав запечатывает `uniq_render`, когда версия собрана); отмена — по желанию
    с причиной. Поля публикации: `caption`,
    `tier_refs` (пусто — подписчики), `price_mills`, `repost`, `album_name`. Колонки 5б
    (`hub_publication_id` и статусы) добавит `0009_publications`.
  - Связи со строкой плана (`placements.plan_row_id`, `download_receipts.plan_row_id`,
    `web_uploads.plan_row_id`) добавляет `0006`; удалить строку нельзя, пока на неё ссылается
    квитанция или размещение (FK `RESTRICT`).
  - Размещение без внешнего ID (отметка КМ, «Отметить и подтвердить», заявка) — ключ
    `manual_key`, UNIQUE на поверхности; `event_precision` (`exact | day | unknown`) — заявка
    легаси без даты; `surface_source` дополнен `import` (поверхность по правилу импорта).
    `placement_assets` несёт `id` (субъект журнала) и простой FK на выданный файл.
  - Улика: тройка `(source, kind, strength)` — одним CHECK без списков; `retract` всегда со
    ссылкой на отзываемое, `legacy_claim` — со своей заявкой. `hub_observation_id` без FK до
    `0008_hub`.
  - Заявки легаси: при `resolved` ровно одна цель и время, иначе целей нет; версия — парой
    `resolved_asset_id`, `resolved_version_id`; заявка номера ссылается на свою заявку имени
    (`claim_id`, UNIQUE — естественный ключ).

### 9.3. Транзакции и протоколы

- **Принятие группы** — как в схеме §5, плюс: замки на строки байтов берутся в порядке
  возрастания SHA-256 (иначе два принятия с общими байтами взаимно блокируются);
  проверка `legacy_reserved_at` до выдачи номера; сдача части заказа — не сдача
  заказа.
- **Журнал**: триггер `log_row_change()` на каждой изменяемой доменной таблице; INSERT и
  DELETE пишут строку целиком, UPDATE — только отличающиеся ключи (`before` — старые
  значения, `after` — новые, ключ строки всегда); `SET LOCAL app.actor_type / actor_id /
  actor_label / action / request_id` обязательны — без них триггер отклоняет запись.
  Триггера нет на `work_operations`, текущих строках Hub, `principals`, токенах и на
  общих технических таблицах без модели — байты, их описания, проверки мастеров, операции
  с файлами, производные, версии конвейера (их журналы — наблюдения и типизированные события
  работ, которые их пишут). Типизированные события пишет код:
  исходы попыток работ (попытка, поколение, исход, время), смысл вставленных фактов,
  администрирование людей и токенов без секретов, отказ и ошибка — отдельной записью
  после отката. Полнота гарантируется каталогом БД (тест: у каждой изменяемой таблицы
  есть триггер), смысл — именем действия из сессии. Команда пишет на каждый затронутый
  объект одну строку `action` — строку ленты и «Истории» (действие, автор, `item_id`,
  параметры фразы в `after`); строки триггера — `change` с тем же `request_id` и
  `item_id` из `SET LOCAL app.item_id` (ставится перед изменениями каждого объекта), они
  дают раскрытие «было → стало». У команд настроек (люди, токены, норма недели, выключатели,
  пороги; у `principals` триггера нет) раскрытие берётся из `before`/`after` самой строки
  `action` — поле → значение словами, как на экране; имя действия — ключ маршрута таблицы
  (`plan.updateNorm`), события без модели видит только владелец (30.10.2026). Лента и
  «История» читают только строки `action`;
  индекс «Истории» — частичный `(model_id, item_id, at DESC) WHERE entry_kind = 'action'`.
  UPDATE только технических отметок (`last_seen_at`, `last_used_at`, `updated_at`,
  `row_version`) в журнал не пишется.
- **Операции с файлами** (запись и удаление байтов): (1) транзакция А —
  замок на строку байтов, свежая проверка нуля ссылок, вставка намерения, коммит; (2)
  сериализованный писатель хранилища коммитит отметку `started` в своей короткой
  транзакции **до** любого действия с файлом, выполняет идемпотентный шаг и проверяет
  результат; (3) транзакция Б — замок, запись исхода, смена `blobs.state` и зависимых
  состояний черновика или версии, журнал, коммит. Падение между (2) и (3) оставляет
  намерение, которое рестарт сверяет с диском до любых конфликтующих изменений. Удаление
  повторяет проверку ссылок в (1) и в (3). Одно живое намерение на блоб (частичный
  UNIQUE).
- **Создание ссылки на байты**: замок на строку байтов и `state = 'present'`. Протокола
  намерений и ожидания нет (30.10.2026): байты удаляет только команда владельца, она
  проверяет ссылки под тем же замком. `purged`, `missing`, `corrupt` — ссылка не создаётся,
  пока `put` не положит те же байты заново (битый файл перед этим убирается) и не вернёт
  строку в `present`; дубль при приёмке, совпавший с таким блобом, так его и чинит.
- **Возврат отклонённого черновика**: замок на черновик и байты; пока байты не удалены
  командой владельца, итоговая транзакция переводит черновик в `ready`, снимает исход,
  пишет обе записи журнала; исходный отказ остаётся в истории.
- **Точка восстановления**: барьер против удаления байтов;
  запись о завершении делается после снятия дампа и в него не попадает; внешний
  манифест с хэшем дампа, списком нужных хэшей, версией схемы и рецепта; восстановление
  сверяет дамп и замыкание ссылок и записывает восстановленную точку.

### 9.4. Неизменяемость и проверки

- `forbid_change(cols)`: `model_id`, `type`, `number`, `created_in_item_id`,
  `item_id` / `asset_id` / `kind` членства, заголовок состава и квитанции.
  `forbid_update_delete()` + `REVOKE UPDATE, DELETE` у прикладной роли на
  `asset_versions`, `asset_manifests`, `asset_manifest_entries`, `download_receipts`,
  `download_receipt_entries`, `custom_order_deliveries`, `placement_evidence`,
  `hub_observations`, `action_log`.
  Тест перечисляет все охраны.
- Приёмочные тесты (Testcontainers, PostgreSQL 18, прикладная роль): чистое применение
  и повтор без изменений; два раннера одновременно; обрыв между DDL и записью версии;
  несовпадение контрольной суммы останавливает запуск; золотой `schema.sql`; равенство
  со списками значений в коде; структурный тест `model_id`; сгенерированные
  отрицательные тесты на каждый составной FK (`23503`) и ручные внутри модели (чужая
  поверхность, чужая версия, чужая обложка, чужая сдача, исправление на
  чужом размещении, общий тег работает, чужой частный тег нет, работа без модели с
  модельной целью); негативы по каждому ограничению схемы §4 с поправками (повтор номера,
  второй объект из группы, второй черновик на ревизию, приёмка без проверенного мастера, повтор хендла
  при живых `master` + `u1` + `u2`, два владельца, вставка и правка состава и
  квитанции после создания, правка или отзыв на чужую сдачу, два отзыва одной сдачи,
  смена типа и номера, UPDATE любой неизменяемой таблицы, неизвестное значение CHECK);
  контракт байтов — `blob_is_referenced` против `pg_constraint`, повторная проверка
  ссылок перед удалением, возврат отклонённого черновика с байтами на месте и после
  удаления, скачивание с черновика
  Я.Диска и с веб-загрузки до объекта; транзакция приёмки под гонкой (один ключ
  идемпотентности — один объект и номер, разные ключи — отказ по группе, откат не
  тратит номер, без `legacy_reserved_at` номер не выдаётся); журнал (триггер на каждой
  таблице, запись без контекста отклоняется, у UPDATE только изменённые ключи,
  проваленная транзакция не оставляет успешной записи, секреты не попадают ни в журнал, ни в
  `idempotency_keys`); захват
  работ и истёкшие поколения, вставка работы в одной транзакции с доменной записью,
  восстановление по истёкшей аренде; части заказа (только видео при заказе видео+фото — не сдан, 1 из 20
  фото — не сдан, сериализация сдачи, отзыва, правки и закрытия); запрет OnlyFans при
  отмеченном и пустом флаге — при создании плана, замене состава и вставке монтажа, гонка
  галочки и плана; Hub A→B→A —
  три наблюдения, стена + FYP одного поста — два размещения, `manual_reject` никогда не
  `exact`; обрывы файловых операций до и после физического шага; bootstrap дважды;
  восстановление из точки «только БД» и полной.

### 9.5. Этапы и файлы миграций

Правило: таблица появляется с этапом PLAN, чей код её впервые пишет. Каждый
закоммиченный префикс валиден и держит все связи, которые его код может использовать;
поздние файлы добавляют колонки и FK в ядро (nullable, без перезаписи данных). Номер файла
— по порядку слияния, имя — по содержанию; ниже ожидаемый порядок (4в ждёт только 2б и
может встать раньше).

| Этап | Файлы | Таблицы |
|---|---|---|
| 1 | `0001_foundation` | `models`, `accounts`, `surfaces`, `promo_channels`, `principals`, `principal_grants`, `sessions`, `api_tokens`, `id_counters`, `policy_settings`, `work_operations`, `idempotency_keys`, `action_log` (13) + `schema_migrations`, права ролей `contentops_migrate` и `contentops_app` (только GRANT и REVOKE: роли с паролями из `.env` создаёт скрипт хоста, `CREATE ROLE` в миграции упал бы при втором прогоне в том же кластере), функции, `pg_trgm` |
| 2 (2а: `0002`, `0003`; 2в: `0004`) | `0002_bytes_sources`, `0003_catalog`, `0004_orders` (`blobs` раньше `asset_versions`) | `pipeline_versions`, `content_items`, `assets`, `asset_versions`, `item_memberships`, `asset_manifests`, `asset_manifest_entries`, `aliases`, `provenance`, `tags`, `item_tags`, `annotation_fields`, `chronology_entries`, `platform_texts`, `blobs`, `blob_probes`, `blob_phashes`, `master_checks`, `storage_operations`, `rendition_generations`, `rendition_artifacts`, `sources`, `source_objects`, `source_paths`, `source_revisions`, `inbox_groups`, `inbox_drafts`, `inbox_draft_candidates`, `web_uploads`, `review_cases`, `download_receipts`, `download_receipt_entries`, `custom_orders`, `custom_order_messages`, `custom_order_deliveries`, `custom_order_revisions` (36; заказы здесь, потому что приёмка привязывает CUS к заказу) |
| 3 | `0005_legacy_placements` | `legacy_claims`, `legacy_number_claims`, `placements`, `placement_assets`, `placement_evidence` (5) |
| 4 (4а) | `0006_plan` | `ppv_releases`, `posting_plan_rows` с полями публикации (2) |
| 4 (4в) | `0007_promo` | `contractors`, `promo_deliveries` (2) |
| 5 | `0008_hub` | `hub_sync_state`, `hub_observations`, `hub_posts`, `hub_post_attachments`, `hub_raw_media`, `hub_vault_albums`, `hub_vault_media` (7); FK `placement_evidence.hub_observation_id` |
| 5б | `0009_publications` | таблиц нет: связь строки плана с публикацией Hub (схема §3.5) |
| 8 (8а) | `0010_annotation` | `annotation_runs`, `annotation_suggestions` (2); nullable-ссылки и FK на запуски из полей, хронологии и текстов |
| 9б (бэкап только на сервере, решение 12.09.2026) | `0011_backup` | `backup_checkpoints` (1); `blobs.backed_up_at` и индекс очереди бэкапа |

Перенос ИИ на этап 8 принят владельцем 12.09.2026 (SPEC §8.3). Всего
68 таблиц: 13 + 36 + 5 + 2 + 2 + 7 + 2 + 1. На этапе 2 `annotation_fields`,
`chronology_entries` и `platform_texts` обслуживают импорт и ручной ввод; сведения
об источнике и авторе, версии и подтверждения сохраняются сразу.
`annotation_fields.suggested_by_run_id`, `chronology_entries.run_id` и
`platform_texts.run_id` вместе с FK добавляет только `0010_annotation`; ранние
миграции и прикладной код не ссылаются на отсутствующие таблицы ИИ. Поздняя миграция
оставляет эти ссылки пустыми у прежних записей, не меняет значения, версии,
подтверждения и происхождение и проверяется на заполненном каталоге этапа 7.

Этап 1 также ставит весь тестовый каркас (схема §9.4) и команду `bootstrap` (модель,
аккаунты, поверхности, каналы промо, общий словарь тегов, счётчики, первый владелец — из
конфигурации, идемпотентно; без сидов порогов). Раннер: advisory lock на
отдельном соединении, `schema_migrations (version, name, checksum, applied_at,
applied_by)`, файл = одна транзакция вместе с записью версии, несовпадение суммы
останавливает запуск; до заморозки файлы правятся на месте, а база создаётся заново:
Testcontainers одноразовые, стенд — `docker compose down -v`; команды сброса в продукте нет
(тег живёт в git, настоящую базу по нему не отличить);
заморозка — тег `schema-freeze` в первый день этапа 3
(решение владельца 30.09.2026): с него база в ВМ на winpc настоящая;
после — только новые файлы вперёд, откат = исправляющая миграция; восстановление из
точки — только на сервере (на winpc бэкапа нет, SPEC §12.3). Место: этот репо, `packages/db/migrations`, `packages/db/src/values.ts`
(все списки значений), зеркало Drizzle и золотой `schema.sql` — оба порождаются из
миграций одним шагом (зеркало — `drizzle-kit pull`), руками не правятся.

### 9.6. Дополнение по сверке с Hub (блокер 4, 11.09.2026)

Итог второй арены того же дня (та же пара планировщиков, четыре раунда, оба «да»).
Норма — SPEC §7 «Правила сопоставления» и §8.1; здесь — уровень колонок.

- **`hub_post_attachments`**: ключ `(model_id, post_id, attachment_index, member_index,
  role)` UNIQUE NULLS NOT DISTINCT (пачки разворачиваются в участников, у превью своя
  роль; прежний ключ по позиции их не вмещал) плюс стабильный ключ строки Hub; `role`
  (`main | offer_preview | bundle_preview`); `link_state` — семь живых значений Hub
  (`resolved | attachment_ref_missing | media_ref_missing | bundle_members_missing |
  preview_unresolved | file_metadata_missing | non_media_attachment`) в `values.ts`;
  колонки совпадения (пересобираемая проекция): `matched_asset_id?`,
  `matched_version_id?` с составным FK `(model_id, matched_asset_id,
  matched_version_id) → asset_versions (model_id, asset_id, id)`, `receipt_entry_id?`
  с составным FK `(model_id, matched_version_id, receipt_entry_id) →
  download_receipt_entries (model_id, asset_version_id, id)` и CHECK «квитанция только с
  версией» (вместе они заменяют простой FK `receipt_entry_id`; 30.10.2026), `match_strength text` CHECK по списку
  `placement_assets.match_strength`, `matched_at?`. Точное совпадение файла без
  установленной поверхности живёт здесь; размещение создаётся, когда поверхность
  установлена (по Hub — SPEC §7 «Поверхность», отметка КМ на строке плана, очередь).
- **`placements`**: `surface_source text` (`hub | km_mark | km | plan`) — откуда
  поверхность; строки с неподтверждённой поверхностью не участвуют в расчёте норм по
  поверхностям.
- **`placement_evidence`**: ключи дедупликации `exact:<media_ref>:<observation_id>`,
  `cand:<plan_row_id>:<manifest_id>:<observation_id>`, `cand:hist:<asset_id>:<observation_id>`
  (история без плана, SPEC §7, 30.09.2026; только Fansly — на OnlyFans прохода нет, старое
  КМ отмечает «Уже залито» пакетом или «Было», 30.10.2026) и `pub:<hub_publication_id>:<observation_id>`
  (с 5б: строка, отправленная через Hub, получает `hub / observed / exact` по
  `platform_post_ref`, без сопоставления); полезная нагрузка кандидата —
  строка плана (у истории её нет), состав, сигналы (`dt_minutes`, `count_match`, `metadata_hits`,
  `name_only_hits`, `caption_id_hit`, `fyp_flags`, `wall_refs`); у ручного
  подтверждения `payload.basis` (`inspected_pair | execution_report`).
- **`hub_sync_state`**: `available`, `unavailable_reason` — из capabilities и
  `sync_streams.syncStatus`; `consecutive_failures` — из `sync_streams`; `hub_succeeded_at`
  — из `sync_streams.succeededAt`: старше окна «не вышло» (24 ч) — «временно недоступно:
  Hub не обновлял посты … с …», строки «не проверено» с этой причиной, кнопка «Отметить и
  подтвердить» от этого не появляется (30.10.2026); `last_error` —
  своя ошибка опроса (текста ошибки в `sync_streams` нет);
  для датасета постов `window_from/to`, `expected_count`, `observed_count`,
  `stop_reason`, `proven_complete_at` остаются NULL, пока в `capture_coverage` Hub нет
  плана для постов (E7); когда появится — заполняются только при `status =
  provider_exhausted` с `proof`, крайние даты без доказательства интервал не задают;
  привязка к попытке работы `hub_sync`. Отрицательный вывод по постам требует
  последнего успешного планового опроса не старше двух интервалов.
- **`posting_plan_rows.requires_new_upload`**: `false` выполнено точным членством с
  действующим присутствием (член, отсутствовавший при более позднем обходе, не
  выполняет до нового наблюдения); `true` — только новым файлом
  (`hub_raw_media.created_at_platform` позже `created_at` строки) или подтверждением
  КМ; новое членство старого файла и неизвестное время — подсказки.
- **`policy_settings`** ключи: `hub_candidate_tolerance`, `hub_exact_duration_ms`,
  `hub_wait_window`, `hub_not_out_window`, `hub_vault_recheck`; значения при запуске —
  SPEC §7.
- **Альбомы vault**: объектный альбом — `aliases` вида `vault_album` по названию
  (`ID_LOOSE`), корзины (`FYP YYYY-MM`, `Lifestyle`, PPV) — настройка страницы `vault_bins`
  в `policy_settings`; колонки `label_manual` нет.

### 9.7. Дополнение по импорту легаси (блокер 5, 11.09.2026)

Третья арена того же дня, оба «да». Норма — SPEC §6.3–6.4; здесь — колонки.

- `source_revisions.remote_sha256?` — хэш от API Я.Диска (у Dropbox его нет: дубль
  ищется после скачивания по `source_sha256`): группировка дублей до скачивания и цель
  проверки локальной копии; `source_sha256` остаётся локально
  посчитанным; индекс `(model_id, remote_sha256)` — точный дубль ищется среди всех
  черновиков, и непринятых тоже.
- `sources.kind` + `legacy_metadata` — закреплённый экспорт реестра PPV как источник со
  стабильными ключами строк, чтобы заявки без файла имели `source_object_id`; сам
  экспорт — строками снимка в базе (пакета `legacy-snapshots/` нет, выгрузка — по команде),
  в репозиторий только обезличенные фикстуры.
- `inbox_drafts.origin` + `legacy_import`; `inbox_drafts.blocked_reason` +
  `source_unavailable` (только без проверенных байтов; с ними черновик принимается с
  пометкой «исходник удалён с Я.Диска») и `deferred` («отложено до 9а»: ревизия снимка вне списка партии
  PLAN этапа 7; список `resource_id`, не путей — файлы переезжают, — ключ модели
  `import_batch_scope` в `policy_settings`;
  байты не скачиваются, на 9а список снимается); `source_objects.gone_since`.
- `legacy_claims.claim_key` — естественный ключ из наблюдённой идентичности входа и
  позиции фрагмента (переименование даёт новую заявку, повтор — нет);
  `payload.account_rule` — версия правила соответствия аккаунтам;
  `legacy_number_claims` — естественный ключ на исходную заявку.
- Дети архивов — `(model_id, archive_revision_id, archive_entry_no)` с FK на ревизию
  родителя; порядковый номер записи, одинаковые имена различимы; контейнер архива
  блобом не становится.
- Работа `import_parse`: входы — снимок и версия правил; `work_key =
  import:parse:<снимок>:<версия правил>`, `dataset = parse`, `scope` — работа снимка;
  `id_counters.legacy_reserved_at` ставится
  только после полного прохода по читаемым источникам и ссылается на эту работу.
  Сухой прогон — та же работа с `dataset = plan` и `work_key =
  import:plan:<снимок>:<версия правил>:<запрос>`: пишет только отчёт в `report`
  (`apps/server/src/legacy/parse.ts`, этап 3, 30.10.2026).
- Реестр PPV и альбомы vault — объекты источника `legacy_metadata` «Легаси: реестр и
  альбомы»: строка реестра — объект с `resource_id` = ключ строки (`registry:<хэш папки>`),
  альбом — `vault:<хэш>`; объекты и заявки по ним пишет проход, сама выгрузка лежит в
  `policy_settings` (`legacy.registry`), кто и когда её дал — в журнале.
- Папка внутри ZIP без собственной записи оглавления держит свои заявки на объекте архива:
  ключ заявки несёт имя папки, поэтому не совпадает с заявками имени архива.
- Резерв счётчиков: `next_number = GREATEST(текущий, max(заявленных) + 1)` по каждому
  типу, 1 — только стартовый пол; выданные номера и tombstone не пересматриваются.

### 9.8. Дополнение по облачной разметке (блокер 7, 11–12.09.2026)

Четвёртая тема аренды того же дня; норма — SPEC §8.3 и §12.0.
Подключение, замеры и таблицы запусков и предложений перенесены на этап 8 PLAN
решением владельца 12.09.2026; ранние поля и миграции — схема §9.5.

- **`annotation_runs`**: `stage` (`observe | aggregate | texts`), `state` (`queued |
  running | succeeded | partial | refused | failed | cancelled | blocked`),
  `parent_run_id?`, `route_position`, `consent_setting_id?`, `billing_scope`,
  `frame_manifest_digest`, `withheld_count`, `probe`, резерв и фактическая стоимость,
  ID запроса поставщика, отметка отправки, флаг «исход неизвестен». UNIQUE по цели,
  `input_sha256` (байты медиа — происхождение) и `config_digest`, куда входят стадия,
  очищенные входы стадии и версии зависимых запусков (наблюдения, описание КМ),
  поставщик и модель, промпт и схема, манифест кадров и окна: изменённое описание или
  окно — новый запуск, старые предложения и отказы не переиспользуются. `raw_response`
  — очищенный диагностический конверт, не эхо входа.
- **`annotation_suggestions`, `annotation_fields`, `chronology_entries`,
  `platform_texts`** — без изменений: применение только к неподтверждённому полю с
  проверкой версии; два ряда текстов `en/1`, `en/2` со своими версиями; хронология
  только с реальными минутами.
- **`work_operations`** вид `annotate`: чекпойнты по окнам, отказ завершает работу,
  а не крутится в `retry_wait`.
- **`policy_settings`** ключи: `annotation.enabled`, `annotation.route.<тип>.<стадия>`,
  `annotation.external.<поставщик>` (согласие: кто, когда, типы, стадии, кадры, режим
  приватности), бюджеты, лимиты, параллельность, размыкатель; новые маршруты выключены.
- Кадры — из прохода декодирования приёмки под `derived/gen/<generation_id>/frames/`,
  не вытесняются; до этапа 8 создаются без вызовов моделей и работ `annotate`;
  новых таблиц нет.

### 9.9. Кто что решил

Владелец (11.09): одна галочка второго человека и запрет OnlyFans; журнал подробно;
права на модель; пороги — настройки, выключено по умолчанию; все версии хранятся; люди
правят заказы; заказ сдан при всех частях; технические умолчания приняты; остатки
(части заказа флагами, снятие `placement_checks`, ужатие этого файла после этапа 1,
формулировка «второй человек в кадре») поручены оркестратору. Планировщики сошлись
сами по ядру, шести удалениям, границам этапов и всем исправлениям схемы §9.2–§9.4 после
четырёх раундов; спорных пунктов не осталось.
