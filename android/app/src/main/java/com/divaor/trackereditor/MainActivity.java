package com.divaor.trackereditor;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The app's own plugin (files given to the app, secrets, Back): before the bridge starts.
        registerPlugin(TrackerNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
