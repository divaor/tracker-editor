package com.divaor.trackereditor;

import android.content.Context;
import android.media.AudioAttributes;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Read aloud with Android's own text to speech, for the page (its WebView has no
 * speechSynthesis): the voices, one passage spoken at a time (the page queues them, so it can
 * pause, skip and highlight), and stopping. Each utterance reports start, done, stopped or
 * error through `events`, with the page's id for it.
 */
final class Speech {

    interface Events {
        void emit(JSObject event);
    }

    interface Fail {
        void with(String message);
    }

    private final Context context;
    private final Events events;
    private TextToSpeech tts;
    private int status = 0; // 0 starting, 1 ready, -1 failed
    private final List<Runnable> waiting = new ArrayList<>();
    private final List<Fail> waitingFails = new ArrayList<>();

    Speech(Context context, Events events) {
        this.context = context.getApplicationContext();
        this.events = events;
    }

    /** Runs `then` once the engine is ready (started the first time it is needed). */
    private synchronized void whenReady(Runnable then, Fail fail) {
        if (status == 1) {
            then.run();
            return;
        }
        if (status == -1) {
            status = 0;
            tts = null;
        }
        waiting.add(then);
        waitingFails.add(fail);
        if (tts != null) return;
        tts = new TextToSpeech(context, (result) -> started(result == TextToSpeech.SUCCESS));
    }

    private void started(boolean ok) {
        List<Runnable> run;
        List<Fail> fails;
        synchronized (this) {
            status = ok ? 1 : -1;
            run = new ArrayList<>(waiting);
            fails = new ArrayList<>(waitingFails);
            waiting.clear();
            waitingFails.clear();
            if (ok) {
                tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override
                    public void onStart(String id) {
                        report(id, "start", 0);
                    }

                    @Override
                    public void onDone(String id) {
                        report(id, "done", 0);
                    }

                    @Override
                    public void onError(String id) {
                        report(id, "error", TextToSpeech.ERROR);
                    }

                    @Override
                    public void onError(String id, int code) {
                        report(id, "error", code);
                    }

                    @Override
                    public void onStop(String id, boolean interrupted) {
                        report(id, "stopped", 0);
                    }
                });
            } else if (tts != null) {
                tts.shutdown();
            }
        }
        if (ok) {
            for (Runnable r : run) r.run();
        } else {
            for (Fail f : fails) f.with("This phone has no text-to-speech engine. Install Speech Services by Google from the Play Store, or choose a speech server in Settings → Read aloud.");
        }
    }

    private void report(String id, String type, int code) {
        JSObject event = new JSObject();
        event.put("id", id);
        event.put("type", type);
        if ("error".equals(type)) event.put("message", messageFor(code));
        events.emit(event);
    }

    private static String messageFor(int code) {
        switch (code) {
            case TextToSpeech.ERROR_NETWORK:
            case TextToSpeech.ERROR_NETWORK_TIMEOUT:
                return "this voice needs a connection; choose one on the phone in Settings → Read aloud";
            case TextToSpeech.ERROR_NOT_INSTALLED_YET:
                return "the voice is still being downloaded; try again in a moment";
            case TextToSpeech.ERROR_OUTPUT:
                return "the phone could not play the sound";
            case TextToSpeech.ERROR_SERVICE:
                return "the text-to-speech engine stopped";
            case TextToSpeech.ERROR_SYNTHESIS:
                return "the voice could not read this text";
            case TextToSpeech.ERROR_INVALID_REQUEST:
                return "the text-to-speech engine refused the text";
            default:
                return "the text-to-speech engine failed";
        }
    }

    /** { voices: [{ name, label, lang, network, quality }], defaultVoice, engine }: installed voices only. */
    void voices(Callback<JSObject> done, Fail fail) {
        whenReady(() -> {
            JSObject out = new JSObject();
            JSArray list = new JSArray();
            Set<Voice> all = null;
            try {
                all = tts.getVoices();
            } catch (Exception ignored) {}
            if (all != null) {
                for (Voice v : all) {
                    Set<String> features = v.getFeatures();
                    if (features != null && features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                    JSObject o = new JSObject();
                    o.put("name", v.getName());
                    o.put("label", labelOf(v));
                    o.put("lang", v.getLocale().toLanguageTag());
                    o.put("network", v.isNetworkConnectionRequired());
                    o.put("quality", v.getQuality());
                    list.put(o);
                }
            }
            out.put("voices", list);
            Voice def = null;
            try {
                def = tts.getDefaultVoice();
            } catch (Exception ignored) {}
            out.put("defaultVoice", def != null ? def.getName() : "");
            out.put("engine", tts.getDefaultEngine());
            done.with(out);
        }, fail);
    }

    // "English (United States) · iom", with "online" for the voices that need a connection.
    private static String labelOf(Voice v) {
        String name = v.getName();
        String variant = "";
        int x = name.indexOf("-x-");
        if (x >= 0) {
            variant = name.substring(x + 3);
            int dash = variant.indexOf('-');
            if (dash > 0) variant = variant.substring(0, dash);
        }
        String label = v.getLocale().getDisplayName();
        if (!variant.isEmpty()) label += " · " + variant;
        if (v.isNetworkConnectionRequired()) label += " · online";
        return label;
    }

    /** Speaks `text` now (what was speaking stops), as utterance `id`. */
    void speak(String id, String text, String voiceName, String lang, float rate, float pitch, Fail fail) {
        whenReady(() -> {
            Voice voice = null;
            if (voiceName != null && !voiceName.isEmpty()) {
                try {
                    for (Voice v : tts.getVoices()) {
                        if (v.getName().equals(voiceName)) voice = v;
                    }
                } catch (Exception ignored) {}
            }
            if (voice != null) tts.setVoice(voice);
            else if (lang != null && !lang.isEmpty()) tts.setLanguage(Locale.forLanguageTag(lang));
            tts.setSpeechRate(rate);
            tts.setPitch(pitch);
            int result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, new Bundle(), id);
            if (result != TextToSpeech.SUCCESS) report(id, "error", TextToSpeech.ERROR);
        }, fail);
    }

    void stop() {
        synchronized (this) {
            if (status != 1 || tts == null) return;
        }
        tts.stop();
    }

    synchronized void shutdown() {
        if (tts != null) tts.shutdown();
        tts = null;
        status = 0;
    }

    interface Callback<T> {
        void with(T value);
    }
}
