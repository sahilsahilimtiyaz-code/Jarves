package com.jarvis.local;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * Provider HTTP client.
 *
 * WHY NATIVE: provider APIs (OpenAI, Anthropic, Gemini, …) do not send CORS
 * headers, so a WebView fetch() is blocked. Requests therefore run here and the
 * body is handed back to JavaScript. Keys stay in the Keystore and are only
 * read into a request header.
 *
 * POLICY: HTTPS only. Cleartext is permitted solely when the caller explicitly
 * enabled it AND the host is loopback/private (a LAN OpenAI-compatible server).
 * No redirects are followed to a different scheme.
 */
public final class JarvisHttp {

    private static final int MAX_BODY = 4 * 1024 * 1024;
    private static final ExecutorService POOL = Executors.newCachedThreadPool();
    private static final Map<String, HttpURLConnection> ACTIVE = new ConcurrentHashMap<>();

    private JarvisHttp() {}

    public static JSONObject request(
            String url,
            String method,
            JSONObject headers,
            String body,
            int timeoutMs,
            boolean allowInsecure) throws Exception {
        validate(url, allowInsecure);
        HttpURLConnection connection = open(url, method, headers, body, timeoutMs);
        try {
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = readAll(stream);
            JSONObject out = new JSONObject();
            out.put("status", status);
            out.put("body", text);
            return out;
        } finally {
            connection.disconnect();
        }
    }

    /**
     * Start a streaming request on a worker thread.
     * Chunks are raw bytes decoded as UTF-8; the JavaScript side splits SSE
     * events, so no protocol assumptions live here.
     */
    public static String startStream(
            final String id,
            final String url,
            final String method,
            final JSONObject headers,
            final String body,
            final int timeoutMs,
            final boolean allowInsecure,
            final Consumer<String> onChunk,
            final Consumer<Integer> onDone,
            final Consumer<String> onError) throws Exception {
        validate(url, allowInsecure);
        POOL.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = open(url, method, headers, body, timeoutMs);
                ACTIVE.put(id, connection);
                int status = connection.getResponseCode();
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                if (stream != null) {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
                    char[] buffer = new char[2048];
                    int read;
                    int total = 0;
                    while ((read = reader.read(buffer)) > 0) {
                        total += read;
                        if (total > MAX_BODY) break;
                        onChunk.accept(new String(buffer, 0, read));
                    }
                    reader.close();
                }
                onDone.accept(status);
            } catch (Exception e) {
                onError.accept(e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            } finally {
                ACTIVE.remove(id);
                if (connection != null) connection.disconnect();
            }
        });
        return id;
    }

    public static void abort(String id) {
        HttpURLConnection connection = ACTIVE.remove(id);
        if (connection != null) connection.disconnect();
    }

    private static HttpURLConnection open(
            String url,
            String method,
            JSONObject headers,
            String body,
            int timeoutMs) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method == null ? "POST" : method);
        connection.setConnectTimeout(Math.min(Math.max(timeoutMs, 5_000), 30_000));
        connection.setReadTimeout(Math.max(timeoutMs, 5_000));
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/json");
        if (headers != null) {
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String value = headers.optString(key, "");
                if (value != null && !value.isEmpty()) connection.setRequestProperty(key, value);
            }
        }
        if (body != null && !body.isEmpty()) {
            connection.setDoOutput(true);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(bytes);
            }
        }
        return connection;
    }

    private static void validate(String url, boolean allowInsecure) throws Exception {
        URL parsed = new URL(url);
        String scheme = parsed.getProtocol();
        if ("https".equals(scheme)) return;
        if (!"http".equals(scheme) || !allowInsecure) {
            throw new SecurityException("Provider endpoints must use HTTPS.");
        }
        String host = parsed.getHost();
        boolean local = "localhost".equals(host) || "127.0.0.1".equals(host) || "[::1]".equals(host) || "10.0.2.2".equals(host)
                || host.startsWith("10.") || host.startsWith("192.168.") || host.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*");
        if (!local) throw new SecurityException("Cleartext HTTP is only allowed for loopback/LAN development hosts.");
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        int total = 0;
        while ((read = stream.read(buffer)) > 0) {
            total += read;
            if (total > MAX_BODY) break;
            out.write(buffer, 0, read);
        }
        stream.close();
        return out.toString("UTF-8");
    }
}
