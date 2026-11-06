# Памятка: ловушки ПК и ВМ

Пилот ContentOps — ВМ Hyper-V `contentops` на winpc (SPEC §12.1–12.2). Состояние на
30.10.2026; подробная история хоста — `~/code/8-docs/server-inventory.md`, раздел winpc.

## Вход

- `ssh contentops-vm` — ВМ: Ubuntu 26.04, пользователь `dmitriy`, sudo без пароля, вход
  только ключом мака (Tailscale 100.75.114.22 через `winpc`).
- `ssh winpc` — Windows 11, сразу в pwsh 7. Кавычки и `$` по ssh ломаются: сложное — только
  скриптом через stdin: `ssh winpc 'pwsh -NoProfile -Command -' < script.ps1`, в WSL —
  `ssh winpc 'wsl -e bash -l' < script.sh`. Прямо — только простые команды (`Get-VM`,
  `schtasks`).
- Адрес ВМ в Default Switch меняется при каждом старте ВМ и после перезагрузки ПК (29.10:
  172.28 → 172.20) — его нигде не записывать. Постоянные адреса: внутренняя сеть хост–ВМ
  `contentops-int` (хост 10.77.0.1, ВМ 10.77.0.2) и Tailscale.
- Tailscale в ВМ ходит к своему серверу только через порт 443 (`TS_FORCE_NOISE_443=true` в
  `/etc/default/tailscaled`, 30.10): через порт 80 карта сети не приходила (`map response
  long-poll timed out`), и узел после перезапуска ВМ висел offline. Запасной вход, если
  узел offline: `ssh -o HostKeyAlias=100.75.114.22 -J winpc dmitriy@10.77.0.2`.

- Провайдер ПК режет TLS 1.3 к Cloudflare (Docker Hub, npm, API ИИ), если в приветствии есть
  постквантовый обмен ключей (X25519MLKEM768, по умолчанию у OpenSSL 3.5, Go и Node 24):
  соединение открывается, ответа нет (`TLS handshake timeout`). Windows (Schannel) и мак это
  не задевает. Поэтому в ВМ `GODEBUG=tlsmlkem=0` у dockerd
  (`/etc/systemd/system/docker.service.d/tls-classic.conf`) и у клиента `docker` (`/etc/environment`:
  сборка берёт токен Docker Hub на стороне клиента), 30.10; Node в образе — только с
  классическими группами (`OPENSSL_CONF`, Dockerfile), а `curl` из ВМ к таким адресам — с
  `--curves X25519:P-256`.

## Что не трогать

- **Копия Я.Диска** `C:\Users\dmsrg\Yandex.Disk` (в ВМ — `/mnt/ydisk`): ничего не удалять,
  не переносить и не переименовывать ни из Windows, ни из ВМ — уедет в облако при
  следующем запуске клиента. В ВМ она только для чтения: cifs `ro` по внутренней сети,
  подключается при первом обращении (`x-systemd.automount` в `/etc/fstab`), пароль —
  `/etc/contentops/ydisk.cred` (600); на Windows доступ только у `PC\contentops-ro`, порт
  445 открыт только для 10.77.0.2.
- D: — архив владельца. На E: — папки владельца; наше там только `E:\vm\contentops\`.
- Дистрибутивы WSL, другие ВМ, политика Windows Update, клиент Я.Диска.
- В ВМ не запускать агентов и тестовые стеки: с этапа 3 там единственная настоящая база,
  бэкапа нет.

## Диски ВМ

| Файл на Windows | Размер | В ВМ | Рабочие папки |
|---|---|---|---|
| `C:\vm\contentops\os.vhdx` | 40 GB | `/` | система, Docker |
| `C:\vm\contentops\data.vhdx` | 1 TiB, растущий | ext4 `co-data` → `/srv/vol/data` | `/srv/content` (блобы, загрузки, вывод кодера рядом с блобами), `/srv/db` (Postgres) |
| `E:\vm\contentops\derived.vhdx` | 300 GiB, растущий | ext4 `co-derived` → `/srv/vol/derived` | `/srv/derived` (`DERIVED_ROOT`: превью, кадры, миниатюры), `/srv/tmp` (предзабор, выдачи, scratch 60 GB) |

- Рабочие папки — bind-монтирования папок с дисков (`/etc/fstab`, блок `contentops data
  disks`); все шесть точек проверяются `mountpoint -q`. У всех `nofail`, диск ждут 10 с:
  ВМ загрузится и без него. Docker стартует после монтирований.
- Пустые точки монтирования на системном диске неизменяемые (`chattr +i`): если диск не
  смонтирован, запись туда падает с ошибкой, а не ложится тихо на системный диск. Внутри
  контейнера том всегда выглядит смонтированным — `mountpoint -q` проверяется на хосте.
- Если пропал E:, Hyper-V не запустит ВМ вовсе (нет файла диска). Поднять без превью:
  `Remove-VMHardDiskDrive contentops -ControllerType SCSI -ControllerNumber 0
  -ControllerLocation 2` — ВМ стартует, `/srv/derived` и `/srv/tmp` пусты и закрыты на
  запись. Вернуть — при выключенной ВМ `Add-VMHardDiskDrive contentops -ControllerType
  SCSI -ControllerNumber 0 -ControllerLocation 2 -Path E:\vm\contentops\derived.vhdx`, затем
  `Start-VM contentops`.
- Владелец рабочих папок — uid/gid 1000 (`dmitriy`, под ним же пойдут контейнеры),
  `/srv/db` — 0700. Postgres в compose — `user: "1000:1000"`, иначе образ при первом старте
  сам сменит владельца на своего.
- Переименование между `/srv/content` и `/srv/db` или между `/srv/derived` и `/srv/tmp` не
  работает (разные монтирования): атомарный rename — только внутри одного корня.
- Какой диск какой: SCSI LUN 1 — data, LUN 2 — derived; WWN диска в ВМ
  (`lsblk -o NAME,WWN`) содержит хвост `DiskIdentifier` из `Get-VHD` на Windows.
- Разметка воспроизводится скриптом `ops/vm/setup-disks.sh`:
  `ssh contentops-vm 'sudo bash -s' < ops/vm/setup-disks.sh` (на пустых дисках ≈ 5 мин).
  Повтор безопасен: размеченный диск не трогается, пустой размечается, только если он
  целиком из нулей; иначе — стоп. Он же ставит swap (ниже, «Память») и ежедневный `fstrim`
  («Место»); только swap, ничего больше не трогая, — `ssh contentops-vm 'sudo bash -s -- swap'
  < ops/vm/setup-disks.sh`, только `fstrim` — `… -- fstrim`.

## Место

- Диски растущие: удаление файлов в ВМ не уменьшает файл на Windows. Правда о месте —
  свободное на C: и E: в Windows (SPEC §12.2), не `df` в ВМ.
- VHDX растёт блоками по 32 MB. С настройками ext4 по умолчанию пустой data.vhdx занимал
  17 GB на C:, поэтому метаданные собраны в одну область (`-G 4096`), а inode меньше:
  data — 4M, derived — 4.9M (`df -i`).
- Пока идёт импорт, `derived.vhdx` растёт примерно на 50 GB в сутки (предзабор в `/srv/tmp`
  и производные): 06.11.2026 — 233.6 GiB при 75 GB занятого в ВМ. Поэтому сжатие — каждую
  ночь, само:
  - 04:00 МСК — `fstrim` в ВМ: `fstrim.timer` ежедневно, без случайной задержки (у Ubuntu —
    раз в неделю); ставит `ssh contentops-vm 'sudo bash -s -- fstrim' < ops/vm/setup-disks.sh`.
  - 04:30 МСК и через 10 мин после загрузки Windows — задача `ContentOps-Compact` (SYSTEM,
    `ops/winpc/ContentOps-Compact.ps1`, ставит `register-tasks.ps1`). На E: свободно 160 GB и
    больше (предупреждение `SPACE_WARN_GB`) — запись `not needed`. Меньше — выключает
    сторожа, гасит гостя, `Optimize-VHD -Mode Full`, затем `Start-VM` каждые 30 с до 30 мин
    и включает сторожа обратно. Сразу после сжатия у Windows может не быть свободных 22 GB для
    ВМ (06.11 так прошло 25 мин), поэтому каждая неудача старта — в журнале с причиной; не
    включилась за 30 мин — дальше её включает сторож.
  - Днём (вне 00–06) и при выключенном руками стороже задача ВМ не трогает. Оборвалась на
    середине (перезагрузка) — сторожа включит следующий запуск. Журнал —
    `C:\vm\contentops\logs\compact.log`.
  - Сжать сразу, в том числе днём (ВМ встанет на несколько минут), — `-Force` в отдельном
    процессе, чтобы обрыв ssh не оставил ВМ выключенной: `ssh winpc 'Invoke-CimMethod
    -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "powershell.exe
    -NoProfile -ExecutionPolicy Bypass -File C:\vm\contentops\ops\ContentOps-Compact.ps1 -Force" }'`.
- Замер 30.10.2026 после разметки и сжатия: data.vhdx 772 MB, derived.vhdx 612 MB; свободно
  C: 522.9 GB, E: 340.1 GB; в ВМ доступно data 1022 GiB, derived 298 GiB.
- Сжатие руками 06.11.2026: `derived.vhdx` 233.6 → 146.9 GiB, гость выключался 97 с,
  `Optimize-VHD` — 103 с; на E: стало свободно 197.7 GB.

## Вход для людей — `tailscale serve`

- Сейчас HTTP: `sudo tailscale serve --bg --http=80 http://127.0.0.1:8080` в ВМ —
  `http://contentops.tail1d911a.ts.net` → nginx стека (порт 8080 только на loopback), только
  внутри tailnet. `--bg` — настройка переживает перезагрузку; проверка — `tailscale serve
  status`. Funnel (публичный доступ) не включать.
- HTTPS ждёт владельца: в tailnet выключены HTTPS-сертификаты (`Serve is not enabled on your
  tailnet`). Включает владелец: админка Tailscale → DNS → HTTPS Certificates → Enable (имя
  машины с сертификатом навсегда попадает в публичный журнал сертификатов). Затем в ВМ
  `sudo tailscale serve --bg --https=443 http://127.0.0.1:8080`, `sudo tailscale serve --http=80
  off`, в `/opt/contentops/.env` — `PUBLIC_URL=https://…` (cookie станут `Secure`),
  `ops/up.sh`, и сторож на новый адрес: `register-tasks.ps1 -Enable -HealthUrl
  https://contentops.tail1d911a.ts.net/healthz`.

## Вход через VPN агентства

У Дианы и владельца на ноутбуках уже стоит WireGuard агентства (сервер `194.58.37.39`, сеть
`10.66.66.0/24`), поэтому Tailscale им не нужен: адрес **`http://10.66.66.1:8088`** открывается
при включённом VPN (решение 02.11.2026, проще общего доступа в tailnet; адрес в `PUBLIC_URL`
не меняется). Внутри VPN трафик шифрует WireGuard, между сервером VPN и ВМ — SSH.

- В ВМ служба `contentops-vpn-tunnel` держит обратный туннель SSH до сервера VPN: порт
  `10.66.66.1:8088` → `127.0.0.1:8080` nginx стека; перезапускается сама, ключ —
  `/etc/contentops/tunnel_ed25519` (только в ВМ). Проверка: `systemctl status
  contentops-vpn-tunnel`, снаружи `curl http://10.66.66.1:8088/healthz`.
- На сервере VPN — пользователь `contentops-tunnel` без оболочки; в его `authorized_keys`
  ключ ограничен (`restrict,port-forwarding,permitlisten="10.66.66.1:8088"`), настройка sshd —
  `/etc/ssh/sshd_config.d/60-contentops-tunnel.conf`.
- Порт закрыт для всех участников VPN, кроме перечисленных: `ufw status | grep 8088` на сервере
  VPN (сейчас `diana-macbook` 10.66.66.7, `diana-iphone` 10.66.66.6, `mbp-pro-16` владельца
  10.66.66.2). Новый человек — адрес из `/etc/wireguard/wg0.conf` и `ufw allow in on wg0 from
  <адрес> to 10.66.66.1 port 8088 proto tcp comment contentops`.
- Скорость скачивания упирается в исходящий канал домашнего интернета, около 4 МиБ/с.

## Стек и выкатка

- Стек — один Compose (SPEC §12.1): `db` (PostgreSQL 18.6), одноразовый `migrate`, `web`,
  `worker`, `worker-video`, `worker-image` (пять из одного образа) и `proxy` (nginx с
  интерфейсом). Снаружи открыт только `127.0.0.1:8080`. Логи — stdout, ротацию делает Docker
  (`local`, 20m×5, `/etc/docker/daemon.json`): `docker compose logs -f web`.
- Ставится из тега в `/opt/contentops` (владелец `dmitriy`, только чтение: правок там нет,
  агентов и тестовых стеков в ВМ нет):
  `cd /opt/contentops && git fetch --tags && git checkout --detach vX.Y.Z && ops/up.sh`.
  `ops/up.sh` проверяет `.env` (0600) и монтирования, собирает образ, ждёт `/healthz`.
  Повтор безопасен; `migrate` повторно ничего не меняет.
- `.env` — `/opt/contentops/.env` (0600, все переменные — `.env.example`); пароли БД в нём
  же. Первый пароль владельца — только `/etc/contentops/owner-initial-password` (root, 0600).
- Начальные данные (модели, страницы, счётчики, общий словарь тегов, владелец; образец —
  `packages/db/bootstrap.example.json`) — один раз командой bootstrap,
  повтор ничего не меняет:
  `docker compose run --rm -T -e CONTENTOPS_OWNER_PASSWORD -v /etc/contentops/bootstrap.json:/bootstrap.json:ro web node dist/db.js bootstrap /bootstrap.json`.
  Сброс пароля человека — `node dist/db.js reset-password <логин>` тем же способом.
- Пробный каталог для прогонов до этапа 3 (вымышленный, около 100 объектов Лоры; модель с
  объектами не трогает): `docker compose run --rm -T web node dist/seed.js lora`.
  С `--media` (в контейнере `worker`: там корни хранилища) у файлов настоящие байты —
  испытательные таблицы и градиенты FFmpeg и sharp, без людей, — а миниатюры, превью и кадры
  собирают роли воркеров: `docker compose run --rm -T worker node dist/seed.js lora --media`.
- Хранилище и медиаконвейер (`node dist/ops.js` в контейнере `worker`): `verify-blobs --wait`
  — сверка хэшей и список блобов без ссылок; `purge-blobs --report <id>` — что удалила бы
  команда владельца по отчёту (с `--yes` — удаляет; это стоп-лист, только владелец). До
  приёмки (2в) прогон на настоящем файле: скопировать его с `/mnt/ydisk` в `/srv/tmp`
  (читать с `/mnt` работам нельзя), затем `stage /srv/tmp/<файл> --model lora` (кадры и
  превью, мастер) и `render <sha256 мастера> --model lora` («Для заливки» без плана).
- Снимок источника в первый день этапа 3 (SPEC §6.3) — только командой, сам не ставится, и
  ставится ДО включения скана: `docker compose exec worker node dist/ops.js freeze lora
  "Я.Диск"` (дата — сегодня модели, повтор той же даты находит ту же работу), затем `ops.js
  switch ydisk.lora scan=on`, затем та же команда снимка с `--wait`. Пока снимок источника в
  очереди или идёт, штатный скан этого источника ничего не берёт (`waiting_for_snapshot` в
  отчёте): без курсора его первое окно — полный обход, и он завёл бы черновики и скачивания
  всего старого диска. Оборванный или частичный проход ничего не закрепляет и повторяется
  сам. Реестр готового снимка: `docker compose exec -T worker node dist/ops.js freeze-export
  lora [ГГГГ-ММ-ДД] > реестр.jsonl`.
- Разбор старых имён по снимку (SPEC §6.3–6.4) — командами CLI с токеном агента или
  владельца: выгрузка реестра PPV — `pnpm contentops legacy inputs --model lora --body
  @inputs.json` (`{"registry": "<таблица Markdown, CSV или TSV>"}`; там же `vault_albums` и
  `not_content` — пути папок и файлов снимка, которые не контент: без заявок и черновика);
  сухой прогон — `pnpm contentops import plan --model lora --wait --json` (отчёт в операции,
  ничего не пишет); его отчёт для чтения — `docker compose exec -T worker node dist/ops.js
  import-report lora > прогон.md` — с настоящими именами, в git не класть; проход —
  `pnpm contentops import parse --model lora --wait`: заявки, номера, спорное в «Разбор
  старого», затем резерв счётчиков. До прохода приёмка не выдаёт номера типов с легаси
  (`number_not_issued`); повтор с той же версией правил ничего не меняет.
- Байты старого корпуса — по корням в порядке SPEC §6.3 (PPV → секстинги → …): `pnpm
  contentops import bytes --model lora --root "1. PPV" --wait` (`--folder` — одна папка).
  Перед каждой партией обновить список копии (`Start-ScheduledTask ContentOps-CopyList`):
  воркер читает `/ydisk` (копия, только чтение) лишь там, где список говорит «байты на
  месте» и совпали размер и MD5; остальное — через API. Группа без спора принимается сама;
  спорное — в «Разбор старого» и ◆ в «Приехало». Повтор команды принимает то, что стало
  готово, и больше ничего не меняет. Партия — ключ `import_batch_scope` модели (список
  `resource_id`): остальное получает черновик «отложено» без скачивания. Сверка со снимком —
  `pnpm contentops import reconcile --model lora --wait --json`, Markdown — `ops.js
  import-report lora reconcile > сверка.md` (вне git).
- Заявки старых имён, которые пропустил алиас (до 05.11.2026 файл-алиас не переносил `used*` на
  объект, а алиас импорта не писал свой путь), — `docker compose exec -T worker node dist/ops.js
  claims lora`: печатает, сколько путей и заявок допишет, ничего не меняя; с `--yes` — пишет
  (пути-алиасы, размещения с уликой `import`). Повтор ничего не меняет.
- «Можно освобождать» (SPEC §12.2) — `docker compose exec -T worker node dist/ops.js
  release-report lora > освобождать.md` (вне git, настоящие имена; свежий список копии — как
  перед партией): корни, целиком взятые в импорт, с зелёной сверкой и мастерами на месте, по
  каждому файлу — размер, байты в копии, объект, SHA-256 источника и мастер; итог — ожидаемый
  выигрыш. Команда только читает. Само снятие закрепления — в клиенте Я.Диска на одобренном
  владельцем сеансе; ничего не удаляется.
- Владелец из оболочки ВМ — то же, что «Агенты и токены» и «Интеграции», без входа в браузер
  (`node dist/ops.js` в контейнере `worker`, в журнале — «система · ops»): агент по имени с
  ролью КМ или «Только чтение» и моделями (нет — заводится, недостающие модели добавляются,
  другая роль — отказ; владельцем агент не бывает) — `ops.js agent "Оператор" --role manager
  --models lora`, с `--token` — новый токен один раз в stdout (прежние токены агента
  отзываются); человек с ролью КМ или «Только чтение» (то же, что «Добавить человека»; занятый
  логин — отказ, новый пароль — `contentops-db reset-password`) — `ops.js person diana --name
  "Диана" --role manager --models lora`, временный пароль один раз в stdout; уже заведённому
  человеку — недостающие модели, как в «Люди и доступ» (ни одна не отбирается, роль и пароль
  прежние, в журнале — «Модели» до и после) — `ops.js grant diana --models ari`; подрядчик модели,
  как «Модели и страницы» (без него «Подготовить передачу» некому) — `ops.js contractor "<имя>"
  --model lora --channel twitter` (`--format upload|master|compat`, по умолчанию «для заливки»;
  есть — остаётся как был, другой канал или формат — отказ, их меняет экран); выключатели по коду интеграции — `ops.js switch ydisk.lora scan=on`, `ops.js
  switch agents enabled=on`, `ops.js switch hub.lora-1 receive=off`. Токен печатается
  только в stdout: сразу в файл, не на экран. Пороги по ключам схемы и настройки без экрана
  (метки рекламы страницы, партия импорта) — `ops.js policy hub_candidate_tolerance 30`,
  `ops.js policy hub_ad_markers '{"tags":["#ads"],"own_handles":["loravie"]}' --page lora-1`,
  `ops.js policy import_batch_scope '[…]' --model lora`; `off` — не задано (функция выключена).
- Без диска E: (или любого из `REQUIRE_HOST_MOUNTS`) `ops/up.sh` поднимает `db`, `web` и
  `proxy`, а воркеры — нет; `/healthz` красный с `volumes`. Проверка в контейнере — файл-метка
  `.contentops-volume` в корне хранилища: её пишет `ops/up.sh` после `mountpoint -q`; без
  диска корень — пустая неизменяемая папка, метки там нет, и воркер ждёт, ничего не беря.
- Перезагрузка ВМ: контейнеры поднимает Docker сам (`restart: unless-stopped`), `migrate`
  не повторяется. После правки `.env` или нового тега — снова `ops/up.sh`.
- Воркеры — с пониженным приоритетом (`nice`, вес CPU) и квотой (`VIDEO_CPUS=11`,
  `IMAGE_CPUS=4` из 16): ядро всегда остаётся `web`. При нехватке памяти первыми гибнут
  воркеры (`oom_score_adj`), `db` — последней.
- База до тега `schema-freeze` — тестовая; с этапа 3 — единственная настоящая: `docker
  compose down -v` и удаление `/srv/db` после этого запрещены.

## Облака моделей (2в)

- Источники модели — строки `sources` из `models[].sources` в `/etc/contentops/bootstrap.json`
  (`label`, `kind`, `root`, `credentials_ref`; повтор bootstrap добавляет новые, старые не
  меняет). Токены — только в `.env`: `YDISK_TOKEN` (OAuth Яндекса с `cloud_api:disk.read`),
  `DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY` (+ `DROPBOX_APP_SECRET`, если приложение не PKCE).
  Скан включает владелец в «Интеграции» по источнику; полный обход Я.Диска до первого дня
  этапа 3 не запускается (снимок `scan:freeze` — SPEC §6.3).
- Dropbox Лоры подключён 02.11.2026: приложение `contentops-lora` (только чтение, PKCE, без
  секрета), ключи — в `.env` ВМ и в `~/.config/agency/secrets.env` на маке
  (`CONTENTOPS_DROPBOX_*`). Следующая модель — так же:
- Вторая и следующие модели — то же приложение `contentops-lora`, авторизованное под Dropbox модели
  (ссылка authorize ниже, PKCE): свой refresh token в своей переменной, имя переменной —
  `credentials_ref` источника в `/etc/contentops/bootstrap.json`, и та же строка в
  `docker-compose.yml` у `web` и `worker` (Ари — `DROPBOX_REFRESH_TOKEN_ARI`, 03.11.2026).
- Dropbox для новой модели: dropbox.com/developers/apps → Create app →
  Scoped access → Full Dropbox → имя `contentops-<модель>`; Permissions — только
  `files.metadata.read` и `files.content.read` → Submit; Settings → App key (и App secret).
  Refresh token: открыть
  `https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline`
  под аккаунтом модели, «Allow», код обменять одним запросом
  `curl https://api.dropboxapi.com/oauth2/token -d code=<код> -d grant_type=authorization_code -u <APP_KEY>:<APP_SECRET>`
  → `refresh_token` в `.env` как `DROPBOX_REFRESH_TOKEN`, ключ — `DROPBOX_APP_KEY`, секрет —
  `DROPBOX_APP_SECRET`; затем `ops/up.sh`. Запросы на запись приложению не нужны и не даны.

## Место с Windows

- Задача `ContentOps-Space` (SYSTEM, при загрузке и каждые 5 мин) пишет свободное и полное
  место C: и E: в `C:\vm\contentops\host\space.json`. Папка — общая `contentops-host`, только
  чтение и только для `PC\contentops-ro` (тот же вход, что у `ydisk-ro`; в копию Я.Диска
  ничего не пишется). В ВМ — `/mnt/host` (cifs `ro`, automount, `ops/vm/setup-host-share.sh`),
  в контейнер `web` — `/host` только для чтения.
- Отчёт старше 15 мин на экране — «нет данных». Пороги пилота по дискам — предупреждение
  C: 200 ГБ, E: 160 ГБ (остановка и scratch 60 ГБ над ней), остановка забора — 100 ГБ на любом
  диске (`.env`: `SPACE_WARN_GB=200,E:=160`, `SPACE_STOP_GB=100`; число без диска — для всех
  дисков, `E:=…` — своё значение диска). Журнал ошибок задачи —
  `C:\vm\contentops\logs\space.log`.

## Список копии Я.Диска

- Из ВМ атрибуты Cloud Files не видны, а чтение заглушки через `/mnt/ydisk` запустило бы
  скачивание клиентом (SPEC §12.2). Поэтому задача `ContentOps-CopyList` (SYSTEM, pwsh 7,
  только по запросу, без расписания) запускает `ydisk-copy-list.ps1`: обходит копию, читая
  только метаданные (файлы не открываются, в копию ничего не пишется), и пишет в общую папку
  `ydisk-copy-list.jsonl` (строка на файл или папку: путь от корня копии как на диске, размер,
  время, атрибуты, `bytes_present`) и сводку `ydisk-copy-list.meta.json`. В ВМ —
  `/mnt/host/…`, в контейнерах `web` и `worker` — `/host/…`; читает `CopyList` из
  `@contentops/legacy`.
- Обновлять перед каждой партией импорта: `ssh winpc 'Start-ScheduledTask
  ContentOps-CopyList'` (≈ 3 с); готово, когда в сводке новое `finished_at`. Журнал —
  `C:\vm\contentops\logs\copy-list.log`. Ставится вместе с остальными задачами
  (`register-tasks.ps1`).
- Байты на месте — у файла нет `RECALL_ON_DATA_ACCESS` (0x400000, в том числе у частично
  скачанных), `RECALL_ON_OPEN` (0x40000), `OFFLINE` (0x1000) и `SPARSE_FILE` (0x200: заглушка
  разрежена, скачанный файл — нет). Остальное, всё, чего нет в списке, и файлы, чей размер не
  совпал с API, идут через API (SPEC §6.3). Папки с `RECALL_ON_OPEN` / `OFFLINE` не обходятся
  (`listed: false`): их обход позвал бы клиент.
- В списке настоящие имена (есть ники фанов): он лежит только в общей папке хоста; в git, PR
  и отчёты — только итоги.
- Замер 30.10.2026: 16 480 файлов, 545 папок, 1 446 GB; байты на месте у 11 218 (1 236 GB),
  заглушек 5 262 (210 GB), из них 2 378 (107 GB) — в закреплённых папках; обход — 2,3 с. Все
  11 218 файлов с байтами видны в `/mnt/ydisk` с тем же размером.

## Перезагрузки, питание, память

- Windows Update: установка ежедневно в 04:00, перезагрузка через 15 мин после установки,
  активные часы 06–23 (с 29.10). Первое обновление по новому окну — проверить около 11.11.
- ВМ стартует с Windows сама, без входа (задержка 30 с); при выключении ПК гость
  выключается штатно; авточекпоинтов нет. Плановый тест перезагрузки пройден 29.10.
- Fast Startup выключен: гибернации нет (`powercfg /a`), `HiberbootEnabled` = 0 (было 1,
  исправлено 30.10). BIOS `Restore on AC power loss = Power On` удалённо не проверить —
  смотрит владелец на самом ПК.
- Память ВМ статическая: 12 GB сейчас (`ENCODE_JOBS=1`); перед первым настоящим
  кодированием — 22 GB и `ENCODE_JOBS=2`: `Stop-VM contentops; Set-VMMemory contentops
  -StartupBytes 22GB; Start-VM contentops` (у Windows останется ≈ 1.6 GB). Динамическая
  память не годится: добавляет ≈ 1 GB за 10+ с, рывок кодера убивает OOM (проверено 29.10).
- Swap в ВМ — `/swapfile` 8 GiB на системном диске (SPEC §12.2): рывок памяти замедляет
  кодер, а не убивает его. Ставит `ops/vm/setup-disks.sh` (строка в `/etc/fstab`, переживает
  перезагрузку); место выделено `fallocate` без записи, `os.vhdx` растёт, только когда
  страницы реально уходят в swap; на работающей ВМ включается без перезапуска (`swapon`).
  Включён 30.10 так (`setup-disks.sh -- swap`): активен, `swapfile.swap` в `swap.target`.
- WSL — только разработка: потолок `.wslconfig` 2 GB, 4 CPU, swap 4 GB; сборки и тесты — на
  Mac и в CI. Keep-alive WSL пилоту не нужен.
- Клиент Я.Диска: автозапуск убран (29.10, значение —
  `C:\Users\dmsrg\yandex-autostart-backup-2026-10-29.txt`), служба `YandexDiskUpdateService`
  — Manual. Обновление 13.10 вернуло автозапуск: после любого обновления клиента проверить
  `HKCU\…\Run` и тип службы. Клиент запускается только на сеанс, одобренный владельцем.

## Сторож `ContentOps-Watchdog`

- Задача Windows (SYSTEM, при загрузке и каждые 5 мин) запускает
  `C:\vm\contentops\ops\ContentOps-Watchdog.ps1`; ставит её вместе с `ContentOps-Space` и
  `ContentOps-Compact` `ops/winpc/register-tasks.ps1` (копирует скрипты туда же и печатает
  проверку настроек хоста): `scp ops/winpc/*.ps1 winpc:C:/vm/contentops/ops/`, затем
  `ssh winpc 'pwsh -NoProfile -File C:\vm\contentops\ops\register-tasks.ps1 -Enable'`.
- Выключенную ВМ (`Off`) включает на каждой проверке, пока не включится, без счётчика
  неудач и без «раз в час». Неудачный старт — одна строка журнала с причиной и памятью хоста:
  `start failed: … Not enough memory in the system to start the virtual machine …; VM Off;
  host memory 1.1 GB available, 0.0 GB modified`. Не включает, пока Windows сама
  выключается (событие 1074 после загрузки, за последние 30 мин).
- Работающую проверяет по `http://contentops.tail1d911a.ts.net/healthz` (после включения
  HTTPS — адрес `-HealthUrl` при регистрации). После трёх неудач подряд — штатное выключение
  гостя (через 3 мин — принудительное) и старт; не чаще раза в час и не раньше часа после
  того, как сторож включил выключенную ВМ: свежую загрузку не обрывает. Пауза, сохранённое
  или «критическое» состояние (например, кончилось место на C:) — только запись в журнал.
  Пока на самом ПК не работает Tailscale, неудачи не считаются: перезапуск ВМ не помог бы, а
  долгое кодирование оборвал бы.
- Полный диск: пока на C: или E: свободно меньше 50 GB (или диска нет), сторож ВМ не
  включает и не перезапускает, в журнале — `start skipped: C: 42.1 GB free (below 50 GB)`
  (у работающей — `restart skipped: …`).
  Hyper-V при полном C: или E: ставит ВМ на «критическую» паузу; по умолчанию через 30 мин
  выключает её, а сторож включил бы снова — круг жёстких выключений базы без бэкапа. Поэтому
  пауза держится сутки (`AutomaticCriticalErrorActionTimeout` 1440 мин — предел Hyper-V: 1441
  и больше он отвергает с `0x80041008`; на работающей ВМ меняется; ставит
  `register-tasks.ps1`, проверка — `Get-VM contentops | fl AutomaticCriticalError*`). Не
  освободили место за сутки — ВМ выключится один раз, и сторож её не включит.
  Освободив место, ВМ продолжают `Resume-VM contentops`.
- Журнал — `C:\vm\contentops\logs\watchdog.log`, счётчик и время последнего старта —
  `watchdog-state.json` рядом.
- Включает выкатка (`register-tasks.ps1 -Enable`; без `-Enable` задача регистрируется
  выключенной). На время работ с ВМ руками — `Disable-ScheduledTask ContentOps-Watchdog`,
  иначе он включит выключенную ВМ на ближайшей проверке (до 5 мин); сжатие выключает и
  включает его само. Без диска E: `/healthz` красный, и перезапуск ВМ не поможет: на это
  время сторожа выключить.
- Решение проверки — функция `Get-WatchdogDecision` без побочных действий. Подключённый через
  `. .\ContentOps-Watchdog.ps1 -LogDir <временная папка>` скрипт только объявляет функции:
  так решение прогоняется на подставных состояниях, не трогая ВМ (06.11.2026: выключенная ВМ
  включается на каждой проверке, «раз в час» — только для перезапуска работающей).
- Проверено 30.10: запуск от SYSTEM (имя в tailnet находится, неудача засчитана), штатный
  перезапуск — гость выключился за 6 с, диски смонтировались сами. Порог места: сторож под
  Windows PowerShell 5.1 с `-MinFreeGB 100000` записал `restart skipped: C: 532.5 GB free, E:
  350.9 GB free (below 100000 GB)`, ВМ осталась Running.

## Проверки стека (этап 6)

- **Smoke** — `ops/smoke.sh` в `/opt/contentops`, ≈ 10–20 с. Снаружи: `/healthz` на loopback и
  по адресу tailnet, все шесть служб. Затем набор в контейнере образа, через nginx: чтение
  каждого раздела всех моделей (библиотека, сводка страниц, поиск, карточка, миниатюра,
  журнал, план, заказы, промо, «Сверить», «Приехало», разбор старого, состояние, счётчики,
  интеграции Hub, Я.Диск, Dropbox) и одно скачивание небольшого файла с квитанцией. Запись —
  только в модель `smoke` «Проверки»: две крошечные PNG (градиент, без людей) через tus →
  приёмка SET и CUS → заказ создан, сдан этим CUS и закрыт (повтор с тем же ключом
  идемпотентности отдаёт тот же ответ) → две строки плана, отметка и отмена → подборка
  промо, ZIP передачи «Проверочному подрядчику», «передано». Каждый прогон — новые строки,
  ничего не удаляется. Таблица `ok / warn / skip / FAIL`, выход 0/1; `--reads-only` — без
  записи. Внешние модели и ИИ не нужны.
- Один раз перед первым прогоном: `ops/smoke.sh --setup --token`. Это модель `smoke` обычным
  bootstrap (две вымышленные страницы Fansly без Hub, канал промо, без источников, счётчики
  без легаси), «Проверочный подрядчик», агент «Смоук-проверки» (роль КМ, все модели) и его
  токен — один раз в stdout, прежние токены этого агента отзываются. Токен — в `.env`
  строкой `SMOKE_TOKEN=`. Повтор без `--token` ничего не меняет, только добавляет агенту
  новые модели. Агенты работают, пока владелец держит включёнными «Агенты» (Настройки ›
  Интеграции); иначе прогон падает на «agent token». Модель `smoke` видна владельцу в списке
  моделей, КМ — нет.
- **Восстановление** — `ops/smoke-recovery.sh`, только по требованию: каждая проверка ломает
  стек на минуту-две. В ВМ годятся `worker` (SIGKILL воркера посреди `verify-blobs`: одна
  строка блобов держится блокировкой, работа ждёт на ней; после убийства новый воркер ждёт
  конца аренды 60 с, забирает работу со следующим поколением и доводит; одна строка, каждый
  блоб посчитан раз), `db` (`docker compose stop db`, затем `start db`: `/healthz` красный,
  потом зелёный, web и воркеры переподключаются сами, smoke проходит, ничего не потеряно) и
  `restart` (весь стек `stop` + `ops/up.sh`: одна строка на поток и интервал, без дублей,
  работ с мёртвой арендой нет, smoke-чтение проходит). Только локально, с `--local`: `offline` (Hub и
  Я.Диск на закрытом порту → интеграции «недоступен», smoke с записью проходит) и `mounts`
  (развилка `ops/up.sh` без диска: воркеры стоят, `/healthz` 503 `volumes`, после возврата
  диска — зелёный). С `--local` скрипт отказывается там, где в `.env` задан
  `REQUIRE_HOST_MOUNTS`, — это ВМ.
- Локальный стек на Mac — тот же `docker-compose.yml` и `ops/up.sh` со своим `.env`:
  `COMPOSE_PROJECT_NAME`, свои `PROXY_PORT` и `STACK_SUBNET`, папки во временном каталоге,
  пустой `REQUIRE_HOST_MOUNTS`, `MOUNT_PROPAGATION=rprivate` (в Docker Desktop нет rslave),
  `VIDEO_CPUS`/`IMAGE_CPUS` не больше ядер Docker. Docker Desktop (virtiofs) ломает жёсткие
  ссылки: блоб веб-загрузки отвечает `ESTALE` во всех контейнерах, поэтому `/srv/content`
  локально — том Docker через второй файл compose в `COMPOSE_FILE` (метку
  `.contentops-volume` в нём ставят один раз руками).

## После перезагрузки

- Windows: `ssh winpc 'pwsh -NoProfile -Command -' < ops/winpc/after-reboot-check.ps1` — время
  и причина загрузки (события 1074 / 6008 / 41, ночное окно 00–06), установки Windows Update
  и ждущая перезагрузка, ВМ Running и её heartbeat, задачи `ContentOps-Watchdog`,
  `ContentOps-Space` и `ContentOps-Compact` (включены, отработали после загрузки, код 0, хвост
  журнала сторожа),
  Tailscale на ПК, `/healthz` по tailnet, клиент Я.Диска не запущен, автозапуска в `Run` нет,
  `YandexDiskUpdateService` — Manual, свободно на C: и E:.
- ВМ: `ssh contentops-vm 'cd /opt/contentops && ops/vm/after-reboot-check.sh'` — загрузка и
  чистое выключение перед ней, шесть монтирований, общие папки Windows (`/mnt/host` со свежим
  `space.json`, `/mnt/ydisk` смонтирована — файлы копии не читаются), Docker и все службы,
  `/healthz` на loopback и по tailnet, `tailscale serve`, работы, взятые воркерами после
  загрузки, и их последний пульс, работы с мёртвой арендой, очередь, последний опрос Hub и
  скан Я.Диска/Dropbox.
- Оба скрипта только читают (БД — в транзакции только для чтения), выход 1 при FAIL.
  Первая проверка по ночному окну — после обновления около 11.11.
