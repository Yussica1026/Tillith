package app.tillith.privatechat;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "TillithVault")
public class TillithVaultPlugin extends Plugin {
    private static synchronized SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        String alias = "tillith.connection.v1";
        if (!store.containsAlias(alias)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(alias, null);
    }

    private static String slot(PluginCall call) {
        if (!call.getData().has("slot")) return "cloud";
        String slot = call.getString("slot");
        if (slot == null || !slot.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException("Invalid credential slot");
        }
        return slot;
    }

    @PluginMethod
    public void write(PluginCall call) {
        try {
            String slot = slot(call);
            String storageKey = slot.equals("cloud") ? "cloud" : "slot:" + slot;
            String plaintext = call.getString("value", "");
            if (call.getData().has("value") && !(call.getData().opt("value") instanceof String)) {
                throw new IllegalArgumentException("Credential value must be text");
            }
            if (plaintext.isEmpty()) {
                boolean removed = getContext().getSharedPreferences("tillith-vault", Context.MODE_PRIVATE).edit().remove(storageKey).commit();
                if (!removed) throw new IllegalStateException();
                call.resolve();
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            // Preserve the original cloud AAD and key alias for upgrade reads.
            // New slots bind ciphertext to both its profile and key purpose.
            String aad = slot.equals("cloud") ? "TillithCloudKey-v1" : "TillithVault-v2:" + slot;
            cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            String value = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
            boolean saved = getContext().getSharedPreferences("tillith-vault", Context.MODE_PRIVATE).edit().putString(storageKey, value).commit();
            if (!saved) throw new IllegalStateException();
            call.resolve();
        } catch (Exception error) { call.reject("Unable to save the encrypted connection key"); }
    }

    @PluginMethod
    public void read(PluginCall call) {
        try {
            String slot = slot(call);
            String storageKey = slot.equals("cloud") ? "cloud" : "slot:" + slot;
            String value = getContext().getSharedPreferences("tillith-vault", Context.MODE_PRIVATE).getString(storageKey, "");
            JSObject result = new JSObject();
            if (value.isEmpty()) { result.put("value", ""); call.resolve(result); return; }
            String[] parts = value.split(":", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            String aad = slot.equals("cloud") ? "TillithCloudKey-v1" : "TillithVault-v2:" + slot;
            cipher.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
            result.put("value", new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) { call.reject("Unable to unlock the saved connection key"); }
    }

    @PluginMethod
    public void delete(PluginCall call) {
        try {
            String slot = slot(call);
            String storageKey = slot.equals("cloud") ? "cloud" : "slot:" + slot;
            boolean removed = getContext().getSharedPreferences("tillith-vault", Context.MODE_PRIVATE).edit().remove(storageKey).commit();
            if (!removed) throw new IllegalStateException();
            call.resolve();
        } catch (Exception error) { call.reject("Unable to delete the saved connection key"); }
    }
}
