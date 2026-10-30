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

- `sudo tailscale serve --bg --https=443 http://127.0.0.1:8080` в ВМ: HTTPS на
  `https://contentops.tail1d911a.ts.net` → nginx стека (порт 8080 только на loopback).
  `--bg` — настройка переживает перезагрузку; проверка — `tailscale serve status`. Funnel
  (публичный доступ) не включать. До выкатки стека адрес отвечает 502.
- 30.10 ещё не включено: в tailnet выключены HTTPS-сертификаты (`Serve is not enabled on
  your tailnet`). Включает владелец: админка Tailscale → DNS → HTTPS Certificates → Enable
  (имя машины с сертификатом навсегда попадает в публичный журнал сертификатов), затем
  команда выше в ВМ.

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
  `C:\vm\contentops\ops\ContentOps-Watchdog.ps1`; ставит её `ops/winpc/register-tasks.ps1`
  (копирует скрипт туда же и печатает проверку настроек хоста):
  `scp ops/winpc/*.ps1 winpc:C:/vm/contentops/ops/`, затем
  `ssh winpc 'pwsh -NoProfile -File C:\vm\contentops\ops\register-tasks.ps1'`.
- Проверяет `https://contentops.tail1d911a.ts.net/healthz`. После трёх неудач подряд —
  штатное выключение гостя (через 3 мин — принудительное) и старт, не чаще раза в час;
  выключенную ВМ включает. Пауза, сохранённое или «критическое» состояние (например,
  кончилось место на C:) — только запись в журнал. Пока на самом ПК не работает Tailscale,
  неудачи не считаются: перезапуск ВМ не помог бы, а долгое кодирование оборвал бы.
- Журнал — `C:\vm\contentops\logs\watchdog.log`, счётчик — `watchdog-state.json` рядом.
- **Сейчас задача выключена**: приложения ещё нет, и сторож перезапускал бы ВМ раз в час.
  Включает выкатка (`register-tasks.ps1 -Enable`). На время работ с ВМ руками —
  `Disable-ScheduledTask ContentOps-Watchdog`, иначе он включит выключенную ВМ.
- Проверено 30.10: запуск от SYSTEM (имя в tailnet находится, неудача засчитана), штатный
  перезапуск — гость выключился за 6 с, диски смонтировались сами.
