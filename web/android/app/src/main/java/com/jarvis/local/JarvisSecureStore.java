package com.jarvis.local;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Android Keystore-backed credential vault.
 *
 * Provider API keys are encrypted with an AES-256-GCM key that never leaves the
 * TEE/StrongBox. Only ciphertext is written to SharedPreferences, and the
 * vault is excluded from auto-backup by the manifest's backup rules.
 *
 * This is protection at rest. A rooted device or a compromised runtime can
 * still observe a request while the app uses the key; the provider settings
 * screen states that limitation plainly.
 */
public final class JarvisSecureStore {

    private static final String PREF = "jarvis.secure.v1";
    private static final String ALIAS = "jarvis.vault.v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    private JarvisSecureStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) {
            return (SecretKey) store.getKey(ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    public static synchronized void put(Context context, String name, String value) throws Exception {
        if (name == null || name.isEmpty()) throw new IllegalArgumentException("empty key name");
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal((value == null ? "" : value).getBytes(StandardCharsets.UTF_8));
        String payload = Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP);
        // commit(), not apply(): the provider form reports success only after
        // the credential is actually on disk, so a kill right after Save cannot
        // lose the key while the config row survives. A false result is a real
        // failure (full disk / blocked storage) and must not be reported as a
        // successful save.
        if (!prefs(context).edit().putString(name, payload).commit()) {
            throw new java.io.IOException("Android could not commit the encrypted credential to disk.");
        }
    }

    /** Returns "" when absent or undecryptable (never throws a secret). */
    public static synchronized String get(Context context, String name) {
        String payload = prefs(context).getString(name, null);
        if (payload == null || payload.isEmpty()) return "";
        String[] parts = payload.split(":", 2);
        if (parts.length != 2) return "";
        try {
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] data = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(data), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    public static synchronized void remove(Context context, String name) {
        if (!prefs(context).edit().remove(name).commit()) {
            throw new IllegalStateException("Android could not remove the encrypted credential from disk.");
        }
    }

    public static synchronized boolean has(Context context, String name) {
        return !get(context, name).isEmpty();
    }
}
