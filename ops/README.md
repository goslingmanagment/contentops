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
  целиком из нулей; иначе — стоп.

## Место

- Диски растущие: удаление файлов в ВМ не уменьшает файл на Windows. Правда о месте —
  свободное на C: и E: в Windows (SPEC §12.2), не `df` в ВМ.
- VHDX растёт блоками по 32 MB. С настройками ext4 по умолчанию пустой data.vhdx занимал
  17 GB на C:, поэтому метаданные собраны в одну область (`-G 4096`), а inode меньше:
  data — 4M, derived — 4.9M (`df -i`). Сжать файл после большой чистки: в ВМ `sudo fstrim
  -av`, затем на Windows `Stop-VM contentops`, `Optimize-VHD <файл> -Mode Full`,
  `Start-VM contentops`.
- Замер 30.10.2026 после разметки и сжатия: data.vhdx 772 MB, derived.vhdx 612 MB; свободно
  C: 522.9 GB, E: 340.1 GB; в ВМ доступно data 1022 GiB, derived 298 GiB.

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

## Место с Windows

- Задача `ContentOps-Space` (SYSTEM, при загрузке и каждые 5 мин) пишет свободное и полное
  место C: и E: в `C:\vm\contentops\host\space.json`. Папка — общая `contentops-host`, только
  чтение и только для `PC\contentops-ro` (тот же вход, что у `ydisk-ro`; в копию Я.Диска
  ничего не пишется). В ВМ — `/mnt/host` (cifs `ro`, automount, `ops/vm/setup-host-share.sh`),
  в контейнер `web` — `/host` только для чтения.
- Отчёт старше 15 мин на экране — «нет данных». Пороги пилота — предупреждение 200 ГБ,
  остановка забора 100 ГБ (`.env`: `SPACE_WARN_GB`, `SPACE_STOP_GB`). Журнал ошибок задачи —
  `C:\vm\contentops\logs\space.log`.

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
- WSL — только разработка: потолок `.wslconfig` 2 GB, 4 CPU, swap 4 GB; сборки и тесты — на
  Mac и в CI. Keep-alive WSL пилоту не нужен.
- Клиент Я.Диска: автозапуск убран (29.10, значение —
  `C:\Users\dmsrg\yandex-autostart-backup-2026-10-29.txt`), служба `YandexDiskUpdateService`
  — Manual. Обновление 13.10 вернуло автозапуск: после любого обновления клиента проверить
  `HKCU\…\Run` и тип службы. Клиент запускается только на сеанс, одобренный владельцем.

## Сторож `ContentOps-Watchdog`

- Задача Windows (SYSTEM, при загрузке и каждые 5 мин) запускает
  `C:\vm\contentops\ops\ContentOps-Watchdog.ps1`; ставит её вместе с `ContentOps-Space`
  `ops/winpc/register-tasks.ps1` (копирует скрипты туда же и печатает проверку настроек
  хоста): `scp ops/winpc/*.ps1 winpc:C:/vm/contentops/ops/`, затем
  `ssh winpc 'pwsh -NoProfile -File C:\vm\contentops\ops\register-tasks.ps1 -Enable'`.
- Проверяет `http://contentops.tail1d911a.ts.net/healthz` (после включения HTTPS — адрес
  `-HealthUrl` при регистрации). После трёх неудач подряд —
  штатное выключение гостя (через 3 мин — принудительное) и старт, не чаще раза в час;
  выключенную ВМ включает. Пауза, сохранённое или «критическое» состояние (например,
  кончилось место на C:) — только запись в журнал. Пока на самом ПК не работает Tailscale,
  неудачи не считаются: перезапуск ВМ не помог бы, а долгое кодирование оборвал бы.
- Журнал — `C:\vm\contentops\logs\watchdog.log`, счётчик — `watchdog-state.json` рядом.
- Включает выкатка (`register-tasks.ps1 -Enable`; без `-Enable` задача регистрируется
  выключенной). На время работ с ВМ руками — `Disable-ScheduledTask ContentOps-Watchdog`,
  иначе он включит выключенную ВМ. Без диска E: `/healthz` красный, и перезапуск ВМ не
  поможет: на это время сторожа выключить.
- Проверено 30.10: запуск от SYSTEM (имя в tailnet находится, неудача засчитана), штатный
  перезапуск — гость выключился за 6 с, диски смонтировались сами.
