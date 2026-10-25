package app.tillith.privatechat;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "TillithFiles")
public class TillithFilesPlugin extends Plugin {
    static final int MAX_EXPORT_BYTES = 8 * 1024 * 1024;
    private final AtomicBoolean pending = new AtomicBoolean();

    static byte[] encodeExport(String name, String text) {
        if (name == null || name.isEmpty() || !name.equals(name.trim()) || name.startsWith(".")
                || name.getBytes(StandardCharsets.UTF_8).length > 180
                || name.matches("(?s).*[\\\\/:*?\"<>|\\p{Cntrl}].*")) {
            throw new IllegalArgumentException("Use a plain file name without folders or control characters");
        }
        String extension = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        if (name.lastIndexOf('.') <= 0 || !(extension.equals("txt") || extension.equals("json") || extension.equals("md"))) {
            throw new IllegalArgumentException("Only txt, json and md exports are supported");
        }
        if (text == null) throw new IllegalArgumentException("Export text is required");
        if (text.length() > MAX_EXPORT_BYTES) throw new IllegalArgumentException("Export exceeds the 8 MiB limit");
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_EXPORT_BYTES) throw new IllegalArgumentException("Export exceeds the 8 MiB limit");
        return bytes;
    }

    @PluginMethod
    public void saveText(PluginCall call) {
        String name = call.getString("name");
        try { encodeExport(name, call.getString("text")); }
        catch (IllegalArgumentException error) { call.reject(error.getMessage(), "INVALID_EXPORT"); return; }
        if (!pending.compareAndSet(false, true)) {
            call.reject("Finish the current export before starting another", "EXPORT_PENDING");
            return;
        }
        String extension = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(extension.equals("json") ? "application/json" : extension.equals("md") ? "text/markdown" : "text/plain");
        intent.putExtra(Intent.EXTRA_TITLE, name);
        try { startActivityForResult(call, intent, "documentSelected"); }
        catch (RuntimeException error) {
            pending.set(false);
            call.reject("Unable to open the system save dialog", "SAVE_DIALOG_FAILED");
        }
    }

    @ActivityCallback
    void documentSelected(PluginCall call, ActivityResult result) {
        if (call == null) { pending.set(false); return; }
        if (result.getResultCode() != Activity.RESULT_OK) {
            pending.set(false);
            JSObject response = new JSObject();
            response.put("cancelled", true);
            call.resolve(response);
            return;
        }
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (uri == null || !"content".equals(uri.getScheme())) {
            pending.set(false);
            call.reject("The system did not return a writable document", "INVALID_DOCUMENT");
            return;
        }
        try {
            byte[] bytes = encodeExport(call.getString("name"), call.getString("text"));
            execute(() -> {
                try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    if (output == null) throw new IOException("No output stream");
                    output.write(bytes);
                    output.flush();
                } catch (IOException | RuntimeException error) {
                    pending.set(false);
                    call.reject("Unable to write the selected document", "EXPORT_WRITE_FAILED");
                    return;
                }
                pending.set(false);
                JSObject response = new JSObject();
                response.put("cancelled", false);
                response.put("bytesWritten", bytes.length);
                call.resolve(response);
            });
        } catch (RuntimeException error) {
            pending.set(false);
            call.reject("The export could not be completed; please try again", "EXPORT_INTERRUPTED");
        }
    }

    @Override
    protected Bundle saveInstanceState() {
        // Never put conversation text into an Activity Bundle: large exports
        // exceed Binder limits. A process death requires a fresh user export.
        return null;
    }
}
