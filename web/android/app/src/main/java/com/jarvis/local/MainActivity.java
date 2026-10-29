package com.jarvis.local;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * Registers the JARVIS native capability bridge with Capacitor.
 *
 * Without this registration every phone action, native speech recognition and
 * native TTS call would fail with "not implemented" — the original port had an
 * empty MainActivity and therefore no native capabilities at all.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(JarvisNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
