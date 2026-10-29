#!/usr/bin/env python3
"""Tiny stand-in for aapt2, enough for this app.

Compiles AndroidManifest.xml into Android's binary XML format and writes a
resources.arsc that declares a single drawable (the launcher icon), so the APK
can be built with nothing but a JDK.

usage: aapt_lite.py AndroidManifest.xml out_dir
"""
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ANDROID_NS = "http://schemas.android.com/apk/res/android"
PACKAGE_ID = 0x7F

# android.R.attr ids (from the Android 10 framework).
ATTR_IDS = {
    "theme": 0x01010000, "label": 0x01010001, "icon": 0x01010002, "name": 0x01010003,
    "exported": 0x01010010, "launchMode": 0x0101001D, "configChanges": 0x0101001F,
    "mimeType": 0x01010026, "scheme": 0x01010027, "host": 0x01010028,
    "minSdkVersion": 0x0101020C, "versionCode": 0x0101021B, "versionName": 0x0101021C,
    "windowSoftInputMode": 0x0101022B, "targetSdkVersion": 0x01010270,
    "allowBackup": 0x01010280, "hardwareAccelerated": 0x010102D3,
}
ANDROID_REFS = {
    "@android:style/Theme.Material.Light.NoActionBar": 16974401,
    "@android:style/Theme.Material.NoActionBar": 16974382,
}
INT_ATTRS = {"versionCode", "minSdkVersion", "targetSdkVersion"}
BOOL_ATTRS = {"exported", "allowBackup", "hardwareAccelerated"}
FLAG_ATTRS = {
    "launchMode": {"standard": 0, "singleTop": 1, "singleTask": 2, "singleInstance": 3},
    "configChanges": {"mcc": 0x1, "mnc": 0x2, "locale": 0x4, "touchscreen": 0x8, "keyboard": 0x10,
                      "keyboardHidden": 0x20, "navigation": 0x40, "orientation": 0x80,
                      "screenLayout": 0x100, "uiMode": 0x200, "screenSize": 0x400,
                      "smallestScreenSize": 0x800, "density": 0x1000, "layoutDirection": 0x2000},
    "windowSoftInputMode": {"stateUnspecified": 0, "adjustResize": 0x10, "adjustPan": 0x20,
                            "adjustNothing": 0x30, "stateHidden": 0x2, "stateAlwaysHidden": 0x3},
}

TYPE_REFERENCE, TYPE_STRING, TYPE_INT_DEC, TYPE_INT_HEX, TYPE_BOOL = 0x01, 0x03, 0x10, 0x11, 0x12

# Local resources: (type, name) -> file inside the APK. Ids are assigned 0x7fTTEEEE.
RESOURCES = [("drawable", "icon", "res/drawable/icon.png")]


def local_ref(value):
    kind, _, name = value[1:].partition("/")
    types = sorted({t for t, _, _ in RESOURCES})
    for t in types:
        entries = [n for tt, n, _ in RESOURCES if tt == t]
        if t == kind and name in entries:
            return (PACKAGE_ID << 24) | ((types.index(t) + 1) << 16) | entries.index(name)
    raise SystemExit(f"unknown resource {value}")


def string_pool(strings):
    """ResStringPool in UTF-16."""
    offsets, data = [], b""
    for s in strings:
        offsets.append(len(data))
        enc = s.encode("utf-16-le")
        data += struct.pack("<H", len(s)) + enc + b"\0\0"
    data += b"\0" * (-len(data) % 4)
    header = 28
    start = header + 4 * len(strings)
    size = start + len(data)
    return struct.pack("<HHIIIIII", 0x0001, header, size, len(strings), 0, 0, start, 0) + \
        b"".join(struct.pack("<I", o) for o in offsets) + data


def compile_manifest(src):
    root = ET.parse(src).getroot()

    attr_names, other = [], []

    def note(s, is_attr=False):
        bucket = attr_names if is_attr else other
        if s not in attr_names and s not in other:
            bucket.append(s)

    def walk(el):
        note(el.tag)
        for k, v in el.attrib.items():
            if k.startswith("{"):
                note(k.split("}")[1], True)
            else:
                note(k)
            note(v)
        for c in el:
            walk(c)

    walk(root)
    note("android")
    note(ANDROID_NS)
    attr_names.sort(key=lambda n: ATTR_IDS[n])
    strings = attr_names + other
    idx = {s: i for i, s in enumerate(strings)}

    chunks = [string_pool(strings)]
    resmap = b"".join(struct.pack("<I", ATTR_IDS[n]) for n in attr_names)
    chunks.append(struct.pack("<HHI", 0x0180, 8, 8 + len(resmap)) + resmap)
    ns = struct.pack("<IIII", 1, 0xFFFFFFFF, idx["android"], idx[ANDROID_NS])
    chunks.append(struct.pack("<HHI", 0x0100, 16, 24) + ns)

    def value_of(name, v):
        if v.startswith("@android:"):
            return TYPE_REFERENCE, ANDROID_REFS[v], 0xFFFFFFFF
        if v.startswith("@"):
            return TYPE_REFERENCE, local_ref(v), 0xFFFFFFFF
        if name in INT_ATTRS:
            return TYPE_INT_DEC, int(v), 0xFFFFFFFF
        if name in BOOL_ATTRS:
            return TYPE_BOOL, 0xFFFFFFFF if v == "true" else 0, 0xFFFFFFFF
        if name in FLAG_ATTRS:
            bits = 0
            for part in v.split("|"):
                bits |= FLAG_ATTRS[name][part]
            return TYPE_INT_HEX, bits, 0xFFFFFFFF
        return TYPE_STRING, idx[v], idx[v]

    def emit(el):
        attrs = []
        for k, v in el.attrib.items():
            if k.startswith("{"):
                name, ns_idx = k.split("}")[1], idx[ANDROID_NS]
                sort_key = ATTR_IDS[name]
            else:
                name, ns_idx, sort_key = k, 0xFFFFFFFF, -1
            dtype, data, raw = value_of(name, v)
            attrs.append((sort_key, struct.pack("<IIIHBBI", ns_idx, idx[name], raw, 8, 0, dtype, data)))
        attrs.sort(key=lambda a: a[0])
        body = struct.pack("<IIHHHHHH", 0xFFFFFFFF, idx[el.tag], 20, 20, len(attrs), 0, 0, 0)
        body += b"".join(a[1] for a in attrs)
        chunks.append(struct.pack("<HHIII", 0x0102, 16, 16 + len(body), 1, 0xFFFFFFFF) + body)
        for c in el:
            emit(c)
        chunks.append(struct.pack("<HHIIIII", 0x0103, 16, 24, 1, 0xFFFFFFFF, 0xFFFFFFFF, idx[el.tag]))

    emit(root)
    chunks.append(struct.pack("<HHI", 0x0101, 16, 24) + ns)
    body = b"".join(chunks)
    return struct.pack("<HHI", 0x0003, 8, 8 + len(body)) + body, root.get("package")


def compile_resources(package):
    """resources.arsc with one package holding RESOURCES (default configuration only)."""
    types = sorted({t for t, _, _ in RESOURCES})
    values = string_pool([p for _, _, p in RESOURCES])
    type_strings = string_pool(types)
    key_strings = string_pool([n for _, n, _ in RESOURCES])

    body = b""
    for ti, t in enumerate(types, start=1):
        entries = [(n, p) for tt, n, p in RESOURCES if tt == t]
        spec = struct.pack("<HHIBBHI", 0x0202, 16, 16 + 4 * len(entries), ti, 0, 0, len(entries))
        spec += b"\0" * (4 * len(entries))
        body += spec
        config = struct.pack("<I", 64) + b"\0" * 60
        header_size = 20 + len(config)
        offsets, data = b"", b""
        all_paths = [p for _, _, p in RESOURCES]
        all_keys = [n for _, n, _ in RESOURCES]
        for name, path in entries:
            offsets += struct.pack("<I", len(data))
            data += struct.pack("<HHI", 8, 0, all_keys.index(name))
            data += struct.pack("<HBBI", 8, 0, TYPE_STRING, all_paths.index(path))
        start = header_size + len(offsets)
        body += struct.pack("<HHIBBHII", 0x0201, header_size, start + len(data), ti, 0, 0,
                            len(entries), start) + config + offsets + data

    name = package.encode("utf-16-le")[:254].ljust(256, b"\0")
    pkg_header = 288
    type_off = pkg_header
    key_off = type_off + len(type_strings)
    pkg = struct.pack("<HHII", 0x0200, pkg_header, 0, PACKAGE_ID) + name + \
        struct.pack("<IIIII", type_off, len(types), key_off, len(RESOURCES), 0)
    pkg += type_strings + key_strings + body
    pkg = pkg[:4] + struct.pack("<I", len(pkg)) + pkg[8:]
    table = values + pkg
    return struct.pack("<HHII", 0x0002, 12, 12 + len(table), 1) + table


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    manifest, package = compile_manifest(src)
    (out / "AndroidManifest.xml").write_bytes(manifest)
    (out / "resources.arsc").write_bytes(compile_resources(package))


if __name__ == "__main__":
    main()
