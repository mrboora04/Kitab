#!/usr/bin/env python3
"""Writes update.json for the APK in dist/: the version from AndroidManifest.xml, its SHA-256, and a line of notes.
Installed copies of Kitab read this file to offer the Update button.  Usage: write_update.py "What's new"."""
import hashlib, json, re, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
manifest = (root / 'AndroidManifest.xml').read_text(encoding='utf8')
code = int(re.search(r'android:versionCode="(\d+)"', manifest).group(1))
name = re.search(r'android:versionName="([^"]+)"', manifest).group(1)
apk = (root / 'dist' / 'Kitab.apk').read_bytes()
notes = (sys.argv[1] if len(sys.argv) > 1 else '').strip()
notes = re.sub(r'^Kitab [\d.]+:\s*', '', notes)[:200] or f'Kitab {name}'
notes = notes[:1].upper() + notes[1:]
out = {
    'versionCode': code, 'versionName': name, 'notes': notes,
    'apk': 'https://raw.githubusercontent.com/mrboora04/Kitab/main/dist/Kitab.apk',
    'sha256': hashlib.sha256(apk).hexdigest(),
}
(root / 'update.json').write_text(json.dumps(out, indent=2) + '\n', encoding='utf8')
print(f'update.json: Kitab {name} ({code}) {out["sha256"][:12]}…')
