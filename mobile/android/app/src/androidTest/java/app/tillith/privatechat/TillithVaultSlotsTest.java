package app.tillith.privatechat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.util.Base64;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Uses an isolated preferences file and synthetic credentials only. */
public class TillithVaultSlotsTest {
    private Context actual;
    private String preferenceName;
    private SharedPreferences preferences;
    private TillithVaultPlugin plugin;

    @Before
    public void isolateSyntheticPreferences() {
        actual = InstrumentationRegistry.getInstrumentation().getTargetContext();
        preferenceName = "tillith-vault-test-" + UUID.randomUUID();
        preferences = actual.getSharedPreferences(preferenceName, Context.MODE_PRIVATE);
        Context isolated = new ContextWrapper(actual) {
            @Override public SharedPreferences getSharedPreferences(String name, int mode) { return preferences; }
        };
        plugin = new TillithVaultPlugin() {
            @Override public Context getContext() { return isolated; }
        };
    }

    @After
    public void removeOnlySyntheticPreferences() {
        if (preferenceName != null) actual.deleteSharedPreferences(preferenceName);
        // Never delete the shared Keystore alias: other real slots may use it.
    }

    @Test
    public void originalCloudCiphertextMigratesOnlyAfterNewSlotIsWritten() throws Exception {
        write("profile:fixture:management", "synthetic-management");
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        Cipher legacy = Cipher.getInstance("AES/GCM/NoPadding");
        legacy.init(Cipher.ENCRYPT_MODE, (SecretKey) store.getKey("tillith.connection.v1", null));
        legacy.updateAAD("TillithCloudKey-v1".getBytes(StandardCharsets.UTF_8));
        String old = Base64.encodeToString(legacy.getIV(), Base64.NO_WRAP) + ":"
            + Base64.encodeToString(legacy.doFinal("synthetic-legacy".getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        assertTrue(preferences.edit().putString("cloud", old).commit());
        assertEquals("synthetic-legacy", read(null));
        CapturedCall failedMigration = new CapturedCall(new JSObject().put("slot", "invalid/slot").put("value", "synthetic-legacy"));
        plugin.write(failedMigration);
        assertNotNull(failedMigration.error);
        assertEquals(old, preferences.getString("cloud", ""));
        write("profile:fixture:chat", read(null));
        assertEquals(old, preferences.getString("cloud", ""));
        delete(null);
        assertFalse(preferences.contains("cloud"));
        assertEquals("synthetic-legacy", read("profile:fixture:chat"));
        assertEquals("synthetic-management", read("profile:fixture:management"));
    }

    @Test
    public void profileAndPurposeSlotsCannotExchangeCiphertext() {
        write("profile:one:chat", "synthetic-chat-one");
        write("profile:one:management", "synthetic-management-one");
        write("profile:two:chat", "synthetic-chat-two");
        assertEquals("synthetic-chat-one", read("profile:one:chat"));
        assertEquals("synthetic-management-one", read("profile:one:management"));
        assertEquals("synthetic-chat-two", read("profile:two:chat"));
        String ciphertext = preferences.getString("slot:profile:one:chat", "");
        assertFalse(ciphertext.contains("synthetic-chat-one"));
        for (String destination : new String[] { "profile:one:management", "profile:two:chat", "cloud" }) {
            String storage = destination.equals("cloud") ? "cloud" : "slot:" + destination;
            assertTrue(preferences.edit().putString(storage, ciphertext).commit());
            CapturedCall call = new CapturedCall(new JSObject().put("slot", destination));
            plugin.read(call);
            assertNotNull(call.error);
            assertNull(call.result);
            assertEquals(ciphertext, preferences.getString(storage, ""));
        }
    }

    @Test
    public void emptyWriteDeletesOnlyTheRequestedSlotAndLegacyCallsStillWork() {
        assertEquals("", read("profile:missing:chat"));
        write(null, "synthetic-old-api");
        assertEquals("synthetic-old-api", read(null));
        assertEquals("synthetic-old-api", read("cloud"));
        write("profile:one:chat", "synthetic-chat");
        write("profile:one:management", "synthetic-management");
        write("profile:one:chat", "");
        assertFalse(preferences.contains("slot:profile:one:chat"));
        assertEquals("", read("profile:one:chat"));
        assertEquals("synthetic-management", read("profile:one:management"));
        assertEquals("synthetic-old-api", read(null));
        write(null, "");
        assertFalse(preferences.contains("cloud"));
        delete("profile:one:management");
        assertEquals("", read("profile:one:management"));
        assertEquals("", read(null));
    }

    @Test
    public void invalidSlotNamesNeverFallBackToTheLegacyCloudEntry() {
        write(null, "synthetic-preserved");
        char[] longName = new char[129];
        Arrays.fill(longName, 'x');
        for (Object invalid : new Object[] { "", "../cloud", "profile/one/chat", " space", ".hidden", "one\nchat", new String(longName), 123, org.json.JSONObject.NULL }) {
            CapturedCall call = new CapturedCall(new JSObject().put("slot", invalid));
            plugin.delete(call);
            assertNotNull(call.error);
            assertEquals("synthetic-preserved", read(null));
        }
        JSObject invalidValueData = new JSObject();
        invalidValueData.put("value", Integer.valueOf(123));
        CapturedCall invalidValue = new CapturedCall(invalidValueData);
        plugin.write(invalidValue);
        assertNotNull(invalidValue.error);
        assertEquals("synthetic-preserved", read(null));
    }

    private void write(String slot, String value) {
        JSObject data = new JSObject().put("value", value);
        if (slot != null) data.put("slot", slot);
        CapturedCall call = new CapturedCall(data);
        plugin.write(call);
        assertNull(call.error);
        assertTrue(call.resolved);
    }

    private String read(String slot) {
        JSObject data = new JSObject();
        if (slot != null) data.put("slot", slot);
        CapturedCall call = new CapturedCall(data);
        plugin.read(call);
        assertNull(call.error);
        return call.result.optString("value");
    }

    private void delete(String slot) {
        JSObject data = new JSObject();
        if (slot != null) data.put("slot", slot);
        CapturedCall call = new CapturedCall(data);
        plugin.delete(call);
        assertNull(call.error);
        assertTrue(call.resolved);
    }

    static class CapturedCall extends PluginCall {
        JSObject result;
        String error;
        boolean resolved;
        CapturedCall(JSObject data) { super(null, "TillithVault", "synthetic", "test", data); }
        @Override public void resolve() { resolved = true; }
        @Override public void resolve(JSObject value) { result = value; resolved = true; }
        @Override public void reject(String message) { error = message; }
    }
}
