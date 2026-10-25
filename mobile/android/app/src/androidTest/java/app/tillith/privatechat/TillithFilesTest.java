package app.tillith.privatechat;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import org.junit.Test;

/** Uses only synthetic text and newly created cache files. */
public class TillithFilesTest {
    @Test
    public void selectedContentDocumentReceivesExactUtf8Bytes() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File file = File.createTempFile("tillith-export-test-", ".txt", context.getCacheDir());
        try {
            TestPlugin plugin = new TestPlugin(context);
            String text = "Synthetic conversation\n你好 🌻\n";
            CapturedCall call = new CapturedCall("合成对话.txt", text);
            plugin.saveText(call);
            assertEquals(Intent.ACTION_CREATE_DOCUMENT, plugin.intent.getAction());
            assertTrue(plugin.intent.hasCategory(Intent.CATEGORY_OPENABLE));
            assertEquals("text/plain", plugin.intent.getType());
            assertEquals("合成对话.txt", plugin.intent.getStringExtra(Intent.EXTRA_TITLE));
            assertFalse(plugin.intent.hasExtra("text"));
            assertNull(plugin.saveInstanceState());
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            plugin.documentSelected(call, new ActivityResult(Activity.RESULT_OK, new Intent().setData(uri)));
            assertNull(call.error);
            assertFalse(call.result.optBoolean("cancelled"));
            assertEquals(text.getBytes(StandardCharsets.UTF_8).length, call.result.optInt("bytesWritten"));
            assertArrayEquals(text.getBytes(StandardCharsets.UTF_8), Files.readAllBytes(file.toPath()));
        } finally {
            assertTrue("Unable to remove the synthetic export fixture", file.delete());
        }
    }

    @Test
    public void cancellingDoesNotWriteAndAllowsAnotherExport() {
        TestPlugin plugin = new TestPlugin(null);
        CapturedCall first = new CapturedCall("synthetic.json", "{}");
        plugin.saveText(first);
        assertEquals("application/json", plugin.intent.getType());
        CapturedCall simultaneous = new CapturedCall("another.md", "text");
        plugin.saveText(simultaneous);
        assertEquals("EXPORT_PENDING", simultaneous.error);
        plugin.documentSelected(first, new ActivityResult(Activity.RESULT_CANCELED, null));
        assertTrue(first.result.optBoolean("cancelled"));
        assertFalse(plugin.executed);
        CapturedCall retry = new CapturedCall("another.md", "text");
        plugin.saveText(retry);
        assertNull(retry.error);
        assertEquals("text/markdown", plugin.intent.getType());
        plugin.documentSelected(retry, new ActivityResult(Activity.RESULT_CANCELED, null));
    }

    @Test
    public void fileNamesExtensionsAndUtf8ByteLimitAreEnforced() {
        for (String name : new String[] { "../private.txt", "folder/export.txt", "folder\\export.md", ".txt", "data.exe", "data.json.exe", " trailing.txt ", "one\ntwo\n.txt", repeated('a', 180) + ".txt" }) {
            TestPlugin plugin = new TestPlugin(null);
            CapturedCall call = new CapturedCall(name, "synthetic");
            plugin.saveText(call);
            assertEquals("INVALID_EXPORT", call.error);
            assertNull(plugin.intent);
        }
        byte[] maximum = TillithFilesPlugin.encodeExport("maximum.TXT", repeated('a', TillithFilesPlugin.MAX_EXPORT_BYTES));
        assertEquals(TillithFilesPlugin.MAX_EXPORT_BYTES, maximum.length);
        try {
            TillithFilesPlugin.encodeExport("too-large.txt", repeated('你', TillithFilesPlugin.MAX_EXPORT_BYTES / 3 + 1));
            fail("The limit must count UTF-8 bytes rather than characters");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("8 MiB"));
        }
    }

    @Test
    public void missingOrNonContentUriDoesNotReportASavedFile() {
        for (Uri uri : new Uri[] { null, Uri.parse("file:///synthetic.txt") }) {
            TestPlugin plugin = new TestPlugin(null);
            CapturedCall call = new CapturedCall("synthetic.txt", "text");
            plugin.saveText(call);
            plugin.documentSelected(call, new ActivityResult(Activity.RESULT_OK, uri == null ? null : new Intent().setData(uri)));
            assertEquals("INVALID_DOCUMENT", call.error);
            assertNull(call.result);
            assertFalse(plugin.executed);
        }
    }

    @Test
    public void providerFailureRejectsWithoutReportingSuccess() {
        TestPlugin plugin = new TestPlugin(null);
        CapturedCall call = new CapturedCall("synthetic.md", "text");
        plugin.saveText(call);
        plugin.documentSelected(call, new ActivityResult(Activity.RESULT_OK, new Intent().setData(Uri.parse("content://synthetic/unavailable"))));
        assertEquals("EXPORT_WRITE_FAILED", call.error);
        assertNull(call.result);
        CapturedCall retry = new CapturedCall("retry.md", "text");
        plugin.saveText(retry);
        assertNull(retry.error);
        plugin.documentSelected(retry, new ActivityResult(Activity.RESULT_CANCELED, null));
    }

    private static String repeated(char value, int length) {
        char[] characters = new char[length];
        Arrays.fill(characters, value);
        return new String(characters);
    }

    static class TestPlugin extends TillithFilesPlugin {
        private final Context context;
        Intent intent;
        boolean executed;
        TestPlugin(Context context) { this.context = context; }
        @Override public Context getContext() { return context; }
        @Override public void startActivityForResult(PluginCall call, Intent intent, String callback) { this.intent = intent; }
        @Override public void execute(Runnable runnable) { executed = true; runnable.run(); }
    }

    static class CapturedCall extends PluginCall {
        JSObject result;
        String error;
        CapturedCall(String name, String text) { super(null, "TillithFiles", "synthetic", "saveText", new JSObject().put("name", name).put("text", text)); }
        @Override public void resolve(JSObject value) { result = value; }
        @Override public void reject(String message, String code) { error = code; }
    }
}
