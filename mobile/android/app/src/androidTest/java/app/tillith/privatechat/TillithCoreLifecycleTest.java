package app.tillith.privatechat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeFalse;

import android.content.Context;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** Exercises bridge lifecycle decisions without starting or resetting a real core. */
public class TillithCoreLifecycleTest {
    private boolean ownsFixture;

    @Before
    public void requireUnusedProcess() throws Exception {
        assumeFalse("Do not replace a live or previously used Python core", (Boolean) field("requested").get(null));
        assumeFalse("Do not replace an existing Python module", field("module").get(null) != null);
        ownsFixture = true;
    }

    @After
    public void clearSyntheticState() throws Exception {
        if (!ownsFixture) return;
        field("module").set(null, null);
        for (String name : new String[] { "requested", "failed", "workerFinished" }) field(name).setBoolean(null, false);
    }

    @Test
    public void unavailableAndUnusedCoreDoNotRequireRestart() {
        JSObject unavailable = snapshot(new TestPlugin(false));
        assertEquals("unavailable", unavailable.optString("state"));
        assertFalse(unavailable.optBoolean("restartRequired"));
        JSObject idle = snapshot(new TestPlugin(true));
        assertEquals("idle", idle.optString("state"));
        assertFalse(idle.optBoolean("restartRequired"));
    }

    @Test
    public void initialStoppedModuleRemainsStartingUntilPythonRunBegins() throws Exception {
        field("requested").setBoolean(null, true);
        field("module").set(null, new FakeModule("stopped", false));
        JSObject state = snapshot(new TestPlugin(true));
        assertEquals("starting", state.optString("state"));
        assertFalse(state.optBoolean("restartRequired"));
        field("module").set(null, new FakeModule("ready", true));
        state = snapshot(new TestPlugin(true));
        assertEquals("ready", state.optString("state"));
        assertTrue(state.optBoolean("running"));
    }

    @Test
    public void pythonFailureAndUsedStoppedCoreRequireProcessRestart() throws Exception {
        field("requested").setBoolean(null, true);
        for (String phase : new String[] { "failed", "stopping", "stopped" }) {
            field("module").set(null, new FakeModule(phase, true));
            JSObject state = snapshot(new TestPlugin(true));
            assertTrue(state.optBoolean("restartRequired"));
            assertFalse(state.optBoolean("running"));
            assertTrue(state.optString("message").contains("完全关闭 Tillith"));
            CapturedCall retry = new CapturedCall();
            new TestPlugin(true).start(retry);
            assertTrue(retry.result.optBoolean("restartRequired"));
        }
    }

    @Test
    public void workerReturnAndBridgeFailureCannotRemainStarting() throws Exception {
        field("requested").setBoolean(null, true);
        field("workerFinished").setBoolean(null, true);
        field("module").set(null, new FakeModule("stopped", false));
        assertEquals("stopped", snapshot(new TestPlugin(true)).optString("state"));
        assertTrue(snapshot(new TestPlugin(true)).optBoolean("restartRequired"));
        field("failed").setBoolean(null, true);
        assertEquals("failed", snapshot(new TestPlugin(true)).optString("state"));
        field("failed").setBoolean(null, false);
        field("module").set(null, new Object());
        assertEquals("failed", snapshot(new TestPlugin(true)).optString("state"));
    }

    @Test
    public void simultaneousRequestsAcrossPluginInstancesAttemptOnlyOnce() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        CountDownLatch start = new CountDownLatch(1);
        Thread[] callers = new Thread[2];
        CapturedCall[] results = { new CapturedCall(), new CapturedCall() };
        for (int index = 0; index < callers.length; index++) {
            final int slot = index;
            TestPlugin plugin = new TestPlugin(true) {
                @Override public Context getContext() { attempts.incrementAndGet(); return null; }
            };
            callers[index] = new Thread(() -> {
                try { start.await(); plugin.start(results[slot]); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            });
            callers[index].start();
        }
        start.countDown();
        for (Thread caller : callers) { caller.join(5000); assertFalse(caller.isAlive()); }
        assertEquals(1, attempts.get());
        for (CapturedCall call : results) {
            assertEquals("failed", call.result.optString("state"));
            assertTrue(call.result.optBoolean("restartRequired"));
        }
    }

    private static Field field(String name) throws Exception {
        Field field = TillithCorePlugin.class.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    private static JSObject snapshot(TillithCorePlugin plugin) {
        CapturedCall call = new CapturedCall();
        plugin.status(call);
        return call.result;
    }

    static class TestPlugin extends TillithCorePlugin {
        private final boolean available;
        TestPlugin(boolean available) { this.available = available; }
        @Override boolean bundled() { return available; }
        @Override public Context getContext() { throw new AssertionError("A consumed core must not start another worker"); }
    }

    static class CapturedCall extends PluginCall {
        JSObject result;
        CapturedCall() { super(null, "TillithCore", "synthetic", "status", new JSObject()); }
        @Override public void resolve(JSObject value) { result = value; }
    }

    public static class FakeModule {
        private final String state;
        private final boolean used;
        FakeModule(String state, boolean used) { this.state = state; this.used = used; }
        public Object callAttr(String name, Object... args) { return "{\"state\":\"" + state + "\"}"; }
        public Object get(Object key) { return new FakeBoolean(used); }
    }

    public static class FakeBoolean {
        private final boolean value;
        FakeBoolean(boolean value) { this.value = value; }
        public boolean toBoolean() { return value; }
    }
}
