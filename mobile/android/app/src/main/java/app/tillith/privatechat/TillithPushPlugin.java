package app.tillith.privatechat;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "TillithPush", permissions = {
        @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})
})
public class TillithPushPlugin extends Plugin {
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile String focused = "";

    private String identity(PluginCall call) {
        return call.getString("base", "") + "\n" + call.getString("profile", "") + "\n" + call.getString("owner", "");
    }

    @PluginMethod public void focus(PluginCall call) {
        focused = identity(call);
        worker.execute(() -> {
            SharedPreferences p = TillithPushRegistration.prefs(getContext());
            boolean same = TillithPushRegistration.matches(p, call.getString("base", ""), call.getString("profile", ""), call.getString("owner", ""));
            boolean active = same && p.getBoolean("enabled", false);
            p.edit().putBoolean("active", active).commit();
            JSObject result = new JSObject();
            boolean available = !FirebaseApp.getApps(getContext()).isEmpty();
            result.put("available", available);
            result.put("enabled", active);
            result.put("pendingRevoke", same && p.contains("device") && !active);
            boolean permission = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
            result.put("permission", permission);
            if (available && active && permission) {
                try {
                    String token = Tasks.await(FirebaseMessaging.getInstance().getToken(), 12, TimeUnit.SECONDS);
                    TillithPushRegistration.refresh(getContext(), token);
                } catch (Exception ignored) {
                    result.put("renewFailed", true);
                }
            }
            call.resolve(result);
        });
    }

    @PluginMethod public void enable(PluginCall call) {
        if (FirebaseApp.getApps(getContext()).isEmpty()) { call.reject("安装包缺少 Firebase 配置。"); return; }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
        } else afterPermission(call);
    }

    @PermissionCallback private void afterPermission(PluginCall call) {
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            call.reject("请在系统设置中允许 Tillith 通知。"); return;
        }
        worker.execute(() -> {
            try {
                if (!identity(call).equals(focused)) throw new IllegalStateException();
                FirebaseMessaging messaging = FirebaseMessaging.getInstance();
                String token = Tasks.await(messaging.getToken(), 15, TimeUnit.SECONDS);
                if (!identity(call).equals(focused)) throw new IllegalStateException();
                TillithPushRegistration.enable(getContext(), call.getString("base", ""), call.getString("profile", ""),
                        call.getString("owner", ""), call.getString("fingerprint", ""), token);
                messaging.setAutoInitEnabled(true);
                call.resolve();
            } catch (Exception ignored) { call.reject("登记未成功，请检查云端 Firebase 配置和网络后重试。"); }
        });
    }

    @PluginMethod public void disable(PluginCall call) {
        worker.execute(() -> {
            try {
                TillithPushRegistration.disable(getContext(), call.getString("base", ""), call.getString("profile", ""), call.getString("owner", ""));
                call.resolve();
            } catch (Exception ignored) { call.reject("本机通知已关闭，云端撤销待重试。"); }
        });
    }

    @Override protected void handleOnNewIntent(Intent intent) {
        if (TillithMessagingService.OPEN.equals(intent.getAction())) {
            getActivity().setIntent(intent);
            notifyListeners("open", new JSObject());
        }
    }

    @PluginMethod public void takeOpen(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            Intent intent = getActivity().getIntent();
            SharedPreferences p = TillithPushRegistration.prefs(getContext());
            if (intent != null && TillithMessagingService.OPEN.equals(intent.getAction())
                    && TillithPushRegistration.matches(p, call.getString("base", ""), call.getString("profile", ""), call.getString("owner", ""))
                    && TillithPushRegistration.accepts(getContext(), intent.getStringExtra("device"))) {
                String session = intent.getStringExtra("session");
                if (session != null && !session.isEmpty() && session.length() <= 100) result.put("session", session);
                intent.setAction(null).removeExtra("device");
                intent.removeExtra("session");
            }
            call.resolve(result);
        });
    }
}
