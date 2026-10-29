#!/usr/bin/env python3
"""Короткие проверки сохранности файлов: python3 tools/test_compress_library.py.

Нужны FFmpeg с libsvtav1/libx264 и ffprobe. Медиа создаются во временной папке.
Это проверки конвейера, не замер качества или скорости сжатия.
"""
import csv
import hashlib
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('compress-library.sh').resolve()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class CompressionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shared = tempfile.TemporaryDirectory(prefix='contentops-compression-tests-')
        cls.addClassCleanup(cls.shared.cleanup)
        root = Path(cls.shared.name)
        cls.ffmpeg = shutil.which('ffmpeg')
        cls.ffprobe = shutil.which('ffprobe')
        if not cls.ffmpeg or not cls.ffprobe:
            raise RuntimeError('Нужны ffmpeg и ffprobe')
        cls.base = root / 'source.mov'
        subprocess.run([
            cls.ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
            'testsrc2=s=320x180:r=120:d=1', '-f', 'lavfi', '-i',
            'sine=frequency=997:sample_rate=48000:duration=1',
            '-map', '0:v', '-map', '1:a', '-map', '1:a',
            '-vf', "select='if(lt(n,60),1,not(mod(n,2)))'", '-fps_mode', 'passthrough',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac',
            '-metadata', 'creation_time=2024-01-02T03:04:05Z', str(cls.base),
        ], check=True)
        # Пустой атом MOV поднимает размер выше порога 8 Мбит/с без тяжёлого 4K.
        with cls.base.open('ab') as f:
            f.write(struct.pack('>I4s', 2_000_008, b'free') + bytes(2_000_000))
        cls.bin = root / 'bin'
        cls.bin.mkdir()
        wrapper = '''#!/usr/bin/env python3
import os, pathlib, signal, struct, subprocess, sys
real = REAL_TOOLS[pathlib.Path(sys.argv[0]).name]
args = sys.argv[1:]
fault = os.environ.get('CONTENTOPS_TEST_FAULT')
encode = '-filter:v' in args and 'showinfo' in args
if encode and fault in ('encode', 'interrupt'):
    pathlib.Path(args[-1]).write_bytes(b'unfinished output')
    if fault == 'interrupt': os.kill(os.getppid(), signal.SIGTERM)
    sys.exit(1)
r = subprocess.run([real, *args], capture_output=True)
sys.stdout.buffer.write(r.stdout)
sys.stderr.buffer.write(r.stderr)
if '-version' in args and os.environ.get('CONTENTOPS_TEST_VERSION'):
    print('test build ' + os.environ['CONTENTOPS_TEST_VERSION'])
if encode and r.returncode == 0 and fault == 'bigger':
    size = pathlib.Path(args[args.index('-i') + 1]).stat().st_size
    with open(args[-1], 'ab') as f:
        f.write(struct.pack('>I4s', size + 8, b'free') + bytes(size))
if fault == 'decode' and 'frame=pts_time' in args and '-read_intervals' not in args:
    print('injected decode error', file=sys.stderr)
sys.exit(r.returncode)
'''.replace('REAL_TOOLS', repr({'ffmpeg': cls.ffmpeg, 'ffprobe': cls.ffprobe}))
        for name in ('ffmpeg', 'ffprobe'):
            p = cls.bin / name
            p.write_text(wrapper)
            p.chmod(0o755)

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix='contentops-compression-case-')
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.src = self.root / 'источники'
        self.dst = self.root / 'результат'
        self.src.mkdir()
        self.source = self.src / 'с пробелами.mov'
        shutil.copy2(self.base, self.source)
        self.output = self.dst / 'с пробелами.mp4'

    def run_batch(self, crf=24, fault='', version='', jobs=1, expected=0):
        env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'],
                   CONTENTOPS_TEST_FAULT=fault, CONTENTOPS_TEST_VERSION=version)
        r = subprocess.run(['bash', str(SCRIPT), str(self.src), str(self.dst),
                            str(crf), str(jobs)], env=env, capture_output=True,
                           text=True, timeout=60)
        self.assertEqual(r.returncode, expected, r.stdout + r.stderr)
        self.assertFalse(list(self.dst.rglob('.compress.*')), 'Не убраны временные файлы')
        with (self.dst / '_manifest.tsv').open() as f:
            self.rows = list(csv.DictReader(f, delimiter='\t'))
        return r

    def test_success_vfr_audio_metadata_and_resume(self):
        source_sha = sha(self.source)
        self.run_batch()
        row = self.rows[-1]
        self.assertEqual(row['status'], 'ok')
        self.assertEqual(row['src_frames'], '90')
        self.assertEqual(row['dst_frames'], '90')
        self.assertEqual(row['audio'], 'ok')
        self.assertEqual(row['src_sha256'], source_sha)
        self.assertEqual(row['dst_sha256'], sha(self.output))
        for path in (self.source, self.output):
            ct = subprocess.check_output([self.ffprobe, '-v', 'error', '-show_entries',
                 'format_tags=creation_time', '-of', 'csv=p=0', str(path)], text=True)
            self.assertEqual(ct.strip(), '2024-01-02T03:04:05.000000Z')
        self.assertEqual(self.source.stat().st_mtime_ns, self.output.stat().st_mtime_ns)
        r = self.run_batch()
        self.assertEqual(len(self.rows), 1)
        self.assertIn('хэши совпали', r.stdout)
        self.assertEqual(sha(self.source), source_sha)

    def test_changed_bytes_profile_and_version_are_reprocessed(self):
        self.run_batch()
        for path in (self.output, self.source):
            old_size = path.stat().st_size
            with path.open('r+b') as f:
                f.seek(-1, 2)
                b = f.read(1)
                f.seek(-1, 2)
                f.write(bytes([b[0] ^ 1]))
            self.assertEqual(path.stat().st_size, old_size)
            before = len(self.rows)
            self.run_batch()
            self.assertEqual(len(self.rows), before + 1)
            self.assertEqual(self.rows[-1]['status'], 'ok')
        profile = self.rows[-1]['profile_sha256']
        r = self.run_batch(crf=26)
        self.assertEqual(len(self.rows), 4)
        self.assertNotEqual(self.rows[-1]['profile_sha256'], profile)
        self.assertEqual(self.rows[-1]['crf'], '26')
        self.assertIn('сжато: 1 |', r.stdout)
        profile = self.rows[-1]['profile_sha256']
        self.run_batch(crf=26, version='changed')
        self.assertEqual(len(self.rows), 5)
        self.assertNotEqual(self.rows[-1]['profile_sha256'], profile)

    def test_legacy_manifest_and_missing_output_are_reprocessed(self):
        self.run_batch()
        manifest = self.dst / '_manifest.tsv'
        lines = manifest.read_text().splitlines()
        manifest.write_text(''.join('\t'.join(line.split('\t')[:11]) + '\n' for line in lines))
        self.run_batch()
        self.assertEqual(len(self.rows), 2)
        self.assertEqual(self.rows[0]['src_sha256'], '')
        self.assertEqual(self.rows[-1]['dst_sha256'], sha(self.output))
        self.output.unlink()
        self.run_batch()
        self.assertEqual(len(self.rows), 3)
        self.assertTrue(self.output.exists())

    def test_failures_preserve_previous_good_output(self):
        self.run_batch()
        good = sha(self.output)
        for fault in ('encode', 'interrupt', 'decode'):
            with self.subTest(fault=fault):
                self.run_batch(crf=26, fault=fault, expected=1)
                self.assertEqual(sha(self.output), good)
        self.assertEqual(self.rows[-1]['status'], 'result_decode_errors')

    def test_failed_first_encode_publishes_nothing(self):
        self.run_batch(fault='encode', expected=1)
        self.assertFalse(self.output.exists())

    def test_bigger_output_keeps_source_and_resumes(self):
        source_sha = sha(self.source)
        self.run_batch(fault='bigger')
        self.assertFalse(self.output.exists())
        self.assertEqual(sha(self.source), source_sha)
        self.assertEqual(self.rows[-1]['status'], 'bigger_than_source')
        self.assertEqual((self.dst / '_failed.txt').read_text(), '')
        self.run_batch()
        self.assertEqual(len(self.rows), 1)

    def test_parallel_name_collision_and_unreadable_input(self):
        shutil.copy2(self.source, self.source.with_suffix('.mp4'))
        (self.src / 'broken.mov').write_bytes(b'not a video')
        self.run_batch(jobs=2, expected=1)
        states = {r['file']: r['status'] for r in self.rows}
        self.assertEqual(states, {'broken.mov': 'unreadable',
                         'с пробелами.mov': 'ok', 'с пробелами.mp4': 'ok'})
        self.assertTrue((self.dst / 'с пробелами.mov.mp4').is_file())
        self.assertTrue((self.dst / 'с пробелами.mp4.mp4').is_file())

    def test_hdr_and_av1_with_side_data_are_skipped(self):
        self.run_batch()
        hdr = self.src / 'hdr.mov'
        av1 = self.src / 'av1.mp4'
        # Display Matrix раньше попадал в CSV рядом с codec_name / color_transfer.
        for source, output, extra in (
            (self.source, hdr, ['-bsf:v',
             'h264_metadata=transfer_characteristics=18:colour_primaries=9:matrix_coefficients=9']),
            (self.output, av1, []),
        ):
            subprocess.run([self.ffmpeg, '-nostdin', '-v', 'error', '-i', str(source),
                            '-map', '0', '-c', 'copy', '-metadata:s:v:0', 'rotate=90',
                            *extra, str(output)], check=True)
        self.run_batch(jobs=2)
        states = {r['file']: r['status'] for r in self.rows}
        self.assertEqual(states['hdr.mov'], 'skipped_hdr')
        self.assertEqual(states['av1.mp4'], 'skipped_av1')
        self.assertFalse((self.dst / 'hdr.mp4').exists())
        self.assertFalse((self.dst / 'av1.mp4').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
