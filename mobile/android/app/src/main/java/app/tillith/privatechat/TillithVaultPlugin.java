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
    private SecretKey key() throws Exception {
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

    @PluginMethod
    public void write(PluginCall call) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            cipher.updateAAD("TillithCloudKey-v1".getBytes(StandardCharsets.UTF_8));
            byte[] ciphertext = cipher.doFinal(call.getString("value", "").getBytes(StandardCharsets.UTF_8));
            String value = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
            boolean saved = getContext().getSharedPreferences("tillith-vault", Context.MODE_PRIVATE).edit().putString("cloud", value).commit();
            if (!saved) throw new IllegalStateException();
            call.resolve();
        } catch (Exception error) { call.reject("Unable to save the encrypted connection key"); }
    }

    @PluginMethod
    public void read(PluginCall call) {
        try {
            String value = getContext().getSharedPreferences("tillith-vault", Context.MODE_PRIVATE).getString("cloud", "");
            JSObject result = new JSObject();
            if (value.isEmpty()) { result.put("value", ""); call.resolve(result); return; }
            String[] parts = value.split(":", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            cipher.updateAAD("TillithCloudKey-v1".getBytes(StandardCharsets.UTF_8));
            result.put("value", new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) { call.reject("Unable to unlock the saved connection key"); }
    }
}
