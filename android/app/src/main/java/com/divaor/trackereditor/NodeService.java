package com.divaor.trackereditor;

import android.app.Service;
import android.content.Intent;
import android.os.Binder;
import android.os.IBinder;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * The app's own Node.js, in a process of its own (":node" in the manifest), running the desktop
 * app's main process for the folders view, servers, terminals and mirrors (mobile/node/main.cjs).
 * The plugin binds to it. Node runs once per process: when it ends, the process ends with it
 * (after saying why in the fail file NodeBackend waits on), and the next start is a fresh one.
 * Its output goes to node.log (nodehost.cpp) as well as the system log.
 */
public class NodeService extends Service {

    private static Throwable loadError;

    static {
        try {
            System.loadLibrary("node");
            System.loadLibrary("nodehost");
        } catch (Throwable e) {
            loadError = e;
        }
    }

    private static native int startNode(String[] args, String logPath);

    private static boolean started = false;
    private final IBinder binder = new Binder();

    @Override
    public void onCreate() {
        super.onCreate();
        AppLog.init(this, "node.log");
        AppLog.catchCrashes();
    }

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
        String log = intent.getStringExtra("log");
        String failFile = intent.getStringExtra("failFile");
        if (main == null || config == null) return;
        started = true;
        if (loadError != null) {
            AppLog.w("node", "Node.js could not be loaded", loadError);
            fail(failFile, "Node.js could not be loaded: " + loadError.getMessage());
            return;
        }
        AppLog.i("node", "Node.js starting");
        // Node wants a deep stack.
        Thread thread = new Thread(
            null,
            () -> {
                int code;
                try {
                    code = startNode(new String[] { "node", main, config }, log == null ? "" : log);
                } catch (Throwable e) {
                    AppLog.w("node", "Node.js failed", e);
                    code = -1;
                }
                AppLog.i("node", "Node.js ended (code " + code + ")");
                fail(failFile, "Node.js ended, code " + code);
                // Let the log reach its file before the process goes.
                try {
                    Thread.sleep(300);
                } catch (InterruptedException ignored) {}
                System.exit(code);
            },
            "node",
            16 * 1024 * 1024
        );
        thread.start();
    }

    private static void fail(String path, String why) {
        if (path == null) return;
        try {
            Files.write(new File(path).toPath(), why.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
    }
}
