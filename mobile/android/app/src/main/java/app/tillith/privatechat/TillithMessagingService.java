package app.tillith.privatechat;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public class TillithMessagingService extends FirebaseMessagingService {
    static final String OPEN = "app.tillith.privatechat.OPEN_PUSH";
    private static final String CHANNEL = "tillith.chat";

    @Override public void onNewToken(String token) {
        try {
            TillithPushRegistration.refresh(this, token);
        } catch (Exception ignored) {
            // The next authenticated connection renews the same registration.
        }
    }

    @Override public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        String device = data.get("device");
        String session = data.get("session");
        if (!"tillith.chat".equals(data.get("kind")) || session == null || session.isEmpty() || session.length() > 100
                || !TillithPushRegistration.accepts(this, device)) return;
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return;
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager.class).createNotificationChannel(
                    new NotificationChannel(CHANNEL, "对话通知", NotificationManager.IMPORTANCE_HIGH));
        }
        Intent intent = new Intent(this, MainActivity.class).setAction(OPEN)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("device", device).putExtra("session", session);
        // The category distinguishes PendingIntents even for colliding Java string hash codes.
        intent.addCategory(device + "." + session);
        PendingIntent open = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationManagerCompat.from(this).notify(device + "." + session, 1, new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.tillith_mark).setContentTitle("Tillith").setContentText("有一条新的对话消息")
                .setPriority(NotificationCompat.PRIORITY_HIGH).setAutoCancel(true).setContentIntent(open).build());
    }
}
