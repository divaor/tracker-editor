package com.divaor.trackereditor;

import android.app.Service;
import android.content.Intent;
import android.os.Binder;
import android.os.IBinder;
import android.util.Log;

/**
 * The app's own Node.js, in a process of its own (":node" in the manifest), running the desktop
 * app's main process for the folders view, servers, terminals and mirrors (mobile/node/main.cjs).
 * The plugin binds to it, so it lives while the app does. Node runs once per process: when it
 * ends, the process ends with it, and the next bind starts a fresh one.
 */
public class NodeService extends Service {

    static {
        System.loadLibrary("node");
        System.loadLibrary("nodehost");
    }

    private static native int startNode(String[] args);

    private static boolean started = false;
    private final IBinder binder = new Binder();

    @Override
    public IBinder onBind(Intent intent) {
        start(intent);
        return binder;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        start(intent);
        return START_NOT_STICKY;
    }

    private static synchronized void start(Intent intent) {
        if (started || intent == null) return;
        String main = intent.getStringExtra("main");
        String config = intent.getStringExtra("config");
        if (main == null || config == null) return;
        started = true;
        // Node wants a deep stack.
        Thread thread = new Thread(
            null,
            () -> {
                int code = startNode(new String[] { "node", main, config });
                Log.i("TrackerNode", "Node.js ended (" + code + ")");
                System.exit(code);
            },
            "node",
            16 * 1024 * 1024
        );
        thread.start();
    }
}
