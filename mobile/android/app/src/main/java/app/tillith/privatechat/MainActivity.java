package app.tillith.privatechat;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TillithVaultPlugin.class);
        registerPlugin(TillithCorePlugin.class);
        registerPlugin(TillithFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
