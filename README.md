<p align="center">
  <img src="docs/icon.png" width="96" alt="Kitab icon">
</p>

<h1 align="center">Kitab</h1>
<p align="center"><b>A free, fast book reader for Android.</b><br>
EPUB · PDF · TXT · free public-domain library · scan old books into readable text</p>

<p align="center">
  <a href="https://github.com/mrboora04/Kitab/raw/main/dist/Kitab.apk">
    <img src="docs/download-button.svg" width="360" alt="Download Kitab for Android">
  </a>
</p>

<p align="center">
  <sub>Free · no ads · no account · Android 5.0 or newer</sub>
</p>

<p align="center">
  <img src="docs/qr-download.png" width="130" alt="QR code to download Kitab"><br>
  <sub>On your computer? Scan this with your phone to download.</sub>
</p>

### Install in 3 taps

1. Tap **Download Kitab** above on your Android phone.
2. Open the downloaded file **Kitab.apk**.
3. If Android asks, allow **Install unknown apps** for your browser, then tap **Install**.

<p align="center">
  <img src="docs/screens/library.png" width="19%" alt="Library">
  <img src="docs/screens/browse.png" width="19%" alt="Browse free books">
  <img src="docs/screens/reader.png" width="19%" alt="Reading">
  <img src="docs/screens/night.png" width="19%" alt="Night theme">
  <img src="docs/screens/settings.png" width="19%" alt="Reading settings">
</p>

---

## What it does

| | |
|---|---|
| **Library** | Covers, % read, "Continue reading", search, sort (recent / added / title / progress), filters (All / Reading / Unread / Finished / ★ Favourites), favourites, mark finished |
| **Browse** | Find free books inside the app: **Project Gutenberg** and **Standard Ebooks** (public domain) are built in, and you can add your own **Calibre / Calibre-Web / Kavita** library (or any OPDS catalog) by its address. Search, open a book's details, download EPUB or PDF straight into your library |
| **History** | Everything you have read, newest first, with progress |
| **Formats** | EPUB, PDF, TXT |
| **Themes** | Paper, Sepia, Mint, Dusk, Night (true black for OLED). Works on PDFs too |
| **Text** | Size, font (serif / sans / mono / the book's own), line spacing, margins, line length (short / medium / long / full), optional bordered "page". Text is always left-aligned with whole words: no stretched spacing, no hyphen splits |
| **Scan text (OCR)** | For scanned or old books that are only page pictures: one tap turns them into readable, adjustable text. Cleans the page first (ignores ornaments, borders and drop-cap decoration but keeps the drop-cap letter). Offline, English, results saved on your phone. The app suggests it when it detects a scan |
| **PDF "Text only" / "Original"** | Reflow a PDF's text like an EPUB, or keep the original pages with trimmed margins and zoom up to 400 % |
| **Clean reading screen** | While reading you only see the book. Tap the middle for back, bookmark, contents and settings; Listen, Scan text, zoom and all reading options live in Settings (Aa) |
| **Page turning** | Tap the screen edges, swipe, or use the volume keys. Scroll mode is also available |
| **Navigation** | Table of contents, bookmarks, a progress slider to jump anywhere |
| **Comfort** | In-app brightness, warm-light filter, keep screen on, full screen |
| **Read aloud** | Reads the page with Android's text-to-speech and turns pages for you. Start it from Settings; tap the page to stop |

Open a book with **+ Add**, or tap a PDF/EPUB in your file manager or downloads and choose
**Kitab**. The app keeps its own copy of the book, so its place in the library is not affected if you move the original file.

## Privacy and content

- The only permission is **Internet**, used for the Browse tab. No accounts, no ads, no analytics, nothing is sent anywhere except the catalog requests you make.
- Reading progress, bookmarks and scanned text stay on your phone.
- Kitab does **not** include or link to sources of pirated books. The built-in catalogs offer public-domain books only. Catalogs you add yourself are your responsibility; use libraries you have the right to read.

## How it's built

The UI is HTML/JS in [`assets/`](assets/), running in an Android WebView
([`MainActivity.java`](src/com/kitab/app/MainActivity.java)) that adds the native parts:
file picking, the private library folder, catalog requests and downloads ([`Http.java`](src/com/kitab/app/Http.java)), text-to-speech, brightness and volume keys.
Catalog browsing is [`opds.js`](assets/js/opds.js) and [`browse.js`](assets/js/browse.js).
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
