package app.tillith.privatechat;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONObject;

/** Holds routing metadata only. The chat key is read from the Android Keystore vault. */
final class TillithPushRegistration {
    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("tillith-push", Context.MODE_PRIVATE);
    }

    static String digest(String value) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format(Locale.ROOT, "%02x", b));
        return hex.toString();
    }

    static synchronized void enable(Context context, String base, String profile, String owner, String fingerprint, String token) throws Exception {
        UUID.fromString(profile);
        URI uri = new URI(base);
        if (uri.getHost() == null || !"https".equals(uri.getScheme()) || uri.getUserInfo() != null ||
                uri.getRawQuery() != null || uri.getRawFragment() != null || owner.isEmpty()) {
            throw new IllegalArgumentException();
        }
        SharedPreferences p = prefs(context);
        String device = UUID.randomUUID().toString();
        if (matches(p, base, profile, owner) && p.contains("device")) device = p.getString("device", "");
        String key = credential(context, profile, fingerprint);
        send(base, key, device, owner, token);
        if (!p.edit().clear().putString("base", base).putString("profile", profile).putString("owner", owner)
                .putString("fingerprint", fingerprint).putString("device", device).putBoolean("enabled", true)
                .putBoolean("active", true).commit()) throw new IllegalStateException();
    }

    static boolean matches(SharedPreferences p, String base, String profile, String owner) {
        return base.equals(p.getString("base", "")) && profile.equals(p.getString("profile", ""))
                && owner.equals(p.getString("owner", ""));
    }

    static synchronized void refresh(Context context, String token) throws Exception {
        SharedPreferences p = prefs(context);
        if (!p.getBoolean("enabled", false) || !p.getBoolean("active", false)) return;
        String key = credential(context, p.getString("profile", ""), p.getString("fingerprint", ""));
        send(p.getString("base", ""), key, p.getString("device", ""), p.getString("owner", ""), token);
    }

    static synchronized void disable(Context context, String base, String profile, String owner) throws Exception {
        SharedPreferences p = prefs(context);
        if (!matches(p, base, profile, owner)) return;
        p.edit().putBoolean("enabled", false).commit();
        String key = credential(context, profile, p.getString("fingerprint", ""));
        send(base, key, p.getString("device", ""), owner, null);
        p.edit().clear().commit();
    }

    static String credential(Context context, String profile, String fingerprint) throws Exception {
        String key = TillithVaultPlugin.readSlot(context, "profile:" + profile + ":chat");
        if (key.isEmpty() || !digest(key).equals(fingerprint)) throw new IllegalStateException();
        return key;
    }

    static synchronized boolean accepts(Context context, String device) {
        SharedPreferences p = prefs(context);
        if (!p.getBoolean("enabled", false) || !p.getBoolean("active", false)
                || device == null || !device.equals(p.getString("device", ""))) return false;
        try {
            credential(context, p.getString("profile", ""), p.getString("fingerprint", ""));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static void send(String base, String key, String device, String owner, String token) throws Exception {
        boolean revoke = token == null;
        URI uri = new URI(base + "/api/v1/tillith/devices" + (revoke ? "/" + device : ""));
        HttpURLConnection http = (HttpURLConnection) uri.toURL().openConnection();
        try {
            http.setInstanceFollowRedirects(false);
            http.setConnectTimeout(12000);
            http.setReadTimeout(12000);
            http.setRequestMethod(revoke ? "DELETE" : "POST");
            http.setRequestProperty("X-API-Key", key);
            if (!revoke) {
                http.setDoOutput(true);
                http.setRequestProperty("Content-Type", "application/json");
                JSONObject body = new JSONObject().put("device_id", device).put("owner", owner).put("token", token);
                try (OutputStream out = http.getOutputStream()) {
                    out.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
            }
            if (http.getResponseCode() != 200) throw new IllegalStateException();
        } finally {
            http.disconnect();
        }
    }
}
