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
    static final String USER_AGENT = "Kitab/1.22 (https://github.com/mrboora04/Kitab; Android ebook reader)";
    static final int MAX_REDIRECTS = 8;

    static final class Result {
        int status;
        String url;          // final address after redirects
        String contentType;
        String disposition;  // Content-Disposition, which often carries the real file name
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
            r.disposition = c.getHeaderField("Content-Disposition");
            if (r.status >= 500 || r.status == 429) {
                // Project Gutenberg is down or busy: its official mirror has the same files
                String mirror = gutenbergMirror(r.url);
                if (mirror != null && !mirror.equals(address)) {
                    c.disconnect();
                    return download(mirror, dest, maxBytes, progress, null);
                }
                throw new IOException("The library is down or busy right now (" + r.status + "). Try again later");
            }
            if (r.status == 404) throw new IOException("The library no longer has this file (404)");
            if (r.status == 401 || r.status == 403) throw new IOException("The library refused the download (" + r.status + "). It may be for members only");
            if (r.status != 200) throw new IOException("The library answered " + r.status);
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

    /** What a downloaded file really is, from its first bytes; then the server's labels. Throws a plain reason when it is not a book. */
    static String bookType(File f, Result r) throws IOException {
        byte[] head = new byte[512];
        int n = 0;
        try (InputStream in = new java.io.FileInputStream(f)) {
            int k;
            while (n < head.length && (k = in.read(head, n, head.length - n)) > 0) n += k;
        }
        String start = new String(head, 0, n, "ISO-8859-1");
        if (start.startsWith("%PDF")) return ".pdf";
        if (start.startsWith("PK\u0003\u0004")) {
            // an EPUB is a zip whose first entry is "mimetype" holding application/epub+zip
            if (start.contains("application/epub+zip") || start.contains("META-INF")) return ".epub";
            String label = extensionFor(r.contentType, r.url);
            if (".epub".equals(label) || ".epub".equals(fromDisposition(r.disposition))) return ".epub";
            throw new IOException("The library sent a zip file, not a book Kitab can open");
        }
        String trimmed = start.replaceFirst("^(\u00ef\u00bb\u00bf)?\\s*", "").toLowerCase();
        if (trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html") || trimmed.startsWith("<head") || trimmed.startsWith("<!--")) {
            if (trimmed.contains("maintenance")) throw new IOException("The library is down for maintenance right now. Try again later");
            throw new IOException("The library sent a web page instead of the book. This book can't be downloaded from here");
        }
        String label = extensionFor(r.contentType, r.url);
        if (label == null) label = fromDisposition(r.disposition);
        if (".txt".equals(label)) return label;
        if (label != null) throw new IOException("The file is damaged or is not really " + label.substring(1).toUpperCase());
        throw new IOException("This file type is not supported (EPUB or PDF only)");
    }

    static final String PG_MIRROR = "https://gutenberg.pglaf.org";
    private static final java.util.regex.Pattern PG_BOOK = java.util.regex.Pattern.compile("^/ebooks/(\\d+)\\.(epub3\\.images|epub\\.images|epub\\.noimages|epub|txt\\.utf-8|txt)$");

    /** The same Project Gutenberg file on its mirror, or null when the address is not a Gutenberg book file. */
    static String gutenbergMirror(String address) {
        URL u;
        try { u = new URL(address); } catch (Exception e) { return null; }
        String host = u.getHost().toLowerCase();
        if (!host.equals("www.gutenberg.org") && !host.equals("gutenberg.org")) return null;
        String path = u.getPath();
        if (path.startsWith("/cache/epub/")) return PG_MIRROR + path;
        java.util.regex.Matcher m = PG_BOOK.matcher(path);
        if (!m.matches()) return null;
        String n = m.group(1), kind = m.group(2), file;
        if (kind.equals("epub3.images")) file = "pg" + n + "-images-3.epub";
        else if (kind.equals("epub.images")) file = "pg" + n + "-images.epub";
        else if (kind.startsWith("txt")) file = "pg" + n + ".txt";
        else file = "pg" + n + ".epub";
        return PG_MIRROR + "/cache/epub/" + n + "/" + file;
    }

    static String fromDisposition(String d) {
        if (d == null) return null;
        String x = d.toLowerCase();
        if (x.contains(".epub")) return ".epub";
        if (x.contains(".pdf")) return ".pdf";
        if (x.contains(".txt")) return ".txt";
        return null;
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
