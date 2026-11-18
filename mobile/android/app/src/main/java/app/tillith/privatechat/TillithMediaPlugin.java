package app.tillith.privatechat;

import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Exposes Android's media buttons to the active local playlist in the WebView. */
@CapacitorPlugin(name = "TillithMedia")
public class TillithMediaPlugin extends Plugin {
    private MediaSession session;
    private String item = "";

    private void emit(String action, long position) {
        JSObject event = new JSObject();
        event.put("item", item); event.put("action", action); event.put("position", position);
        notifyListeners("control", event);
    }

    @PluginMethod public void update(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            String id = call.getString("item", "");
            boolean playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
            if (session == null) {
                session = new MediaSession(getContext(), "TillithMusic");
                session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
                session.setCallback(new MediaSession.Callback() {
                    @Override public void onPlay() { emit("play", 0); }
                    @Override public void onPause() { emit("pause", 0); }
                    @Override public void onSkipToNext() { emit("nexttrack", 0); }
                    @Override public void onSkipToPrevious() { emit("previoustrack", 0); }
                    @Override public void onSeekTo(long pos) { emit("seekto", pos); }
                }, new Handler(Looper.getMainLooper()));
            }
            if (!id.equals(item)) {
                item = id;
                session.setMetadata(new MediaMetadata.Builder()
                        .putString(MediaMetadata.METADATA_KEY_TITLE, call.getString("title", ""))
                        .putLong(MediaMetadata.METADATA_KEY_DURATION, call.getData().optLong("duration")).build());
            }
            long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                    | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SEEK_TO;
            if (Boolean.TRUE.equals(call.getBoolean("next", false))) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
            if (Boolean.TRUE.equals(call.getBoolean("previous", false))) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;
            session.setPlaybackState(new PlaybackState.Builder().setActions(actions)
                    .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                            call.getData().optLong("position"), playing ? 1f : 0f).build());
            if (playing) session.setActive(true);
            call.resolve();
        });
    }

    private void release() {
        if (session != null) { session.release(); session = null; }
        item = "";
    }

    @PluginMethod public void clear(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (item.equals(call.getString("item", ""))) release();
            call.resolve();
        });
    }

    @Override protected void handleOnDestroy() { release(); }
}
