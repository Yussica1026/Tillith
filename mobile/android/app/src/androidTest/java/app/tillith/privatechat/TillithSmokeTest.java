package app.tillith.privatechat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.SystemClock;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the packaged React application and real Capacitor plugins. */
@RunWith(AndroidJUnit4.class)
public class TillithSmokeTest {
    private static final String SYNTHETIC_KEY = "tillith-instrumentation-synthetic-not-a-user-key";
    private ActivityScenario<MainActivity> scenario;
    private Context context;
    private boolean vaultTouched;

    @Before
    public void launchPackagedApplication() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("app.tillith.privatechat", context.getPackageName());
        scenario = ActivityScenario.launch(MainActivity.class);
        waitForReact();
    }

    @After
    public void clearSyntheticCredentialAndCloseActivity() {
        // Only remove data after this test has confirmed an empty vault and
        // attempted its own synthetic write. Never clear pre-existing keys.
        try {
            if (vaultTouched && context != null) {
                assertTrue("Synthetic credential cleanup failed", context
                    .getSharedPreferences("tillith-vault", Context.MODE_PRIVATE)
                    .edit().remove("cloud").commit());
            }
        } finally {
            if (scenario != null) scenario.close();
        }
    }

    @Test
    public void packagedReactHomeAndBothConnectionModesAreVisible() throws Exception {
        JSONObject home = evaluateObject("({"
            + "heading:document.querySelector('.page-heading h1').textContent,"
            + "brand:!!document.querySelector('.topbar [aria-label=\"Tillith\"]'),"
            + "visible:document.querySelector('.app-inner').getBoundingClientRect().height > 0,"
            + "overflow:document.documentElement.scrollWidth > window.innerWidth"
            + "})");
        assertEquals("会话", home.getString("heading"));
        assertTrue("The Tillith brand did not render", home.getBoolean("brand"));
        assertTrue("The packaged React view is not visible", home.getBoolean("visible"));
        assertFalse("The application overflows the device width", home.getBoolean("overflow"));

        evaluateObject("(() => {"
            + "Array.from(document.querySelectorAll('.bottom-nav button'))"
            + ".find(button => button.textContent.includes('设置')).click();"
            + "return {}; })()");
        waitUntil("document.querySelector('.page-heading h1').textContent === '连接设置'");
        JSONObject modes = evaluateObject("({"
            + "cloud:Array.from(document.querySelectorAll('.mode-option')).some(button => button.textContent.includes('云端核心')),"
            + "device:Array.from(document.querySelectorAll('.mode-option')).some(button => button.textContent.includes('手机内置核心'))"
            + "})");
        assertTrue("The cloud mode entry is missing", modes.getBoolean("cloud"));
        assertTrue("The embedded mode entry is missing", modes.getBoolean("device"));
    }

    @Test
    public void cloudPackageReportsEmbeddedCoreUnavailableThroughBridge() throws Exception {
        JSONObject state = nativeCall("TillithCore", "status", new JSONObject());
        assertFalse("The cloud APK must not claim to bundle Python", state.getBoolean("available"));
        assertFalse("An unbundled core must not claim to be running", state.getBoolean("running"));
        assertFalse("The user needs an explanation for the unavailable core", state.getString("message").isEmpty());

        // A start request must also report the actual unavailable state.
        JSONObject start = nativeCall("TillithCore", "start", new JSONObject());
        assertFalse("Starting must not fabricate an embedded core", start.getBoolean("available"));
        assertFalse("Starting an unbundled core must not report success", start.getBoolean("running"));
    }

    @Test
    public void vaultRoundtripSurvivesActivityRecreationAndClears() throws Exception {
        JSONObject initial = nativeCall("TillithVault", "read", new JSONObject());
        assertTrue("Run this test on a fresh emulator without a saved user credential",
            initial.optString("value", "").isEmpty());
        vaultTouched = true;
        try {
            nativeCall("TillithVault", "write", new JSONObject().put("value", SYNTHETIC_KEY));
            JSONObject first = nativeCall("TillithVault", "read", new JSONObject());
            assertTrue("The native vault did not return the synthetic value",
                SYNTHETIC_KEY.equals(first.optString("value")));
            String encrypted = context.getSharedPreferences("tillith-vault", Context.MODE_PRIVATE)
                .getString("cloud", "");
            assertFalse("The native vault failed to persist its encrypted entry", encrypted.isEmpty());
            assertFalse("The native vault persisted a plaintext value", encrypted.contains(SYNTHETIC_KEY));

            scenario.recreate();
            waitForReact();
            JSONObject reopened = nativeCall("TillithVault", "read", new JSONObject());
            assertTrue("The encrypted value did not survive Activity recreation",
                SYNTHETIC_KEY.equals(reopened.optString("value")));
        } finally {
            nativeCall("TillithVault", "write", new JSONObject().put("value", ""));
            JSONObject cleared = nativeCall("TillithVault", "read", new JSONObject());
            assertTrue("The native vault did not clear the synthetic value", cleared.optString("value", "").isEmpty());
        }
    }

    private void waitForReact() throws Exception {
        waitUntil("window.Capacitor && typeof window.Capacitor.nativePromise === 'function'"
            + " && document.querySelector('.page-heading h1')"
            + " && document.querySelector('.bottom-nav')"
            + " && !document.querySelector('.splash')"
            + " && !document.querySelector('.app-inner').inert");
    }

    private void waitUntil(String condition) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 30000;
        while (SystemClock.uptimeMillis() < deadline) {
            if (evaluateObject("({ready:!!(" + condition + ")})").optBoolean("ready")) return;
            SystemClock.sleep(100);
        }
        throw new AssertionError("The packaged WebView did not reach the expected state within 30 seconds");
    }

    private JSONObject evaluateObject(String expression) throws Exception {
        CountDownLatch returned = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        scenario.onActivity(activity -> activity.getBridge().getWebView().evaluateJavascript(
            "JSON.stringify(" + expression + ")", value -> {
                result.set(value);
                returned.countDown();
            }));
        assertTrue("The WebView did not return a JavaScript result", returned.await(5, TimeUnit.SECONDS));
        Object decoded = new JSONTokener(result.get()).nextValue();
        assertTrue("The WebView returned an invalid result", decoded instanceof String);
        return new JSONObject((String) decoded);
    }

    private JSONObject nativeCall(String plugin, String method, JSONObject arguments) throws Exception {
        // Await the actual asynchronous Capacitor bridge, rather than calling
        // plugin Java methods directly or mocking their results in JavaScript.
        evaluateObject("(() => {"
            + "window.__tillithNativeSmoke = {done:false};"
            + "window.Capacitor.nativePromise(" + JSONObject.quote(plugin) + ","
            + JSONObject.quote(method) + "," + arguments + ")"
            + ".then(value => { window.__tillithNativeSmoke = {done:true,ok:true,value:value || {}}; })"
            + ".catch(() => { window.__tillithNativeSmoke = {done:true,ok:false}; });"
            + "return {}; })()");
        waitUntil("window.__tillithNativeSmoke && window.__tillithNativeSmoke.done");
        JSONObject result = evaluateObject("(() => { const result = window.__tillithNativeSmoke;"
            + "delete window.__tillithNativeSmoke; return result; })()");
        assertTrue("The native plugin rejected " + plugin + "." + method, result.optBoolean("ok"));
        return result.getJSONObject("value");
    }
}
