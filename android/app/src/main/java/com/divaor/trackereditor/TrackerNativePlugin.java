package com.divaor.trackereditor;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The Android side of the editor (app/js/androidApp.js is the page's side): files given to
 * the app (Open with, Edit with, Share, the text selection's menu), reading and writing them
 * through their content:// address, the system's file picker, secrets kept with a key in the
 * Android Keystore, and the Back button. It only moves bytes: the page decodes and encodes
 * text (app/js/textBytes.js), so the rules are the same as on the desktop.
 */
@CapacitorPlugin(name = "TrackerNative")
public class TrackerNativePlugin extends Plugin {

    private static final String TAKEN = "com.divaor.trackereditor.TAKEN";
    private static final String LINK_SCHEME = "tracker-editor";
    private static final String KEY_ALIAS = "tracker-editor-secrets";
    private static final String SECRETS = "secrets";
    // Larger reads come in parts (the page asks for a range).
    private static final int MAX_READ = 24 * 1024 * 1024;

    private final List<JSObject> pending = new ArrayList<>();
    private final ExecutorService io = Executors.newCachedThreadPool();

    @Override
    public void load() {
        // Back: the page closes what is open on top (a dialog, a panel); with nothing open it
        // calls minimize(). Without a page listening, the system does what it does.
        OnBackPressedCallback back = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (hasListeners("back")) {
                    notifyListeners("back", new JSObject());
                } else {
                    setEnabled(false);
                    getActivity().getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        };
        getActivity().runOnUiThread(() -> getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), back));
    }

    // The activity is singleTask: files and text given while it runs come here too (and the
    // first intent, which BridgeActivity passes on after loading the plugins).
    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (take(intent)) notifyListeners("launch", new JSObject(), true);
    }

    private boolean take(Intent intent) {
        if (intent == null || intent.getBooleanExtra(TAKEN, false)) return false;
        String action = intent.getAction();
        List<JSObject> items = new ArrayList<>();
        Uri data = intent.getData();
        if (Intent.ACTION_VIEW.equals(action) && data != null && LINK_SCHEME.equals(data.getScheme())) {
            // tracker-editor://file/<id>, repo/<path> (the tracker's Open in editor), new, voice (the icon's shortcuts).
            JSObject item = new JSObject();
            item.put("kind", "link");
            item.put("url", data.toString());
            items.add(item);
        } else if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_EDIT.equals(action)) {
            Uri uri = data;
            if (uri != null) items.add(fileItem(uri, Intent.ACTION_EDIT.equals(action) ? "edit" : "view", intent.getFlags()));
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri stream = streamOf(intent);
            if (stream != null) {
                items.add(fileItem(stream, "send", intent.getFlags()));
            } else {
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (text != null) items.add(textItem("send", text.toString(), intent.getStringExtra(Intent.EXTRA_SUBJECT)));
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            for (Uri uri : streamsOf(intent)) items.add(fileItem(uri, "send", intent.getFlags()));
        } else if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
            if (text != null) items.add(textItem("process", text.toString(), null));
        }
        intent.putExtra(TAKEN, true);
        if (items.isEmpty()) return false;
        synchronized (pending) {
            pending.addAll(items);
        }
        return true;
    }

    @SuppressWarnings("deprecation")
    private static Uri streamOf(Intent intent) {
        Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (stream instanceof Uri) return (Uri) stream;
        ClipData clip = intent.getClipData();
        return clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).getUri() : null;
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> streamsOf(Intent intent) {
        List<Uri> uris = new ArrayList<>();
        ArrayList<?> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
        if (list != null) for (Object o : list) if (o instanceof Uri) uris.add((Uri) o);
        if (uris.isEmpty() && intent.getClipData() != null) {
            ClipData clip = intent.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) if (clip.getItemAt(i).getUri() != null) uris.add(clip.getItemAt(i).getUri());
        }
        return uris;
    }

    private static JSObject textItem(String action, String text, String subject) {
        JSObject item = new JSObject();
        item.put("kind", "text");
        item.put("action", action);
        item.put("text", text);
        item.put("title", subject == null ? "" : subject);
        return item;
    }

    private JSObject fileItem(Uri uri, String action, int flags) {
        keep(uri, flags);
        JSObject item = describe(uri);
        item.put("kind", "file");
        item.put("action", action);
        return item;
    }

    // Keeps the right to the file across restarts where the app that gave it allows that.
    private void keep(Uri uri, int flags) {
        if (!"content".equals(uri.getScheme())) return;
        int want = flags & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if ((flags & Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION) == 0 || want == 0) return;
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, want);
        } catch (SecurityException ignored) {
            // Not persistable: it lasts while the app runs.
        }
    }

    private boolean writable(Uri uri) {
        if ("file".equals(uri.getScheme())) return uri.getPath() != null && new java.io.File(uri.getPath()).canWrite();
        return getContext().checkCallingOrSelfUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    /** { uri, name, size, mtimeMs, mime, writable } (size and mtimeMs -1 when the app that has it does not say). */
    private JSObject describe(Uri uri) {
        JSObject info = new JSObject();
        info.put("uri", uri.toString());
        String name = uri.getLastPathSegment();
        long size = -1;
        long mtime = -1;
        if ("file".equals(uri.getScheme()) && uri.getPath() != null) {
            java.io.File file = new java.io.File(uri.getPath());
            name = file.getName();
            size = file.length();
            mtime = file.lastModified();
        } else {
            try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int s = c.getColumnIndex(OpenableColumns.SIZE);
                    int m = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
                    if (n >= 0 && !c.isNull(n)) name = c.getString(n);
                    if (s >= 0 && !c.isNull(s)) size = c.getLong(s);
                    if (m >= 0 && !c.isNull(m)) mtime = c.getLong(m);
                }
            } catch (Exception ignored) {
                // Some apps answer no questions about their files: the name from the address.
            }
        }
        String mime = null;
        try {
            mime = getContext().getContentResolver().getType(uri);
        } catch (Exception ignored) {}
        info.put("name", name == null ? "file" : name);
        info.put("size", size);
        info.put("mtimeMs", mtime);
        info.put("mime", mime == null ? "" : mime);
        info.put("writable", writable(uri));
        return info;
    }

    /** What was given to the app since the last call: { items: [{ kind: 'file' | 'text', … }] }. */
    @PluginMethod
    public void takeLaunch(PluginCall call) {
        JSArray items = new JSArray();
        synchronized (pending) {
            for (JSObject item : pending) items.put(item);
            pending.clear();
        }
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    @PluginMethod
    public void stat(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("No file.");
            return;
        }
        io.execute(() -> {
            try {
                call.resolve(describe(Uri.parse(uri)));
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    /** Bytes of a file as base64: { data, size } from `offset`, at most `length` (the whole file by default). */
    @PluginMethod
    public void read(PluginCall call) {
        String uri = call.getString("uri");
        long offset = call.getLong("offset", 0L);
        long length = call.getLong("length", (long) MAX_READ);
        if (uri == null) {
            call.reject("No file.");
            return;
        }
        io.execute(() -> {
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(uri))) {
                if (in == null) throw new FileNotFoundException("The file could not be opened.");
                long skipped = 0;
                while (skipped < offset) {
                    long n = in.skip(offset - skipped);
                    if (n <= 0) break;
                    skipped += n;
                }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                long left = Math.min(length, MAX_READ);
                int n;
                while (left > 0 && (n = in.read(buf, 0, (int) Math.min(buf.length, left))) > 0) {
                    out.write(buf, 0, n);
                    left -= n;
                }
                JSObject result = new JSObject();
                result.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                result.put("length", out.size());
                call.resolve(result);
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    /** Writes base64 `data` over the file (truncated first); answers with its new state. */
    @PluginMethod
    public void write(PluginCall call) {
        String uri = call.getString("uri");
        String data = call.getString("data");
        if (uri == null || data == null) {
            call.reject("Nothing to write.");
            return;
        }
        io.execute(() -> {
            Uri target = Uri.parse(uri);
            byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
            try {
                writeBytes(target, bytes);
                call.resolve(describe(target));
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    // "wt" truncates; a plain "w" would leave the end of a longer old text, so it is never used.
    private void writeBytes(Uri uri, byte[] bytes) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        OutputStream out;
        try {
            out = resolver.openOutputStream(uri, "wt");
        } catch (IllegalArgumentException | UnsupportedOperationException | FileNotFoundException e) {
            out = resolver.openOutputStream(uri, "rwt");
        }
        if (out == null) throw new FileNotFoundException("The app that has this file does not let it be saved.");
        try (OutputStream o = out) {
            o.write(bytes);
        }
    }

    /** The system's file picker: { items } of files kept readable (and writable where allowed) across restarts. */
    @PluginMethod
    public void pick(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, call.getBoolean("multiple", true));
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(PluginCall call, ActivityResult result) {
        JSArray items = new JSArray();
        Intent data = result.getData();
        if (data != null) {
            List<Uri> uris = new ArrayList<>();
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            for (Uri uri : uris) {
                try {
                    getContext()
                        .getContentResolver()
                        .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                } catch (SecurityException e) {
                    try {
                        getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    } catch (SecurityException ignored) {}
                }
                items.put(describe(uri));
            }
        }
        JSObject out = new JSObject();
        out.put("items", items);
        call.resolve(out);
    }

    /** Save a copy: the system asks where; `data` (base64) is written there. Resolves { uri, name } or { canceled }. */
    @PluginMethod
    public void saveAs(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mime", "text/plain"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "untitled.txt"));
        startActivityForResult(call, intent, "savedAs");
    }

    @ActivityCallback
    private void savedAs(PluginCall call, ActivityResult result) {
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (uri == null) {
            JSObject out = new JSObject();
            out.put("canceled", true);
            call.resolve(out);
            return;
        }
        String data = call.getString("data", "");
        io.execute(() -> {
            try {
                writeBytes(uri, Base64.decode(data, Base64.NO_WRAP));
                call.resolve(describe(uri));
            } catch (Exception e) {
                call.reject(message(e));
            }
        });
    }

    /** Opens a file with another app (the system asks which). */
    @PluginMethod
    public void openWith(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) {
            call.reject("No file.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        String mime = call.getString("mime", "");
        intent.setDataAndType(Uri.parse(uri), mime == null || mime.isEmpty() ? "*/*" : mime);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getActivity().startActivity(Intent.createChooser(intent, call.getString("title", "Open with")));
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app on this phone opens this kind of file.");
        }
    }

    /** Shares text with another app through the system's share sheet. */
    @PluginMethod
    public void shareText(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_SEND);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_TEXT, call.getString("text", ""));
        String title = call.getString("title", "");
        if (title != null && !title.isEmpty()) intent.putExtra(Intent.EXTRA_SUBJECT, title);
        getActivity().startActivity(Intent.createChooser(intent, title == null || title.isEmpty() ? "Share" : title));
        call.resolve();
    }

    /** Back with nothing left to close: the app goes to the background, as Home does. */
    @PluginMethod
    public void minimize(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    /** { sdk, release, manufacturer, model, versionName, versionCode }. */
    @PluginMethod
    public void info(PluginCall call) {
        JSObject info = new JSObject();
        info.put("sdk", Build.VERSION.SDK_INT);
        info.put("release", Build.VERSION.RELEASE);
        info.put("manufacturer", Build.MANUFACTURER);
        info.put("model", Build.MODEL);
        try {
            Context context = getContext();
            PackageInfo p = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            info.put("versionName", p.versionName);
            info.put("versionCode", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
        } catch (Exception ignored) {}
        call.resolve(info);
    }

    // ---- Secrets: the GitHub token and model keys, encrypted with a key that never leaves the Keystore.

    private SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }

    private SharedPreferences secrets() {
        return getContext().getSharedPreferences(SECRETS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void secretGet(PluginCall call) {
        String key = call.getString("key");
        JSObject out = new JSObject();
        String stored = key == null ? null : secrets().getString(key, null);
        if (stored == null) {
            out.put("value", null);
            call.resolve(out);
            return;
        }
        try {
            byte[] all = Base64.decode(stored, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, all, 0, 12));
            out.put("value", new String(cipher.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8));
        } catch (Exception e) {
            // A key lost with a restore to another phone: the secret has to be entered again.
            out.put("value", null);
        }
        call.resolve(out);
    }

    @PluginMethod
    public void secretSet(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null) {
            call.reject("No name.");
            return;
        }
        if (value == null || value.isEmpty()) {
            secrets().edit().remove(key).apply();
            call.resolve();
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] all = new byte[iv.length + sealed.length];
            System.arraycopy(iv, 0, all, 0, iv.length);
            System.arraycopy(sealed, 0, all, iv.length, sealed.length);
            secrets().edit().putString(key, Base64.encodeToString(all, Base64.NO_WRAP)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("The secret could not be kept: " + message(e));
        }
    }

    private static String message(Exception e) {
        if (e instanceof SecurityException) return "This app is no longer allowed to open the file. Open it again from where it is.";
        if (e instanceof FileNotFoundException) return e.getMessage() == null ? "The file is not there." : e.getMessage();
        return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
    }
}
