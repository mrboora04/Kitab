package com.kitab.app;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.graphics.Bitmap;
import android.graphics.pdf.PdfRenderer;
import android.os.ParcelFileDescriptor;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Hosts the reader UI (assets/index.html) in a WebView and gives it access to
 * the things a web page cannot do on its own: picking files, keeping a private
 * library, text-to-speech, screen brightness and volume-key page turning.
 */
public class MainActivity extends Activity {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final int PICK_BOOK = 1;

    WebView web;
    File booksDir;
    File coversDir;
    File scansDir;
    TextToSpeech tts;
    boolean ttsReady;
    boolean volumeKeys = true;
    boolean immersive;
    String pendingOpen;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        booksDir = new File(getFilesDir(), "books");
        booksDir.mkdirs();
        coversDir = new File(getFilesDir(), "covers");
        coversDir.mkdirs();
        scansDir = new File(getFilesDir(), "scans");
        scansDir.mkdirs();

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f7f3ea"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        // Locked down: the page can only reach the app's own files and the Bridge below.
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        if (Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);
        WebView.setWebContentsDebuggingEnabled(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);  // catalog covers can be plain http
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return serve(req.getUrl(), req.getRequestHeaders());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // Kitab is for reading only: a link never leaves the app
                return !u.toString().startsWith(ORIGIN);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                if (pendingOpen != null) {
                    js("window.App && App.openBook(" + JSONObject.quote(pendingOpen) + ")");
                    pendingOpen = null;
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Android");
        setContentView(web);

        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() { public void onInit(int status) {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { }
                    @Override public void onError(String id) { onDone(id); }
                    @Override public void onDone(String id) {
                        if (id.endsWith(":last")) js("window.App && App.onSpeechDone()");
                    }
                });
            }
        }});

        handleIntent(getIntent());
        web.loadUrl(ORIGIN + "/index.html");
    }

    static final String ACTION_INSTALLED = "com.kitab.app.UPDATE_STATUS";
    static final String EXTRA_NONCE = "com.kitab.app.NONCE";
    /** A random code for the update being installed: an answer without it did not come from Android's installer. */
    static volatile String installNonce;

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && ACTION_INSTALLED.equals(intent.getAction())) { onInstallStatus(intent); return; }
        handleIntent(intent);
        if (pendingOpen != null) {
            js("window.App && App.openBook(" + JSONObject.quote(pendingOpen) + ")");
            pendingOpen = null;
        }
    }

    /** Android's installer reports back: ask the user to confirm, or tell the page why it did not work. */
    void onInstallStatus(Intent intent) {
        String nonce = intent.getStringExtra(EXTRA_NONCE);
        if (nonce == null || installNonce == null || !installNonce.equals(nonce)) return;   // not our install: ignore it
        int st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
        if (st != PackageInstaller.STATUS_PENDING_USER_ACTION) installNonce = null;          // the install is over
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                try { startActivity(confirm); return; } catch (Exception e) { /* reported below */ }
            }
        }
        if (st == PackageInstaller.STATUS_SUCCESS) return;
        String why;
        if (st == PackageInstaller.STATUS_FAILURE_ABORTED) why = "Update cancelled";
        else if (st == PackageInstaller.STATUS_FAILURE_CONFLICT || st == PackageInstaller.STATUS_FAILURE_INCOMPATIBLE)
            why = "This update cannot replace the Kitab on your phone (it was signed with a different key)";
        else if (st == PackageInstaller.STATUS_FAILURE_STORAGE) why = "Not enough space on the phone for the update";
        else {
            String m = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            why = "The update did not install" + (m != null && m.length() > 0 ? " (" + m + ")" : "");
        }
        js("window.App && App.onUpdateDone(" + JSONObject.quote(why) + ")");
    }

    volatile boolean pageReady;

    /** "Open with Kitab" from a file manager or browser download: copied in the background, then opened. */
    void handleIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return;
        final Uri uri = intent.getData();
        new Thread(new Runnable() { public void run() {
            try {
                final String name = importBook(uri);
                runOnUiThread(new Runnable() { public void run() {
                    if (pageReady) js("window.App && App.openBook(" + JSONObject.quote(name) + ")");
                    else pendingOpen = name;                    // opened when the page has loaded
                }});
            } catch (final Exception e) {
                runOnUiThread(new Runnable() { public void run() { toast("Could not open file: " + e.getMessage()); }});
            }
        }}).start();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK_BOOK || result != RESULT_OK || data == null) return;
        final Uri uri = data.getData();
        if (uri == null) return;
        js("window.App && App.onImportStarted()");
        new Thread(new Runnable() { public void run() {
            try {
                String name = importBook(uri);
                runOnUiThread(new Runnable() { public void run() { js("window.App && App.onImported(" + JSONObject.quote(name) + ")"); }});
            } catch (Exception e) {
                runOnUiThread(new Runnable() { public void run() {
                    js("window.App && App.onImported(null)");
                    toast("Could not import: " + e.getMessage());
                }});
            }
        }}).start();
    }

    /** Copies a picked document into the app's private library and returns its file name. */
    String importBook(Uri uri) throws Exception {
        String name = null;
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) {
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null) name = "book";
        name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        String type = getContentResolver().getType(uri);
        String lower = name.toLowerCase(Locale.ROOT);
        if (!lower.endsWith(".pdf") && !lower.endsWith(".epub") && !lower.endsWith(".txt")) {
            if ("application/pdf".equals(type)) name += ".pdf";
            else if ("application/epub+zip".equals(type)) name += ".epub";
            else if (type != null && type.startsWith("text/")) name += ".txt";
            else throw new Exception("only PDF, EPUB and TXT files are supported");
        }
        File out = new File(booksDir, name);
        File part = new File(booksDir, name + ".part");
        final long MAX = 300L << 20;                        // the same limit as downloads
        try (InputStream in = getContentResolver().openInputStream(uri);
             OutputStream os = new FileOutputStream(part)) {
            if (in == null) throw new Exception("the file could not be read");
            byte[] buf = new byte[1 << 16];
            long done = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                done += n;
                if (done > MAX) throw new Exception("the file is larger than 300 MB");
                os.write(buf, 0, n);
            }
        } catch (Exception e) {
            part.delete();
            throw e;
        }
        if (out.exists() && !out.delete()) { part.delete(); throw new Exception("could not replace the existing file"); }
        if (!part.renameTo(out)) { part.delete(); throw new Exception("could not save the file"); }
        return name;
    }

    static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html");
        MIME.put("js", "application/javascript");
        MIME.put("mjs", "application/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("svg", "image/svg+xml");
        MIME.put("png", "image/png");
        MIME.put("pdf", "application/pdf");
        MIME.put("epub", "application/epub+zip");
        MIME.put("txt", "text/plain");
        MIME.put("bcmap", "application/octet-stream");
        MIME.put("pfb", "application/octet-stream");
        MIME.put("ttf", "font/ttf");
        MIME.put("jpg", "image/jpeg");
    }

    /** Serves the bundled UI from assets/ and the library from /books/. */
    /* ---- PDF pages drawn by Android itself (PdfRenderer): much faster than drawing them in JavaScript ---- */
    private PdfRenderer pdfRenderer;
    private ParcelFileDescriptor pdfFd;
    private String pdfName;
    private String pdfStamp;            // size and time of the file the renderer has open

    /** Page n (from 1) of a PDF in the library, `w` pixels wide, as a JPEG. The last PDF stays open for the next page. */
    synchronized byte[] renderPdfPage(String name, int n, int w) throws Exception {
        File f = new File(booksDir, name);
        if (!f.getCanonicalPath().startsWith(booksDir.getCanonicalPath() + File.separator)) throw new Exception("bad path");
        String stamp = f.length() + ":" + f.lastModified();
        if (!name.equals(pdfName) || pdfRenderer == null || !stamp.equals(pdfStamp)) {
            closePdf();
            pdfStamp = stamp;
            pdfFd = ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
            pdfRenderer = new PdfRenderer(pdfFd);
            pdfName = name;
        }
        if (n < 1 || n > pdfRenderer.getPageCount()) throw new Exception("no such page");
        PdfRenderer.Page page = pdfRenderer.openPage(n - 1);
        try {
            int pw = Math.max(1, page.getWidth()), ph = Math.max(1, page.getHeight());
            w = Math.max(64, Math.min(w, 2400));
            int h = (int) ((long) w * ph / pw);
            if (h > 3200) { h = 3200; w = Math.max(64, (int) ((long) h * pw / ph)); }
            Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            bmp.eraseColor(Color.WHITE);
            page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(w * h / 4);
            bmp.compress(Bitmap.CompressFormat.JPEG, 90, out);
            bmp.recycle();
            return out.toByteArray();
        } finally {
            page.close();
        }
    }

    synchronized void closePdf() {
        try { if (pdfRenderer != null) pdfRenderer.close(); } catch (Exception ignored) { }
        try { if (pdfFd != null) pdfFd.close(); } catch (Exception ignored) { }
        pdfRenderer = null; pdfFd = null; pdfName = null;
    }

    WebResourceResponse serve(Uri uri, Map<String, String> requestHeaders) {
        String url = uri.toString();
        if (!url.startsWith(ORIGIN)) return null;
        String path = uri.getPath();
        if (path == null || path.equals("/")) path = "/index.html";
        String ext = path.substring(path.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        try {
            InputStream in;
            if (path.startsWith("/render/")) {
                Map<String, String> h = new HashMap<>();
                h.put("Cache-Control", "max-age=3600");
                try {
                    int n = Integer.parseInt(uri.getQueryParameter("p"));
                    int w = Integer.parseInt(uri.getQueryParameter("w"));
                    byte[] jpg = renderPdfPage(path.substring("/render/".length()), n, w);
                    return new WebResourceResponse("image/jpeg", null, 200, "OK", h, new java.io.ByteArrayInputStream(jpg));
                } catch (Throwable e) {                       // the page reader falls back to drawing it in JavaScript
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", h, new java.io.ByteArrayInputStream(new byte[0]));
                }
            }
            if (path.startsWith("/covers/")) {
                File f = new File(coversDir, path.substring("/covers/".length()));
                if (!f.getCanonicalPath().startsWith(coversDir.getCanonicalPath())) throw new Exception("bad path");
                in = new FileInputStream(f);
                mime = "image/jpeg";
            } else if (path.startsWith("/books/")) {
                File f = new File(booksDir, path.substring("/books/".length()));
                if (!f.getCanonicalPath().startsWith(booksDir.getCanonicalPath())) throw new Exception("bad path");
                if (uri.getQueryParameter("plain") != null) {
                    in = new FileInputStream(f);     // the plain whole-file answer: the safe fallback when piece-by-piece loading does not work on a phone
                    return new WebResourceResponse(mime, null, 200, "OK", headers, in);
                }
                // Books are served in pieces on request, so a 100 MB scan opens by reading only what it shows
                long length = f.length();
                String asked = null;
                if (requestHeaders != null) for (Map.Entry<String, String> h : requestHeaders.entrySet()) if ("range".equalsIgnoreCase(h.getKey())) asked = h.getValue();
                long[] range = ByteRange.parse(asked, length);
                headers.put("Accept-Ranges", "bytes");
                if (range == ByteRange.UNSATISFIABLE) {
                    headers.put("Content-Range", "bytes */" + length);
                    return new WebResourceResponse("text/plain", "utf-8", 416, "Range Not Satisfiable", headers, new java.io.ByteArrayInputStream(new byte[0]));
                }
                FileInputStream fis = new FileInputStream(f);
                if (range == null) {
                    headers.put("Content-Length", String.valueOf(length));
                    return new WebResourceResponse(mime, null, 200, "OK", headers, fis);
                }
                fis.getChannel().position(range[0]);
                final long left = range[1] - range[0] + 1;
                headers.put("Content-Range", "bytes " + range[0] + "-" + range[1] + "/" + length);
                headers.put("Content-Length", String.valueOf(left));
                return new WebResourceResponse(mime, null, 206, "Partial Content", headers, new java.io.FilterInputStream(fis) {
                    long remaining = left;
                    @Override public int read() throws java.io.IOException {
                        if (remaining <= 0) return -1;
                        int b = super.read();
                        if (b >= 0) remaining--;
                        return b;
                    }
                    @Override public int read(byte[] buf, int off, int len) throws java.io.IOException {
                        if (remaining <= 0) return -1;
                        int n = super.read(buf, off, (int) Math.min(len, remaining));
                        if (n > 0) remaining -= n;
                        return n;
                    }
                });
            } else {
                in = getAssets().open(path.substring(1));
            }
            boolean text = mime.startsWith("text/") || mime.endsWith("javascript") || mime.endsWith("json");
            return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", headers, in);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        }
    }

    File scanDir(String book) {
        String safe = String.valueOf(book).replaceAll("[^A-Za-z0-9._-]", "_");
        if (safe.isEmpty() || safe.matches("\\.+")) safe = "_" + safe;   // never "." or ".." (outside scans/)
        return new File(scansDir, safe);
    }

    void deleteScans(String book) {
        File[] files = scanDir(book).listFiles();
        if (files != null) for (File f : files) f.delete();
        scanDir(book).delete();
    }

    static String sha256Of(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    void js(String code) {
        if (web != null) web.evaluateJavascript(code, null);
    }

    void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (volumeKeys && (k == KeyEvent.KEYCODE_VOLUME_UP || k == KeyEvent.KEYCODE_VOLUME_DOWN)) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) {
                js("window.App && App.onVolumeKey(" + (k == KeyEvent.KEYCODE_VOLUME_DOWN ? 1 : -1) + ")");
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.App ? App.onBack() : false", new android.webkit.ValueCallback<String>() { public void onReceiveValue(String handled) {
            if (!"true".equals(handled)) finish();
        }});
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    void applyImmersive() {
        View d = getWindow().getDecorView();
        int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
        if (immersive) {
            flags |= View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN;
        }
        d.setSystemUiVisibility(flags);
    }

    @Override
    protected void onPause() {
        super.onPause();
        js("window.App && App.saveNow()");
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    /** Methods callable from JavaScript as window.Android.* */
    class Bridge {
        @JavascriptInterface
        public void pickBook() {
            runOnUiThread(new Runnable() { public void run() {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "application/pdf", "application/epub+zip", "text/plain", "application/octet-stream"});
                try {
                    startActivityForResult(i, PICK_BOOK);
                } catch (ActivityNotFoundException e) {
                    toast("No file picker available");
                }
            }});
        }

        @JavascriptInterface
        public String listBooks() {
            JSONArray arr = new JSONArray();
            File[] files = booksDir.listFiles();
            if (files != null) {
                for (File f : files) {
                    String n = f.getName().toLowerCase(Locale.ROOT);
                    if (!n.endsWith(".pdf") && !n.endsWith(".epub") && !n.endsWith(".txt")) continue;
                    try {
                        arr.put(new JSONObject().put("name", f.getName()).put("size", f.length())
                                .put("added", f.lastModified()));
                    } catch (Exception ignored) {
                    }
                }
            }
            return arr.toString();
        }

        @JavascriptInterface
        public boolean deleteBook(String name) {
            if (name == null || name.isEmpty()) return false;
            File f = new File(booksDir, name);
            if (!booksDir.equals(f.getParentFile())) return false;          // checked before anything is deleted
            if (name.equals(pdfName)) closePdf();
            boolean ok = f.delete();
            new File(coversDir, name + ".jpg").delete();
            deleteScans(name);
            return ok;
        }

        /** GET a catalog page. The answer arrives as App.onHttp({id, status, url, type, body, error}). */
        @JavascriptInterface
        public void httpGet(final String id, final String url, final String auth) {
            new Thread(new Runnable() { public void run() {
                JSONObject out = new JSONObject();
                try {
                    out.put("id", id);
                    Http.Result r = Http.get(url, 6 << 20, auth);
                    out.put("status", r.status).put("url", r.url).put("type", r.contentType == null ? "" : r.contentType)
                            .put("body", new String(r.body, "UTF-8"));
                } catch (Exception e) {
                    try { out.put("status", 0).put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
                }
                final String json = out.toString();
                runOnUiThread(new Runnable() { public void run() { js("window.App && App.onHttp(" + json + ")"); }});
            }}).start();
        }

        /** True: PDF pages can be drawn by Android (served at /render/<book>?p=<page>&w=<pixels>). */
        @JavascriptInterface
        public boolean canRenderPdf() { return Build.VERSION.SDK_INT >= 21; }

        /** This app's version number (versionCode), so the page can tell whether an update is newer. */
        @JavascriptInterface
        public int appVersion() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode; } catch (Exception e) { return 0; }
        }

        /** Downloads a newer Kitab, checks it, and opens Android's own "Install this update?" screen.
         *  Progress: App.onUpdate(percent); a problem: App.onUpdateDone(message). */
        @JavascriptInterface
        public void installUpdate(final String url, final String sha256) {
            new Thread(new Runnable() { public void run() {
                String error = null;
                File apk = new File(getCacheDir(), "kitab-update.apk");
                try {
                    if (!url.startsWith("https://")) throw new Exception("The update address is not safe");
                    if (sha256 == null || !sha256.matches("[0-9a-fA-F]{64}")) throw new Exception("The update has no checksum, so Kitab will not install it");
                    final long[] last = {0};
                    Http.download(url, apk, 200L << 20, new Http.Progress() {
                        public void onProgress(long done, long total) {
                            long now = System.currentTimeMillis();
                            if (total > 0 && now - last[0] > 250) {
                                last[0] = now;
                                final int pct = (int) (done * 100 / total);
                                runOnUiThread(new Runnable() { public void run() { js("window.App && App.onUpdate(" + pct + ")"); }});
                            }
                        }
                    }, null);
                    if (!sha256.equalsIgnoreCase(sha256Of(apk)))
                        throw new Exception("The download was damaged. Try again");
                    PackageInstaller installer = getPackageManager().getPackageInstaller();
                    PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                    params.setAppPackageName(getPackageName());
                    int sid = installer.createSession(params);
                    PackageInstaller.Session session = installer.openSession(sid);
                    try {
                        try (OutputStream out = session.openWrite("kitab.apk", 0, apk.length()); InputStream in = new FileInputStream(apk)) {
                            byte[] buf = new byte[65536];
                            int n;
                            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                            session.fsync(out);
                        }
                        byte[] rnd = new byte[16];
                        new java.security.SecureRandom().nextBytes(rnd);
                        StringBuilder nb = new StringBuilder();
                        for (byte x : rnd) nb.append(String.format("%02x", x));
                        installNonce = nb.toString();
                        Intent back = new Intent(MainActivity.this, MainActivity.class).setAction(ACTION_INSTALLED).putExtra(EXTRA_NONCE, installNonce);
                        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? 0x02000000 /* FLAG_MUTABLE */ : 0);
                        session.commit(PendingIntent.getActivity(MainActivity.this, sid, back, flags).getIntentSender());
                    } finally {
                        session.close();
                    }
                } catch (Exception e) {
                    error = String.valueOf(e.getMessage());
                } finally {
                    apk.delete();
                }
                final String err = error;
                runOnUiThread(new Runnable() { public void run() {
                    js("window.App && App.onUpdateDone(" + (err == null ? "null" : JSONObject.quote(err)) + ")");
                }});
            }}).start();
        }

        /** Downloads an EPUB/PDF into the library. Progress: App.onDownload(id, percent); done: App.onDownloaded(id, name, error). */
        @JavascriptInterface
        public void downloadBook(final String id, final String url, final String title, final String coverUrl, final String auth) {
            new Thread(new Runnable() { public void run() {
                String savedName = null, error = null;
                try {
                    String base = title.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", " ").replaceAll("\\s+", " ").trim();
                    if (base.length() > 80) base = base.substring(0, 80).trim();
                    if (base.isEmpty()) base = "book";
                    final File tmp = new File(booksDir, "dl-" + System.nanoTime());
                    final long[] last = {0};
                    Http.Result r = Http.download(url, tmp, 300L << 20, new Http.Progress() {
                        public void onProgress(long done, long total) {
                            long now = System.currentTimeMillis();
                            if (now - last[0] > 250) {
                                last[0] = now;
                                final int pct = total > 0 ? (int) (done * 100 / total) : -1;   // -1: the site did not say how big it is
                                final long got = done;
                                runOnUiThread(new Runnable() { public void run() { js("window.App && App.onDownload(" + JSONObject.quote(id) + "," + pct + "," + got + ")"); }});
                            }
                        }
                    }, auth);
                    String ext;
                    try { ext = Http.bookType(tmp, r); } catch (Exception bad) { tmp.delete(); throw bad; }
                    File dest = new File(booksDir, base + ext);
                    if (dest.exists()) dest.delete();
                    if (!tmp.renameTo(dest)) { tmp.delete(); throw new Exception("Could not save the book"); }
                    savedName = dest.getName();
                    if (coverUrl != null && coverUrl.length() > 0) {
                        try {
                            Http.download(coverUrl, new File(coversDir, savedName + ".jpg"), 5L << 20, null, auth);
                        } catch (Exception ignored) { /* the app draws a cover itself */ }
                    }
                } catch (Exception e) {
                    error = String.valueOf(e.getMessage());
                }
                final String n = savedName, err = error;
                runOnUiThread(new Runnable() { public void run() {
                    js("window.App && App.onDownloaded(" + JSONObject.quote(id) + "," + (n == null ? "null" : JSONObject.quote(n)) + "," + (err == null ? "null" : JSONObject.quote(err)) + ")");
                }});
            }}).start();
        }

        /* Scanned text is kept as one small file per page, so a page is never scanned twice. */
        @JavascriptInterface
        public void saveScan(String book, int page, String html) {
            File dir = scanDir(book);
            dir.mkdirs();
            try (OutputStream os = new FileOutputStream(new File(dir, page + ".html"))) {
                os.write(html.getBytes("UTF-8"));
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public String getScan(String book, int page) {
            File f = new File(scanDir(book), page + ".html");
            if (!f.isFile()) return null;
            try (InputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[(int) f.length()];
                int off = 0, n;
                while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) off += n;
                return new String(buf, 0, off, "UTF-8");
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public int scanCount(String book) {
            String[] names = scanDir(book).list();
            return names == null ? 0 : names.length;
        }

        @JavascriptInterface
        public void deleteScans(String book) {
            MainActivity.this.deleteScans(book);
        }

        @JavascriptInterface
        public boolean canSpeak() {
            return ttsReady;
        }

        /** Speaks text in sentence-sized chunks; App.onSpeechDone() fires after the last one. */
        @JavascriptInterface
        public void speak(String text, float rate) {
            if (!ttsReady) return;
            tts.stop();
            tts.setSpeechRate(rate);
            int max = Math.min(TextToSpeech.getMaxSpeechInputLength(), 3000);
            String[] parts = text.split("(?<=[.!?…;:])\\s+");
            StringBuilder chunk = new StringBuilder();
            int n = 0;
            java.util.List<String> chunks = new java.util.ArrayList<>();
            for (String p : parts) {
                if (chunk.length() + p.length() + 1 > max && chunk.length() > 0) {
                    chunks.add(chunk.toString());
                    chunk.setLength(0);
                }
                while (p.length() > max) {
                    chunks.add(p.substring(0, max));
                    p = p.substring(max);
                }
                chunk.append(p).append(' ');
            }
            if (chunk.toString().trim().length() > 0) chunks.add(chunk.toString());
            if (chunks.isEmpty()) chunks.add(" ");
            for (int i = 0; i < chunks.size(); i++) {
                String id = "u" + (n++) + (i == chunks.size() - 1 ? ":last" : "");
                tts.speak(chunks.get(i), TextToSpeech.QUEUE_ADD, null, id);
            }
        }

        @JavascriptInterface
        public void stopSpeaking() {
            if (ttsReady) tts.stop();
        }

        @JavascriptInterface
        public void setKeepScreenOn(boolean on) {
            runOnUiThread(new Runnable() { public void run() {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }});
        }

        /** 0..1 sets the screen brightness for this app, a negative value restores the system setting. */
        @JavascriptInterface
        public void setBrightness(float value) {
            runOnUiThread(new Runnable() { public void run() {
                WindowManager.LayoutParams lp = getWindow().getAttributes();
                lp.screenBrightness = value < 0 ? WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                        : Math.max(0.01f, Math.min(1f, value));
                getWindow().setAttributes(lp);
            }});
        }

        /** Book pages cannot be screenshotted, screen-recorded or shown in the recent-apps preview while this is on. */
        @JavascriptInterface
        public void setSecure(final boolean on) {
            runOnUiThread(new Runnable() { public void run() {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }});
        }

        @JavascriptInterface
        public void setVolumeKeys(boolean on) {
            volumeKeys = on;
        }

        @JavascriptInterface
        public void setFullscreen(boolean on) {
            runOnUiThread(new Runnable() { public void run() {
                immersive = on;
                applyImmersive();
            }});
        }

        @JavascriptInterface
        public void setBarColor(String color, boolean lightBackground) {
            runOnUiThread(new Runnable() { public void run() {
                try {
                    int c = Color.parseColor(color);
                    Window w = getWindow();
                    w.setStatusBarColor(c);
                    w.setNavigationBarColor(c);
                    web.setBackgroundColor(c);
                    if (Build.VERSION.SDK_INT >= 23) {
                        View d = w.getDecorView();
                        int f = d.getSystemUiVisibility();
                        f = lightBackground ? (f | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR) : (f & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
                        d.setSystemUiVisibility(f);
                    }
                } catch (Exception ignored) {
                }
            }});
        }

        @JavascriptInterface
        public void toast(String msg) {
            runOnUiThread(new Runnable() { public void run() { Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show(); }});
        }
    }
}
