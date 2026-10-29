#!/bin/bash
# Пакетное сжатие видеоархива в AV1. Оригиналы НЕ удаляются.
# Использование: ./compress-library.sh SRC_DIR DST_DIR [CRF] [JOBS]
# Профиль мастера — SPEC §9.2 (решение владельца 07.09.2026 по бенчмарку v2.1,
# docs/reference/compression.md §10.4–10.6): один CRF для всего, что жмётся.
set -uo pipefail

SRC_DIR="${1:?укажи папку с оригиналами}"
DST_DIR="${2:?укажи папку для результата}"
CRF="${3:-24}"        # CRF 24 — правило; другое значение только для проб
SVT_PARAMS="${SVT_PARAMS:-tune=1:lp=4:enable-qm=1:qm-min=0:qm-max=15}"  # переменная окружения — только для замеров lp
JOBS="${4:-2}"        # 2 задачи — дефолт дневного прогона (compression.md §10.1 п. 5)

SRC_DIR="$(cd "$SRC_DIR" && pwd)" || exit 2
mkdir -p "$DST_DIR" && DST_DIR="$(cd "$DST_DIR" && pwd)" || exit 2
case "$DST_DIR/" in "$SRC_DIR"/*) echo "ОШИБКА: папка результата внутри папки источника"; exit 2;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$DST_DIR/_manifest.tsv"
FAILED="$DST_DIR/_failed.txt"
MIN_MBPS=8            # ниже этого не жмём: уже сжато, выигрыш мал, потеря реальна
# Первые 11 столбцов сохраняются; старые записи без хэшей не дают права на пропуск.
python3 - "$MANIFEST" <<'PY' || exit 2
import os, sys
p = sys.argv[1]
old = 'file\tsrc_bytes\tdst_bytes\tratio\tsrc_frames\tdst_frames\taudio\tcrf\tenc_s\tverify_s\tstatus'
header = old + '\tsrc_sha256\tdst_sha256\tprofile_sha256'
if not os.path.exists(p):
    with open(p, 'w') as f: f.write(header + '\n')
else:
    with open(p) as f:
        actual = f.readline().rstrip('\n')
        if actual == header: sys.exit()
        if actual != old: sys.exit('Неизвестный формат журнала: ' + p)
        with open(p + '.partial', 'w') as out:
            out.write(header + '\n')
            for line in f: out.write(line.rstrip('\n') + '\t\t\t\n')
    os.replace(p + '.partial', p)
PY
: > "$FAILED"

# одинаково на macOS и Linux
fsize(){ python3 -c 'import os,sys;print(os.stat(sys.argv[1]).st_size)' "$1"; }
fmtime(){ python3 -c 'import os,sys,datetime;print(datetime.datetime.fromtimestamp(os.stat(sys.argv[1]).st_mtime,datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"; }
now(){ date +%s; }
file_hash(){ shasum -a 256 < "$1" | cut -d' ' -f1; }
skip_row(){ printf '%s\t%s\t\t\t\t\t\t\t\t\t%s\t\t\t\n' "$1" "$2" "$3" >> "$MANIFEST"; }

# Один крошечный кадр сообщает версию реально загруженной библиотеки SVT,
# которой нет в ffmpeg -version при динамической сборке.
svt_info=$(ffmpeg -nostdin -hide_banner -f lavfi -i 'color=s=64x64:r=1' \
  -frames:v 1 -c:v libsvtav1 -preset 6 -svtav1-params lp=1 \
  -pix_fmt yuv420p10le -f null - 2>&1) || { echo "$svt_info" >&2; exit 2; }
svt_version=$(printf '%s\n' "$svt_info" | grep -F 'SVT [version]')
[ -n "$svt_version" ] || { echo 'Не удалось определить версию SVT-AV1' >&2; exit 2; }
ffmpeg_version=$(ffmpeg -version) && ffprobe_version=$(ffprobe -version) || exit 2
script_sha=$(file_hash "$SCRIPT_DIR/compress-library.sh") && ts_sha=$(file_hash "$SCRIPT_DIR/ts_drift.py") || exit 2
PROFILE_SHA256=$(printf '%s\n' "$CRF" "$SVT_PARAMS" "$ffmpeg_version" "$ffprobe_version" \
  "$svt_version" "$script_sha" "$ts_sha" | shasum -a 256 | cut -d' ' -f1) || exit 2

n_audio(){ ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$1" 2>/dev/null | wc -l | tr -d ' '; }
# MP4 не умеет часть кодеков (напр. apple_apac — пространственный звук айфона),
# а декодера для них в ffmpeg нет, поэтому такие дорожки только выбрасывать
audio_maps(){ local i=0 m="" drop=""
  for c in $(ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "$1" 2>/dev/null); do
    case "$c" in aac|ac3|eac3|alac|mp3|opus|flac|pcm_s16le|pcm_s24le) m="$m -map 0:a:$i";; *) drop="$drop$c ";; esac
    i=$((i+1))
  done
  printf '%s|%s' "$m" "$drop"; }
# В CSV ffprobe дописывает Dolby Vision / Display Matrix к значению поля:
# строка «arib-std-b67,...» не равна HDR-маркеру. Читаем поле по имени из JSON.
probe(){ ffprobe -v error -select_streams v:0 -show_entries "$1" -of json "$2" 2>/dev/null | \
  python3 -c 'import json,sys; s=json.load(sys.stdin).get("streams",[]); print(s[0].get(sys.argv[1],"") if s else "")' "${1#stream=}"; }
# полный декод результата: время каждого кадра (их число — число кадров)
frame_pts(){ ffprobe -v error -select_streams v:0 -show_entries frame=pts_time -of csv=p=0 "$1" | cut -d, -f1; }
# звук копируется без перекодирования, поэтому сверяем сами пакеты AAC (бит в бит), а не
# декодированный PCM: у части источников (Sony, 07.09.2026) MOV подрезает 2112 сэмплов
# приминга через edit list, а MP4 после копии — нет; PCM тогда «различается» на 44 мс
# тишины в начале при том же звуке и той же синхронности. Второй аргумент — индексы дорожек
# через пробел (у источника — только те, что попали в результат); без него — все дорожки.
audio_hash(){ local out="" i idx; idx="${2:-}"
  if [ -z "$idx" ]; then local n; n=$(n_audio "$1"); idx=$(seq 0 $((${n:-0}-1)) 2>/dev/null | tr '\n' ' '); fi
  for i in $idx; do
    out="$out$(ffmpeg -nostdin -v error -i "$1" -map 0:a:$i -c copy -f md5 - 2>/dev/null)"
  done
  printf '%s' "$out" | shasum -a 256 | cut -d' ' -f1; }
# смещение звука относительно видео, в секундах: первый пакет звука минус первый показанный кадр видео.
# Видео — по кадрам, не по пакетам: у H.264 с B-кадрами первый пакет в порядке декодирования — кадр
# до начала edit list с отрицательным pts (24fyp.mov, 08.09.2026), у AV1-результата пакеты идут в
# порядке показа; по пакетам выходил ложный «сдвиг» 50 мс. Звук — по пакетам, не по кадрам: у Sony
# декодер источника срезает 2112 сэмплов приминга (44 мс) по edit list, в MP4-копии они остаются
# в дорожке, содержимое при этом на своём месте (PMR00573); по кадрам выходил бы ложный сдвиг 44 мс.
# 64 пакета — чтобы декодер успел выдать первый кадр после переупорядочивания.
av_offset(){ python3 -c '
import subprocess,sys
def st(f,sel,ent):
    r=subprocess.run(["ffprobe","-v","error","-select_streams",sel,"-show_entries",ent+"=pts_time","-of","csv=p=0","-read_intervals","%+#64",f],capture_output=True,text=True)
    v=[x.split(",")[0] for x in r.stdout.split() if x.strip() and x.split(",")[0] not in ("","N/A")]
    return float(v[0]) if v else None
v,a=st(sys.argv[1],"v:0","frame"),st(sys.argv[1],"a:0","packet")
print("" if v is None or a is None else "%.6f"%(a-v))' "$1" 2>/dev/null; }
ts_drift(){ python3 "$SCRIPT_DIR/ts_drift.py" "$1" "$2" 2>/dev/null || echo -1; }
# кадры источника считает и датирует сам проход кодирования (showinfo) — второй декод источника не нужен
src_pts_from_log(){ grep -o 'pts_time:[-0-9.]*' "$1" | cut -d: -f2; }

# ---- один файл ----
process() (
  local rel="$1" src dst ext stem
  src="$SRC_DIR/$rel"; ext="${rel##*.}"; stem="${rel%.*}"
  # столкновение имён: video.mov и video.mp4 дали бы один video.mp4
  if [ "$(find "$SRC_DIR" -maxdepth 20 -path "$SRC_DIR/$stem.*" -type f | wc -l | tr -d ' ')" -gt 1 ]; then
    dst="$DST_DIR/$stem.$ext.mp4"
  else
    dst="$DST_DIR/$stem.mp4"
  fi

  local sb src_sha rec rec_st rec_db rec_sha
  sb=$(fsize "$src") && src_sha=$(file_hash "$src") || return 1
  # Только последняя запись для файла, с теми же байтами и тем же конвейером.
  rec=$(awk -F'\t' -v f="$rel" -v s="$src_sha" -v p="$PROFILE_SHA256" '
    $1==f {last=$0}
    END {split(last,a,"\t"); if(a[12]==s && a[14]==p) print a[11],a[3],a[13]}' "$MANIFEST")
  read -r rec_st rec_db rec_sha <<< "$rec"
  if [ "$rec_st" = bigger_than_source ]; then
    echo "  = пропуск (мастер — источник): $rel"; return 0
  fi
  if [ "$rec_st" = ok ] && [ -s "$dst" ] && [ "$(fsize "$dst")" = "$rec_db" ] && \
      [ "$(file_hash "$dst")" = "$rec_sha" ]; then
    echo "  = пропуск (готов, хэши совпали): $rel"; return 0
  fi

  # HDR и уже-AV1 не трогаем
  local trc codec dur mbps
  trc=$(probe stream=color_transfer "$src"); codec=$(probe stream=codec_name "$src")
  case "$trc" in smpte2084|arib-std-b67)
      echo "  ! HDR, пропускаю: $rel"; skip_row "$rel" "$sb" skipped_hdr; return 0;; esac
  [ "$codec" = "av1" ] && { echo "  ! уже AV1: $rel"; skip_row "$rel" "$sb" skipped_av1; return 0; }
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src" 2>/dev/null)
  if [ -z "$codec" ] || [ -z "$dur" ]; then
    echo "  ! НЕ ЧИТАЕТСЯ: $rel"
    skip_row "$rel" "$sb" unreadable
    echo "$rel (unreadable)" >> "$FAILED"; return 1
  fi
  mbps=$(echo "$sb $dur" | awk '{if($2>0) printf "%.3f", $1*8/$2/1e6; else print 0}')   # порог сравниваем без округления: 7.95 — это ниже 8
  if [ "$(echo "$mbps $MIN_MBPS" | awk '{print ($1<$2)?1:0}')" = "1" ]; then
    echo "  ! низкий битрейт ${mbps} Мбит/с, пропускаю: $rel"
    skip_row "$rel" "$sb" skipped_lowrate; return 0
  fi

  local crf="$CRF"
  mkdir -p "$(dirname "$dst")"
  echo "  → $rel  ($(printf '%.1f' "$mbps") Мбит/с → CRF $crf)"
  local ct; ct=$(ffprobe -v error -show_entries format_tags=creation_time -of csv=p=0 "$src" 2>/dev/null)
  ct=$(python3 -c "
import sys,datetime
s=sys.argv[1].strip()
if not s: print(''); raise SystemExit
for f in ('%Y-%m-%dT%H:%M:%S.%fZ','%Y-%m-%dT%H:%M:%SZ','%Y-%m-%dT%I:%M:%S %pZ','%Y-%m-%d %H:%M:%S'):
    try: print(datetime.datetime.strptime(s,f).strftime('%Y-%m-%dT%H:%M:%SZ')); raise SystemExit
    except ValueError: pass
print('')" "$ct" 2>/dev/null)
  [ -z "$ct" ] && ct=$(fmtime "$src")
  local am dropped; am=$(audio_maps "$src"); dropped="${am#*|}"; am="${am%%|*}"
  [ -n "$dropped" ] && echo "    ! выброшены аудиодорожки: $dropped(MP4 их не поддерживает)"
  local t0 t1 t2 tmp partial; t0=$(now)
  tmp=$(mktemp -d "$(dirname "$dst")/.compress.XXXXXX") || return 1
  partial="$tmp/output.mp4"
  trap 'rm -f "$tmp"/*; rmdir "$tmp"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  nice -n 10 ffmpeg -nostdin -hide_banner -nostats -loglevel level+info -y -i "$src" \
    -map 0:v:0 $am -c:a copy -map_metadata 0 -fps_mode passthrough \
    -enc_time_base:v 1/1000000 -filter:v showinfo \
    -c:v libsvtav1 -preset 6 -crf "$crf" -pix_fmt yuv420p10le -g 300 \
    -svtav1-params "$SVT_PARAMS" \
    -metadata creation_time="$ct" \
    -video_track_timescale 600000 -movflags +faststart "$partial" 2>"$tmp/enc.log"
  local rc=$?; t1=$(now)
  src_pts_from_log "$tmp/enc.log" > "$tmp/src.pts"
  # в журнал — только предупреждения и ошибки декодера/энкодера; ошибки декодирования источника = мастер не принимается
  grep -E '\[(warning|error|fatal|panic)\]' "$tmp/enc.log" | grep -v Parsed_showinfo | sed "s|^|$rel: |" >> "$DST_DIR/_ffmpeg.log"
  local nerr; nerr=$(grep -c -E '\[(error|fatal|panic)\]' "$tmp/enc.log")
  if [ $rc -ne 0 ] || [ ! -s "$partial" ]; then
    skip_row "$rel" "$sb" encode_failed
    echo "$rel (encode_failed)" >> "$FAILED"; return 1
  fi
  touch -r "$src" "$partial" || return 1          # сохранить дату файла

  local db sf df cf ah_s ah_d aud st bts src_idx decode_rc=0 dst_sha=""
  frame_pts "$partial" > "$tmp/dst.pts" 2> "$tmp/verify.log" || decode_rc=$?
  sed "s|^|$rel: |" "$tmp/verify.log" >> "$DST_DIR/_ffmpeg.log"
  db=$(fsize "$partial"); sf=$(wc -l < "$tmp/src.pts" | tr -d ' '); df=$(wc -l < "$tmp/dst.pts" | tr -d ' ')
  cf=$(probe stream=nb_frames "$src" | tr -cd '0-9')   # сколько кадров обещает контейнер источника
  src_idx=$(printf '%s' "$am" | grep -o '0:a:[0-9]*' | sed 's/0:a://' | tr '\n' ' ')
  ah_s=$(audio_hash "$src" "$src_idx"); ah_d=$(audio_hash "$partial")
  if [ -z "$src_idx" ]; then aud="нет"; elif [ "$ah_s" = "$ah_d" ]; then aud="ok"; else aud="РАЗЛИЧАЕТСЯ"; fi
  if [ "$aud" = ok ]; then   # звук тот же — проверяем, что он не уехал относительно видео
    # допуск 2 мс: пустой edit звука muxer пишет в шкале фильма (1000/с), т.е. с округлением до ±0,5 мс
    local o_s o_d; o_s=$(av_offset "$src"); o_d=$(av_offset "$partial")
    if [ -n "$o_s" ] && [ -n "$o_d" ] && [ "$(echo "$o_s $o_d" | awk '{d=$1-$2; if(d<0)d=-d; print (d>0.002)?1:0}')" = 1 ]; then aud="СДВИГ"; fi
  fi
  bts=$(ts_drift "$tmp/src.pts" "$tmp/dst.pts")
  local na_s na_d; na_s=$(printf '%s' "$am" | grep -o '0:a:' | wc -l | tr -d ' '); na_d=$(n_audio "$partial")
  t2=$(now)
  st=ok
  [ "$db" -ge "$sb" ] && st=bigger_than_source
  [ "$sf" = "$df" ] || st=frame_mismatch
  [ "$na_s" = "$na_d" ] || st=audio_tracks_lost
  [ "$bts" -gt 0 ] && st=timing_drift
  [ "$bts" -lt 0 ] && st=timing_uncomparable
  [ "$aud" = "РАЗЛИЧАЕТСЯ" ] && st=audio_mismatch
  [ "$aud" = "СДВИГ" ] && st=audio_offset
  # источник декодировался с ошибками или короче, чем обещает контейнер (обрезан): мастер из него не принимаем
  [ "${nerr:-0}" -gt 0 ] && st=source_decode_errors
  if [ -n "$cf" ] && [ "$cf" -gt 0 ] && [ "$(echo "$sf $cf" | awk '{print ($1 < 0.95*$2)?1:0}')" = 1 ]; then st=source_truncated; fi
  if [ "$decode_rc" -ne 0 ] || [ -s "$tmp/verify.log" ]; then st=result_decode_errors; fi
  if [ "$st" = ok ]; then
    dst_sha=$(file_hash "$partial") && mv -f "$partial" "$dst" || st=publish_failed
  fi
  printf '%s\t%s\t%s\t%.3f\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$rel" "$sb" "$db" \
    "$(echo "$db $sb" | awk '{printf "%.3f",$1/$2}')" "$sf" "$df" "$aud" "$crf" "$((t1-t0))" "$((t2-t1))" "$st" \
    "$src_sha" "$dst_sha" "$PROFILE_SHA256" >> "$MANIFEST" || return 1
  if [ "$st" = ok ]; then
    echo "$sb $db $((t1-t0)) $((t2-t1))" | awk '{printf "    ok  %.0f→%.0f МБ (−%.0f%%), кодирование %d с, проверка %d с\n", $1/1048576, $2/1048576, 100-100*$2/$1, $3, $4}'
  elif [ "$st" = bigger_than_source ]; then
    echo "    мастер — источник, сжатая копия не уменьшила размер: $rel"
  else
    echo "    ПРОВЕРКА НЕ ПРОШЛА: $st — оригинал НЕ удалять"; echo "$rel ($st)" >> "$FAILED"; return 1
  fi
)
export -f process probe frame_pts audio_hash av_offset n_audio audio_maps ts_drift src_pts_from_log fsize fmtime now skip_row file_hash
export SRC_DIR DST_DIR CRF SVT_PARAMS MANIFEST FAILED MIN_MBPS SCRIPT_DIR PROFILE_SHA256

if [ "$CRF" = 24 ]; then echo "CRF 24, $SVT_PARAMS, параллельно $JOBS файлов"; else echo "CRF $CRF (задан вручную, правило — 24), $SVT_PARAMS, параллельно $JOBS файлов"; fi
(cd "$SRC_DIR" && find . -type f \( -iname '*.mov' -o -iname '*.mp4' -o -iname '*.m4v' \) -print0) \
  | xargs -0 -P "$JOBS" -I{} bash -uo pipefail -c 'process "${1#./}"' _ {}
batch_rc=$?

read -r ok sk kept saved < <(awk -F'\t' '
  NR>1 {last[$1]=$0}
  END {for(f in last) {split(last[f],a,"\t"); if(a[11]=="ok") {ok++; saved+=a[2]-a[3]}
    if(a[11] ~ /^skipped/) sk++; if(a[11]=="bigger_than_source") kept++}
    printf "%d %d %d %.2f\n",ok,sk,kept,saved/1073741824}' "$MANIFEST")
echo; echo "сжато: $ok | пропущено по правилам: $sk | мастер — источник: $kept | проблемных: $(wc -l < "$FAILED" | tr -d ' ')"
echo "сэкономлено: $saved ГБ"; echo "отчёт: $MANIFEST"
if [ -s "$FAILED" ]; then echo "ПРОБЛЕМНЫЕ (оригиналы не трогать): $FAILED"; exit 1; fi
[ "$batch_rc" -eq 0 ] || exit 1
exit 0
