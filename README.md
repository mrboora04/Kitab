# Kitab – Easy Reader (Android)

A small (~7 MB) Android app for reading the books you've downloaded, with more comfortable
settings than a plain PDF viewer. It works offline and asks for no permissions.

**Download:** [`dist/EasyReader.apk`](dist/EasyReader.apk). Open it on your phone and allow
"Install unknown apps" for your browser or file manager when Android asks.

## What it does

| | |
|---|---|
| **Formats** | EPUB, PDF, TXT |
| **Library** | Covers, % read, "Continue reading", remembers your page in every book |
| **Themes** | Paper, Sepia, Mint, Dusk, Night (true black for OLED). Works on PDFs too |
| **Text** | Size, font (serif / sans / mono / the book's own), line spacing, margins. Text is always left-aligned with whole words (no stretched spacing, no hyphen splits), line length (short / medium / long / full) and an optional bordered "page" that keeps text in a comfortable column |
| **PDF "Text only" mode** | Pulls the text out of a PDF and reflows it so you can change size, font and spacing, the way you would in an EPUB. Switch back to "Original" for scanned books, comics or maths |
| **Scan text (OCR)** | For scanned or old books that are only page pictures: one tap turns them into readable, adjustable text. Cleans the page first (ignores ornaments, borders and drop-cap decoration but keeps the drop-cap letter). Offline, English, results saved on your phone. The app suggests it when it detects a scan |
| **PDF "Original" mode** | Trims white margins so the text is bigger, zoom 100–400 %, page or continuous scroll |
| **Page turning** | Tap the screen edges, swipe, or use the volume keys. Scroll mode is also available |
| **Navigation** | Table of contents, bookmarks, a progress slider to jump anywhere |
| **Comfort** | In-app brightness, warm-light filter, keep screen on, full screen |
| **Read aloud** | Reads the page with Android's text-to-speech and turns pages for you |

Open a book with **+ Add book**, or tap a PDF/EPUB in your file manager or downloads and choose
**Easy Reader**. The app keeps its own copy of the book, so its place in the library is not affected if you move the original file.

## How it's built

The UI is HTML/JS in [`assets/`](assets/), running in an Android WebView
([`MainActivity.java`](src/com/easyreader/app/MainActivity.java)) that adds the native parts:
file picking, the private library folder, text-to-speech, brightness and volume keys.
Rendering uses [epub.js](https://github.com/futurepress/epub.js) (BSD-2), [PDF.js](https://mozilla.github.io/pdf.js/)
(Apache-2.0) and [JSZip](https://stuk.github.io/jszip/) (MIT), bundled in `assets/lib/`.

`./build.sh` builds the APK without the Android SDK or Gradle: it needs only a JDK 11+, Python 3 with
Pillow, `zip`, and two jars from Maven Central (the script downloads and checksums them):

- `javac` compiles against the Android 10 framework (`org.robolectric:android-all`)
- `dx` (`com.jakewharton.android.repackaged:dalvik-dx`) converts it to `classes.dex`
- [`tools/aapt_lite.py`](tools/aapt_lite.py) compiles the manifest and the icon resource table
- `jarsigner` signs it (APK signature v1; OCR is [Tesseract](https://github.com/naptha/tesseract.js) (Apache-2.0) bundled in `assets/lib/ocr/`; the app targets API 29, min API 21 / Android 5)

The signing key is generated on first build in `.tools/` and is not committed. Builds made with a
different key can't install over an existing copy, so to update the app you'd need to uninstall it
first (your reading progress is lost when you do). Set `KEYSTORE`/`STOREPASS` to keep one key across builds.

To work on the UI in a desktop browser, serve `assets/` with a `books/` folder next to `index.html`
(e.g. `python3 -m http.server`). Native-only features are stubbed out.
