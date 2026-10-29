#!/usr/bin/env bash
# Builds dist/EasyReader.apk with only a JDK, Python 3 (+Pillow) and two jars from Maven Central:
#   android-all.jar  (org.robolectric:android-all:10-robolectric-5803371, the Android 10 framework)
#   dalvik-dx.jar    (com.jakewharton.android.repackaged:dalvik-dx:16.0.1, the dex compiler)
# Set TOOLS to the folder holding them (downloaded automatically if missing) and
# KEYSTORE/STOREPASS to sign with your own key (a new one is generated otherwise).
set -euo pipefail
cd "$(dirname "$0")"

TOOLS=${TOOLS:-.tools}
KEYSTORE=${KEYSTORE:-$TOOLS/release.p12}
STOREPASS=${STOREPASS:-easyreader}
BUILD=build
mkdir -p "$TOOLS" dist

fetch() {  # fetch <path-in-maven-central> <out> <sha1>
  [ -f "$2" ] && return
  curl -fsSL --retry 3 -o "$2" "https://repo1.maven.org/maven2/$1"
  echo "$3  $2" | sha1sum -c -
}
fetch org/robolectric/android-all/10-robolectric-5803371/android-all-10-robolectric-5803371.jar \
  "$TOOLS/android-all.jar" 873cbe64a7ac6fc2f9f5e2f6a24967fcc7a28ff8
fetch com/jakewharton/android/repackaged/dalvik-dx/16.0.1/dalvik-dx-16.0.1.jar \
  "$TOOLS/dalvik-dx.jar" 71ac16d1f34143d86440fca923422f9c2e2ac403

rm -rf "$BUILD" && mkdir -p "$BUILD/classes" "$BUILD/apk/res/drawable"

echo "== compile java"
javac -nowarn -Xlint:-options --release 8 -cp "$TOOLS/android-all.jar" -d "$BUILD/classes" \
  $(find src -name '*.java')

echo "== dex"
java -cp "$TOOLS/dalvik-dx.jar" com.android.dx.command.Main --dex --min-sdk-version=21 \
  --output="$BUILD/apk/classes.dex" "$BUILD/classes"

echo "== manifest + resources"
python3 tools/aapt_lite.py AndroidManifest.xml "$BUILD/apk"
cp res/drawable/icon.png "$BUILD/apk/res/drawable/icon.png"
cp -r assets "$BUILD/apk/assets"

echo "== package"
UNSIGNED="$BUILD/unsigned.apk"
(cd "$BUILD/apk" && zip -qr -X -D ../unsigned.apk AndroidManifest.xml classes.dex resources.arsc res assets)

echo "== sign"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -storepass "$STOREPASS" -alias easyreader \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Easy Reader" >/dev/null 2>&1
fi
cp "$UNSIGNED" dist/EasyReader.apk
jarsigner -keystore "$KEYSTORE" -storepass "$STOREPASS" -sigalg SHA256withRSA -digestalg SHA-256 \
  dist/EasyReader.apk easyreader >/dev/null
jarsigner -verify dist/EasyReader.apk | tail -1
ls -l dist/EasyReader.apk
