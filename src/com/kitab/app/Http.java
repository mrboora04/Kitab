package com.kitab.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Small blocking HTTP client for catalog pages and book downloads. No Android dependencies, so it is testable on a plain JVM. */
final class Http {
    static final String USER_AGENT = "Kitab/1.0 (Android ebook reader)";
    static final int MAX_REDIRECTS = 8;

    static final class Result {
        int status;
        String url;          // final address after redirects
        String contentType;
        byte[] body;
    }

    interface Progress {
        void onProgress(long done, long total);
    }

    private Http() { }

    /** Opens a connection and follows redirects by hand (HttpURLConnection will not switch between http and https). */
    private static HttpURLConnection open(String address, String auth) throws IOException {
        String current = address;
        String authHost = new URL(address).getHost();
        for (int i = 0; i <= MAX_REDIRECTS; i++) {
            URL url = new URL(current);
            String scheme = url.getProtocol();
            if (!"http".equals(scheme) && !"https".equals(scheme)) throw new IOException("Unsupported address");
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", USER_AGENT);
            c.setRequestProperty("Accept", "application/atom+xml, application/xml, text/xml, application/epub+zip, application/pdf, image/*, */*;q=0.5");
            // a catalog login is only ever sent to the catalog's own address, never to a site it redirects to
            if (auth != null && !auth.isEmpty() && url.getHost().equalsIgnoreCase(authHost)) c.setRequestProperty("Authorization", auth);
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) throw new IOException("Redirect without a target");
                current = new URL(url, loc).toString();
                continue;
            }
            return c;
        }
        throw new IOException("Too many redirects");
    }

    /** Fetches a small document (catalog feed, search description) into memory. */
    static Result get(String address, int maxBytes) throws IOException {
        return get(address, maxBytes, null);
    }

    static Result get(String address, int maxBytes, String auth) throws IOException {
        HttpURLConnection c = open(address, auth);
        try {
            Result r = new Result();
            r.status = c.getResponseCode();
            r.url = c.getURL().toString();
            r.contentType = c.getContentType();
            InputStream in = r.status >= 400 ? c.getErrorStream() : c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (in != null) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    if (out.size() > maxBytes) throw new IOException("Response too large");
                }
                in.close();
            }
            r.body = out.toByteArray();
            return r;
        } finally {
            c.disconnect();
        }
    }

    /** Streams a file to disk; the destination only appears once the download has finished completely. */
    static Result download(String address, File dest, long maxBytes, Progress progress) throws IOException {
        return download(address, dest, maxBytes, progress, null);
    }

    static Result download(String address, File dest, long maxBytes, Progress progress, String auth) throws IOException {
        HttpURLConnection c = open(address, auth);
        File part = new File(dest.getPath() + ".part");
        try {
            Result r = new Result();
            r.status = c.getResponseCode();
            r.url = c.getURL().toString();
            r.contentType = c.getContentType();
            if (r.status != 200) throw new IOException("Server answered " + r.status);
            long total = c.getContentLength();
            if (total > maxBytes) throw new IOException("File is too large");
            long done = 0;
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[1 << 15];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    if (done > maxBytes) throw new IOException("File is too large");
                    if (progress != null) progress.onProgress(done, total);
                }
            }
            if (done == 0) throw new IOException("Empty download");
            if (dest.exists() && !dest.delete()) throw new IOException("Cannot replace existing file");
            if (!part.renameTo(dest)) throw new IOException("Cannot save file");
            return r;
        } finally {
            c.disconnect();
            if (part.exists()) part.delete();
        }
    }

    /** File extension for a download, from its content type, then its address. Null when it is not a book we read. */
    static String extensionFor(String contentType, String finalUrl) {
        String t = contentType == null ? "" : contentType.toLowerCase();
        if (t.contains("epub")) return ".epub";
        if (t.contains("pdf")) return ".pdf";
        String path = finalUrl == null ? "" : finalUrl.toLowerCase();
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        if (path.endsWith(".epub") || path.contains(".epub.")) return ".epub";
        if (path.endsWith(".pdf")) return ".pdf";
        if (path.endsWith(".txt") || t.startsWith("text/plain")) return ".txt";
        return null;
    }
}
