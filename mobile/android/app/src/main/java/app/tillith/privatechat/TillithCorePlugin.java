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
    private static volatile Object module;
    private static volatile boolean requested;
    private static volatile boolean failed;

    private boolean bundled() {
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
        boolean ready = false;
        String message = "此安装包尚未包含经过安卓验证的 Python 核心。";
        if (available) {
            message = failed ? "手机核心未能启动，请检查内置依赖兼容性。" : "手机核心尚未启动。";
            if (requested && !failed) message = "手机核心正在初始化，请稍后重新检测。";
            if (module != null) {
                try {
                    String status = invoke("status").optString("state");
                    ready = status.equals("ready");
                    if (ready) message = "手机内置核心已就绪，数据保存在本机。";
                    if (status.equals("failed")) message = "手机核心启动失败，请检查内置依赖兼容性。";
                } catch (Exception error) { message = "暂时无法读取手机核心状态。"; }
            }
        }
        result.put("available", available); result.put("running", ready); result.put("message", message);
        return result;
    }

    @PluginMethod
    public void status(PluginCall call) { call.resolve(state()); }

    @PluginMethod
    public synchronized void start(PluginCall call) {
        if (!bundled() || requested) { call.resolve(state()); return; }
        requested = true;
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
            } catch (Exception error) { failed = true; }
        });
        call.resolve(state());
    }

    @PluginMethod
    public void connection(PluginCall call) {
        try {
            JSONObject config = invoke("connection");
            JSObject result = new JSObject();
            result.put("baseUrl", config.getString("baseUrl")); result.put("apiKey", config.getString("apiKey"));
            call.resolve(result);
        } catch (Exception error) { call.reject("The embedded core is not ready"); }
    }
}
