package com.kitab.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
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

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f7f3ea"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);  // catalog covers can be plain http
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return serve(req.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u.toString().startsWith(ORIGIN)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
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

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
        if (pendingOpen != null) {
            js("window.App && App.openBook(" + JSONObject.quote(pendingOpen) + ")");
            pendingOpen = null;
        }
    }

    /** "Open with Kitab" from a file manager or browser download. */
    void handleIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return;
        try {
            pendingOpen = importBook(intent.getData());
        } catch (Exception e) {
            toast("Could not open file: " + e.getMessage());
        }
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
        try (InputStream in = getContentResolver().openInputStream(uri);
             OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        }
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
    WebResourceResponse serve(Uri uri) {
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
            if (path.startsWith("/covers/")) {
                File f = new File(coversDir, path.substring("/covers/".length()));
                if (!f.getCanonicalPath().startsWith(coversDir.getCanonicalPath())) throw new Exception("bad path");
                in = new FileInputStream(f);
                mime = "image/jpeg";
            } else if (path.startsWith("/books/")) {
                File f = new File(booksDir, path.substring("/books/".length()));
                if (!f.getCanonicalPath().startsWith(booksDir.getCanonicalPath())) throw new Exception("bad path");
                in = new FileInputStream(f);
            } else {
                in = getAssets().open(path.substring(1));
            }
            boolean text = mime.startsWith("text/") || mime.endsWith("javascript") || mime.endsWith("json");
            return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", headers, in);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        }
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
            File f = new File(booksDir, name);
            new File(coversDir, name + ".jpg").delete();
            return f.getParentFile().equals(booksDir) && f.delete();
        }

        /** GET a catalog page. The answer arrives as App.onHttp({id, status, url, type, body, error}). */
        @JavascriptInterface
        public void httpGet(final String id, final String url) {
            new Thread(new Runnable() { public void run() {
                JSONObject out = new JSONObject();
                try {
                    out.put("id", id);
                    Http.Result r = Http.get(url, 6 << 20);
                    out.put("status", r.status).put("url", r.url).put("type", r.contentType == null ? "" : r.contentType)
                            .put("body", new String(r.body, "UTF-8"));
                } catch (Exception e) {
                    try { out.put("status", 0).put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
                }
                final String json = out.toString();
                runOnUiThread(new Runnable() { public void run() { js("window.App && App.onHttp(" + json + ")"); }});
            }}).start();
        }

        /** Downloads an EPUB/PDF into the library. Progress: App.onDownload(id, percent); done: App.onDownloaded(id, name, error). */
        @JavascriptInterface
        public void downloadBook(final String id, final String url, final String title, final String coverUrl) {
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
                            if (total > 0 && now - last[0] > 250) {
                                last[0] = now;
                                final int pct = (int) (done * 100 / total);
                                runOnUiThread(new Runnable() { public void run() { js("window.App && App.onDownload(" + JSONObject.quote(id) + "," + pct + ")"); }});
                            }
                        }
                    });
                    String ext = Http.extensionFor(r.contentType, r.url);
                    if (ext == null) { tmp.delete(); throw new Exception("This file type is not supported (EPUB or PDF only)"); }
                    File dest = new File(booksDir, base + ext);
                    if (dest.exists()) dest.delete();
                    if (!tmp.renameTo(dest)) { tmp.delete(); throw new Exception("Could not save the book"); }
                    savedName = dest.getName();
                    if (coverUrl != null && coverUrl.length() > 0) {
                        try {
                            Http.download(coverUrl, new File(coversDir, savedName + ".jpg"), 5L << 20, null);
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
