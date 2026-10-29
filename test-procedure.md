# Real-Device Verification Procedure

Since the GitHub Actions CI environment does not have access to a physical Android device or an active AI API key, the final real-device verification requires manual testing on an Android phone.

Please follow these steps:

1. **Install the APK:** Download the \`app-debug.apk\` from the artifact of the \`android-apk\` GitHub workflow (or the local build) and install it on an Android device.

2. **Verify SQLite & Persistence:**
   - Open the App.
   - Go to Memory -> Providers.
   - Enter your credentials (e.g. OpenAI API key).
   - Press "Save".
   - **Expectation:** It should succeed and indicate the provider is verified in on-device storage. The active model state should update.
   - Close the app (swipe it away from the recent apps list).
   - Re-open the app.
   - **Expectation:** Your configured provider should still be listed as active. This proves the native SQLite database correctly persists data across app restarts.

3. **Verify Real AI Provider Flow (HTTP/Bridge):**
   - Go to Chat.
   - Type a message (e.g., "Hello, JARVIS").
   - **Expectation:** The app should send the request using the native HTTP bridge and display the response from the actual AI provider.

4. **Verify Microphone and Voice (Real device):**
   - Ensure the app has microphone permission.
   - Tap the microphone button in Chat and speak.
   - **Expectation:** The app should transcribe your speech using the Android speech recogniser and send it to the AI.
   - The AI's response should be spoken aloud via the Android TTS engine.

5. **Verify 3D Orb Rendering:**
   - **Expectation:** The Home screen should display a genuine 3D orb rendering smoothly in the Android WebView (using WebGL via react-three-fiber). It should not be a static image or a 2D glow.
