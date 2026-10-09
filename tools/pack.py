"""Membuat ZIP ekstensi siap dipasang/dibagikan: manifest.json di akar zip, tanpa node_modules/tests/.git.
Jalankan dari folder proyek:  python tools/pack.py   ->  dist/ai-form-fill-lokal-<versi>.zip
"""
import json
import os
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
INCLUDE = ['manifest.json', 'background.js', 'lib', 'content', 'popup', 'options', 'icons']

with open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as f:
    version = json.load(f)['version']

os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)
out = os.path.join(ROOT, 'dist', 'ai-form-fill-lokal-%s.zip' % version)
if os.path.exists(out):
    os.remove(out)

count = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for item in INCLUDE:
        path = os.path.join(ROOT, item)
        if os.path.isfile(path):
            z.write(path, item)
            count += 1
            continue
        for base, _, files in os.walk(path):
            for name in files:
                full = os.path.join(base, name)
                z.write(full, os.path.relpath(full, ROOT).replace(os.sep, '/'))
                count += 1

print('Dibuat:', out, '(%d berkas, %.1f KB)' % (count, os.path.getsize(out) / 1024))
