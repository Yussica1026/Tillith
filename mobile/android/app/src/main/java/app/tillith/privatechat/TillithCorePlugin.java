package app.tillith.privatechat;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.lang.reflect.Method;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

@CapacitorPlugin(name = "TillithCore")
public class TillithCorePlugin extends Plugin {
    private static final ExecutorService worker = Executors.newSingleThreadExecutor();
    private static final Object startLock = new Object();
    private static volatile Object module;
    private static volatile boolean requested;
    private static volatile boolean failed;
    private static volatile boolean workerFinished;

    boolean bundled() {
        try { Class.forName("com.chaquo.python.Python"); return true; }
        catch (ClassNotFoundException error) { return false; }
    }

    private static JSONObject invoke(String name, Object... args) throws Exception {
        Method method = module.getClass().getMethod("callAttr", String.class, Object[].class);
        Object result = method.invoke(module, new Object[] { name, args });
        return new JSONObject(result.toString());
    }

    private JSObject state() {
        JSObject result = new JSObject();
        boolean available = bundled();
        String lifecycle = "unavailable";
        boolean restartRequired = false;
        String message = "此安装包尚未包含经过安卓验证的 Python 核心。";
        if (available) {
            lifecycle = requested ? "starting" : "idle";
            if (failed) lifecycle = "failed";
            else if (workerFinished) lifecycle = "stopped";
            if (module != null && !failed) {
                try {
                    String status = invoke("status").optString("state");
                    Object used = module.getClass().getMethod("get", Object.class).invoke(module, "_used");
                    boolean pythonUsed = (Boolean) used.getClass().getMethod("toBoolean").invoke(used);
                    switch (status) {
                        case "ready": lifecycle = workerFinished ? "stopped" : "ready"; break;
                        case "starting": lifecycle = workerFinished ? "stopped" : "starting"; break;
                        case "failed": lifecycle = "failed"; break;
                        case "stopping": lifecycle = "stopped"; break;
                        case "stopped":
                            // The module is published just before run() is called:
                            // its initial stopped/_used=False is still starting.
                            lifecycle = pythonUsed || workerFinished ? "stopped" : requested ? "starting" : "idle";
                            break;
                        default: lifecycle = "failed";
                    }
                } catch (Exception error) { lifecycle = "failed"; }
            }
            restartRequired = lifecycle.equals("failed") || lifecycle.equals("stopped");
            switch (lifecycle) {
                case "ready": message = "手机内置核心已就绪，数据保存在本机。"; break;
                case "starting": message = "手机核心正在初始化，请稍后重新检测。"; break;
                case "failed": message = "手机核心未能启动或读取状态。需要完全关闭 Tillith 后重新打开才能再试。"; break;
                case "stopped": message = "手机核心已停止，当前进程不能再次启动。需要完全关闭 Tillith 后重新打开才能再试。"; break;
                default: message = "手机核心尚未启动。";
            }
        }
        result.put("available", available); result.put("running", lifecycle.equals("ready")); result.put("message", message);
        result.put("state", lifecycle); result.put("restartRequired", restartRequired);
        return result;
    }

    @PluginMethod
    public void status(PluginCall call) { call.resolve(state()); }

    @PluginMethod
    public void start(PluginCall call) {
        // Plugin instances may change when an Activity is recreated; ownership
        // of the one-shot Python interpreter belongs to the whole process.
        synchronized (startLock) {
            JSObject current = state();
            if (!current.optBoolean("available") || requested || current.optBoolean("restartRequired")
                    || current.optBoolean("running")) { call.resolve(current); return; }
            requested = true;
            try {
                Context context = getContext().getApplicationContext();
                worker.execute(() -> {
                    try {
                        Class<?> python = Class.forName("com.chaquo.python.Python");
                        if (!(Boolean) python.getMethod("isStarted").invoke(null)) {
                            Object platform = Class.forName("com.chaquo.python.android.AndroidPlatform").getConstructor(Context.class).newInstance(context);
                            python.getMethod("start", Class.forName("com.chaquo.python.Python$Platform")).invoke(null, platform);
                        }
                        Object runtime = python.getMethod("getInstance").invoke(null);
                        module = python.getMethod("getModule", String.class).invoke(runtime, "bootstrap");
                        File data = new File(context.getFilesDir(), "tillith-core");
                        module.getClass().getMethod("callAttr", String.class, Object[].class)
                            .invoke(module, new Object[] { "run", new Object[] { data.getAbsolutePath(), "" } });
                    } catch (Exception | LinkageError error) { failed = true; }
                    finally { workerFinished = true; }
                });
            } catch (Exception | LinkageError error) {
                failed = true;
                workerFinished = true;
            }
        }
        call.resolve(state());
    }

    @PluginMethod
    public void connection(PluginCall call) {
        try {
            JSONObject config = invoke("connection");
            JSObject result = new JSObject();
            result.put("baseUrl", config.getString("baseUrl")); result.put("apiKey", config.getString("apiKey"));
            if (config.has("managementKey")) result.put("managementKey", config.getString("managementKey"));
            call.resolve(result);
        } catch (Exception error) { call.reject("The embedded core is not ready"); }
    }
}
