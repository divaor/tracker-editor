package com.divaor.trackereditor;

import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageInfo;
import android.content.res.AssetManager;
import android.os.Environment;
import android.os.IBinder;
import android.os.Process;
import android.os.SystemClock;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import org.json.JSONObject;

/**
 * Starts the app's own Node.js (NodeService) and talks to it: the page gets the port and its
 * token; answers to the questions Node asks the phone (pickers, dialogs) go straight to Node
 * with a second token the page never sees.
 *
 * Starting runs on the plugin's background threads (one at a time, `starting`); the service
 * callbacks come on the main thread and only set fields, so the screen never waits for Node.
 * When Node ends, the service is let go: the next call starts a fresh one (never a loop of
 * restarts).
 */
final class NodeBackend {

    private static final String ASSETS = "nodejs";
    private static final long START_TIMEOUT_MS = 25000;
    private final Context context;
    private final Secrets secrets;
    private final Object starting = new Object();
    private volatile int port = -1;
    private volatile String token;
    private volatile String nativeToken;
    private volatile boolean died;
    private volatile ServiceConnection connection;

    interface Secrets {
        String get(String key);
        void set(String key, String value);
    }

    NodeBackend(Context context, Secrets secrets) {
        this.context = context.getApplicationContext();
        this.secrets = secrets;
    }

    /** Running (started if needed): { port, token }. */
    JSONObject start() throws Exception {
        synchronized (starting) {
            if (port > 0 && ping()) return info();
            stop();
            long t0 = SystemClock.uptimeMillis();
            File project = prepareProject();
            String newToken = random();
            String newNativeToken = random();
            File portFile = new File(context.getFilesDir(), "node-port");
            File failFile = new File(context.getFilesDir(), "node-failed");
            portFile.delete();
            failFile.delete();
            File data = new File(context.getFilesDir(), "node-data");
            File temp = new File(context.getCacheDir(), "node-tmp");
            data.mkdirs();
            temp.mkdirs();
            File nodeLog = AppLog.fileFor(context, "node.log");
            AppLog.rotate(nodeLog);
            File storage = Environment.getExternalStorageDirectory();
            JSONObject paths = new JSONObject()
                .put("userData", data.getPath())
                .put("home", storage.getPath())
                .put("desktop", storage.getPath())
                .put("documents", Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS).getPath())
                .put("downloads", Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).getPath())
                .put("temp", temp.getPath());
            JSONObject config = new JSONObject()
                .put("token", newToken)
                .put("nativeToken", newNativeToken)
                .put("portFile", portFile.getPath())
                .put("projectDir", project.getPath())
                .put("nativeLibDir", context.getApplicationInfo().nativeLibraryDir)
                .put("origin", "https://localhost")
                .put("version", versionName())
                .put("secretKey", secretKey())
                .put("paths", paths);
            Intent intent = new Intent(context, NodeService.class)
                .putExtra("main", new File(project, "mobile/node/main.cjs").getPath())
                .putExtra("config", config.toString())
                .putExtra("log", nodeLog.getPath())
                .putExtra("failFile", failFile.getPath());
            died = false;
            ServiceConnection conn = new ServiceConnection() {
                @Override
                public void onServiceConnected(ComponentName name, IBinder service) {}

                @Override
                public void onServiceDisconnected(ComponentName name) {
                    gone(this, "Node.js's process ended");
                }

                @Override
                public void onBindingDied(ComponentName name) {
                    gone(this, "Node.js's service went away");
                }

                @Override
                public void onNullBinding(ComponentName name) {
                    gone(this, "Node.js's service did not start");
                }
            };
            connection = conn;
            AppLog.i("node", "Starting Node.js (" + (SystemClock.uptimeMillis() - t0) + " ms to prepare)");
            if (!context.bindService(intent, conn, Context.BIND_AUTO_CREATE)) {
                connection = null;
                throw new IllegalStateException("The app's file access could not start (its service was refused).");
            }
            long until = SystemClock.uptimeMillis() + START_TIMEOUT_MS;
            while (!portFile.exists() && !failFile.exists() && !died && SystemClock.uptimeMillis() < until) Thread.sleep(50);
            if (!portFile.exists()) {
                String why = failFile.exists() ? new String(Files.readAllBytes(failFile.toPath()), StandardCharsets.UTF_8).trim() : died ? "Node.js ended while starting" : "Node.js did not answer in " + (START_TIMEOUT_MS / 1000) + " s";
                AppLog.i("node", "Could not start: " + why);
                stop();
                throw new IllegalStateException("The app's file access did not start (" + why + "). Send a log: Settings, or long-press the app's icon.");
            }
            port = Integer.parseInt(new String(Files.readAllBytes(portFile.toPath()), StandardCharsets.UTF_8).trim());
            token = newToken;
            nativeToken = newNativeToken;
            AppLog.i("node", "Node.js is ready (" + (SystemClock.uptimeMillis() - t0) + " ms)");
            return info();
        }
    }

    // On the main thread: only fields change here, and the service is let go so Android does
    // not start it again by itself.
    private void gone(ServiceConnection conn, String why) {
        if (connection != conn) return;
        AppLog.i("node", why);
        died = true;
        port = -1;
        connection = null;
        try {
            context.unbindService(conn);
        } catch (Exception ignored) {}
    }

    private JSONObject info() throws Exception {
        return new JSONObject().put("port", port).put("token", token);
    }

    /** Ends Node (its process) so a fresh one starts. */
    void stop() {
        synchronized (starting) {
            ServiceConnection conn = connection;
            connection = null;
            if (conn != null) {
                try {
                    context.unbindService(conn);
                } catch (Exception ignored) {}
            }
            ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null && am.getRunningAppProcesses() != null) {
                for (ActivityManager.RunningAppProcessInfo p : am.getRunningAppProcesses()) {
                    if ((context.getPackageName() + ":node").equals(p.processName)) Process.killProcess(p.pid);
                }
            }
            port = -1;
        }
    }

    private boolean ping() {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/ping").openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            c.setRequestProperty("x-token", token);
            int code = c.getResponseCode();
            c.disconnect();
            return code == 200;
        } catch (Exception e) {
            return false;
        }
    }

    /** The answer to a question Node asked the phone ({ paths }, { response }, { error }). */
    void answer(String id, JSONObject answer) {
        int to = port;
        String with = nativeToken;
        if (to <= 0) return;
        try {
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + to + "/native").openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(3000);
            c.setRequestProperty("content-type", "application/json");
            c.setRequestProperty("x-token", with);
            byte[] body = new JSONObject().put("id", id).put("answer", answer == null ? JSONObject.NULL : answer).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = c.getOutputStream()) {
                out.write(body);
            }
            c.getResponseCode();
            c.disconnect();
        } catch (Exception e) {
            AppLog.w("node", "Could not answer Node", e);
        }
    }

    // The files Node runs (assets/nodejs, made by scripts/android-node.js), copied out of the
    // app once per version: Node reads files, not assets.
    private File prepareProject() throws Exception {
        File dir = new File(context.getFilesDir(), "nodejs");
        String stamp = versionName() + ":" + installedAt();
        File marker = new File(dir, ".version");
        if (marker.exists() && stamp.equals(new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8))) return dir;
        long t0 = SystemClock.uptimeMillis();
        deleteTree(dir);
        int files = copyAssets(context.getAssets(), ASSETS, dir);
        Files.write(marker.toPath(), stamp.getBytes(StandardCharsets.UTF_8));
        AppLog.i("node", "Copied Node's files for " + stamp + ": " + files + " files, " + (SystemClock.uptimeMillis() - t0) + " ms");
        return dir;
    }

    private static int copyAssets(AssetManager assets, String from, File to) throws Exception {
        String[] names = assets.list(from);
        if (names == null || names.length == 0) {
            to.getParentFile().mkdirs();
            try (InputStream in = assets.open(from); OutputStream out = new FileOutputStream(to)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return 1;
        }
        to.mkdirs();
        int count = 0;
        for (String name : names) count += copyAssets(assets, from + "/" + name, new File(to, name));
        return count;
    }

    private static void deleteTree(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        f.delete();
    }

    // Saved server passwords are encrypted in Node with this key, itself kept encrypted with
    // the app's Keystore key (the same as the other secrets).
    private String secretKey() {
        String key = secrets.get("node-secret-key");
        if (key == null || key.isEmpty()) {
            byte[] bytes = new byte[32];
            new SecureRandom().nextBytes(bytes);
            key = Base64.encodeToString(bytes, Base64.NO_WRAP);
            secrets.set("node-secret-key", key);
        }
        return key;
    }

    private static String random() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        return Base64.encodeToString(bytes, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING);
    }

    private String versionName() {
        try {
            PackageInfo p = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return p.versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    private long installedAt() {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(), 0).lastUpdateTime;
        } catch (Exception e) {
            return 0;
        }
    }
}
