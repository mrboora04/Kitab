package com.kitab.app;

/** Parses an HTTP Range header ("bytes=0-99", "bytes=100-", "bytes=-500") for one range. No Android dependencies, so it is testable on a plain JVM. */
final class ByteRange {
    /** Returned when the range cannot be satisfied (the answer is 416). */
    static final long[] UNSATISFIABLE = {-1, -1};

    private ByteRange() { }

    /** {start, end} inclusive, null when there is no (usable) Range header, UNSATISFIABLE when it is outside the file. */
    static long[] parse(String header, long length) {
        if (header == null || length <= 0) return null;
        String h = header.trim().toLowerCase(java.util.Locale.ROOT);
        if (!h.startsWith("bytes=") || h.indexOf(',') >= 0) return null;   // other units and multi-range: send the whole file
        String spec = h.substring(6).trim();
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
        try {
            String a = spec.substring(0, dash).trim(), b = spec.substring(dash + 1).trim();
            long start, end;
            if (a.isEmpty()) {                       // suffix: the last n bytes
                long n = Long.parseLong(b);
                if (n <= 0) return UNSATISFIABLE;
                start = Math.max(0, length - n);
                end = length - 1;
            } else {
                start = Long.parseLong(a);
                end = b.isEmpty() ? length - 1 : Math.min(Long.parseLong(b), length - 1);
            }
            if (start < 0 || start >= length || end < start) return UNSATISFIABLE;
            return new long[] {start, end};
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
