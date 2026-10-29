import { useCallback, useEffect, useRef, useState } from "react";
import { nextId, useStore, type ChatAttachment, type ChatEntry } from "../lib/store";
import { wsClient } from "../lib/ws";
import { backendConfigured } from "../lib/backend";
import { uploadImage } from "../lib/api";
import { usePrefs } from "../lib/prefs";
import { useBackendHealth, useVoiceStatus } from "./hooks";
import { voicePipeline } from "../lib/voicePipeline";
import { voiceStateLabel } from "../lib/voiceState";
import { planPhoneAction, type PhoneAction } from "../lib/actionPlan";
import { executePhoneAction, type ActionOutcome } from "../lib/actions";
import * as native from "../platform/native";
import { Sheet } from "./ui";
import type { ScreenProps } from "./types";

export default function ChatScreen({ onNavigate }: ScreenProps) {
  const chat = useStore((s) => s.chat);
  const connected = useStore((s) => s.connected);
  const orbState = useStore((s) => s.orbState);
  const voiceEnabled = useStore((s) => s.voiceEnabled);
  const setVoiceEnabled = useStore((s) => s.setVoiceEnabled);
  const pushChat = useStore((s) => s.pushChat);
  const addAttachment = useStore((s) => s.addAttachment);

  const voice = useVoiceStatus();
  const health = useBackendHealth(30_000);
  const micLanguage = usePrefs((s) => s.micLanguage);

  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PhoneAction | null>(null);
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [lastUserText, setLastUserText] = useState<string>("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoScroll = useRef(true);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  useEffect(() => {
    if (autoScroll.current) scrollToBottom();
  }, [chat, scrollToBottom]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (autoScroll.current) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  useEffect(() => {
    if (voice.error) setNotice(voice.error);
    if (voice.partial) setText(voice.partial);
  }, [voice.error, voice.partial]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56;
  };

  const sendToBackend = useCallback(
    (value: string, echo: boolean) => {
      if (!value) return;
      if (echo) {
        pushChat({ id: nextId(), role: "user", text: value, ts: Date.now() });
      }
      wsClient.chat(value);
      voicePipeline.markThinking();
      setLastUserText(value);
    },
    [pushChat],
  );

  const submit = useCallback(
    async (raw?: string) => {
      const value = (raw ?? text).trim();
      setNotice(null);
      if (!value && !attachment) return;
      if (!raw) setText("");
      if (voice.state === "LISTENING") void voicePipeline.stopListening();

      // 1) Supported local phone actions run on the device — never sent to the model.
      if (value && !attachment) {
        const action = planPhoneAction(value);
        if (action) {
          pushChat({ id: nextId(), role: "user", text: value, ts: Date.now() });
          setLastUserText(value);
          if (action.requiresApproval) {
            setPendingApproval(action);
            return;
          }
          const outcome = await executePhoneAction(action);
          reportOutcome(outcome);
          return;
        }
      }

      // 2) Everything else goes to the real backend.
      const reachable = health.status === "online" || (!backendConfigured() && health.status !== "unconfigured");
      if (!reachable || !connected) {
        pushChat({
          id: nextId(),
          role: "user",
          text: value || "(attachment)",
          ts: Date.now(),
        });
        pushChat({
          id: nextId(),
          role: "error",
          text:
            health.status === "unconfigured"
              ? "No JARVIS backend is configured, so this request was not sent. Open Settings → Backend, enter your server address and run the connection test."
              : "The JARVIS live channel is not connected. Nothing was sent. Check the backend address/network in Settings and use Reconnect.",
          ts: Date.now(),
        });
        return;
      }

      if (attachment) {
        addAttachment(attachment);
        setAttachment(null);
      }
      sendToBackend(value || "(attached image)", true);
    },
    [text, attachment, voice.state, health.status, connected, pushChat, addAttachment, sendToBackend],
  );

  const reportOutcome = (outcome: ActionOutcome) => {
    pushChat({
      id: nextId(),
      role: outcome.ok ? "assistant" : "error",
      text: outcome.message,
      ts: Date.now(),
    });
    if (outcome.ok && voiceEnabled) void voicePipeline.speak(outcome.message);
  };

  const approvePending = async () => {
    if (!pendingApproval) return;
    const action = pendingApproval;
    setPendingApproval(null);
    const outcome = await executePhoneAction(action, true);
    reportOutcome(outcome);
  };

  const toggleMic = async () => {
    if (voice.state === "LISTENING") {
      await voicePipeline.stopListening();
      return;
    }
    if (voice.state === "SPEAKING") {
      await voicePipeline.stopSpeaking();
      return;
    }
    setNotice(null);
    const started = await voicePipeline.startListening({
      language: micLanguage,
      onPartial: (partial) => setText(partial),
      onFinal: (final) => {
        setText("");
        void submit(final);
      },
    });
    if (!started.ok) setNotice(started.error ?? "Microphone could not start.");
  };

  const stopAll = async () => {
    wsClient.cancel();
    await voicePipeline.cancel();
    await voicePipeline.stopSpeaking();
    voicePipeline.markIdle();
    setNotice("Stopped.");
  };

  const copyMessage = async (entry: ChatEntry) => {
    if (await native.nativeAvailable().catch(() => false)) {
      try {
        await native.clipboardWrite(entry.text);
        setCopiedId(entry.id);
        setTimeout(() => setCopiedId(null), 1600);
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      await navigator.clipboard.writeText(entry.text);
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      setNotice("Clipboard access was blocked by the system.");
    }
  };

  const attachImage = async (source: "camera" | "gallery") => {
    setNotice(null);
    const available = await native.nativeAvailable().catch(() => false);
    if (!available) {
      setNotice("Camera/gallery capture is available in the Android app build.");
      return;
    }
    const result = await native.pickImage(source);
    if (result.cancelled) return;
    if (result.error || !result.dataUrl) {
      setNotice(result.error || "No image was captured.");
      return;
    }
    const name = result.name || `photo-${Date.now()}.jpg`;
    const file = dataUrlToFile(result.dataUrl, name, result.mime || "image/jpeg");
    if (health.status === "online") {
      try {
        const uploaded = await uploadImage(file);
        if (uploaded?.url) {
          setAttachment({ type: "image", name, url: uploaded.url, size: file.size, mime: result.mime });
          return;
        }
      } catch {
        /* fall back to inline data URL */
      }
    }
    setAttachment({ type: "image", name, data_url: result.dataUrl, size: file.size, mime: result.mime });
  };

  const lastAssistant = [...chat].reverse().find((m) => m.role === "assistant");
  const busy = orbState === "thinking" || voice.state === "THINKING" || voice.state === "SUBMITTING_REQUEST";
  const listening = voice.state === "LISTENING";
  const speaking = voice.state === "SPEAKING";

  return (
    <div className="m-main--chat flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pb-2" style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 12px)" }}>
        <div>
          <div className="m-eyebrow">Conversation</div>
          <div className="m-h2 mt-0.5">J.A.R.V.I.S.</div>
        </div>
        <div className="flex items-center gap-2">
          <span className="m-chip" data-tone={health.status === "online" && connected ? "ok" : health.status === "unconfigured" ? "warn" : "danger"}>
            <span className="m-dot" data-state={health.status === "online" ? (connected ? "online" : "checking") : health.status === "unconfigured" ? "idle" : "offline"} />
            {health.status === "online" ? (connected ? "online" : "reconnecting") : health.status === "unconfigured" ? "no backend" : "offline"}
          </span>
          <button
            type="button"
            className="m-icon-btn"
            aria-label={voiceEnabled ? "Mute spoken replies" : "Enable spoken replies"}
            data-active={voiceEnabled}
            onClick={() => setVoiceEnabled(!voiceEnabled)}
          >
            {voiceEnabled ? <SpeakerIcon /> : <SpeakerOffIcon />}
          </button>
        </div>
      </div>

      {health.status === "unconfigured" && (
        <button
          type="button"
          className="mx-4 mb-2 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-left"
          onClick={() => onNavigate("settings")}
        >
          <div className="m-row-title">Backend not configured</div>
          <div className="m-row-sub mt-1">Chat and the tool registry stay offline until you configure and test a JARVIS backend. Tap to set it up.</div>
        </button>
      )}

      <div ref={scrollRef} className="m-chat-scroll" onScroll={onScroll}>
        {chat.length === 0 ? (
          <div className="m-card m-card-pad mt-2">
            <div className="m-label">Ready</div>
            <p className="m-body mt-2">
              Speak or type a request. I can answer through your JARVIS backend, or perform supported phone actions directly:
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                "What is my battery level?",
                "Open Wi-Fi settings",
                "Open YouTube",
                "What is on my clipboard?",
                "Device info",
              ].map((sample) => (
                <button
                  key={sample}
                  type="button"
                  className="m-chip"
                  data-tone="accent"
                  onClick={() => void submit(sample)}
                >
                  {sample}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div ref={contentRef}>
            {chat.map((entry) => (
              <article className="m-msg" data-role={entry.role} key={entry.id}>
                <span className="m-msg-author">
                  {entry.role === "user" ? "You" : entry.role === "assistant" ? "J.A.R.V.I.S." : entry.role === "error" ? "Error" : "System"}
                </span>
                <div className="m-bubble">
                  {entry.attachments && entry.attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {entry.attachments.map((att, index) =>
                        att.type === "image" && (att.data_url || att.url) ? (
                          <img
                            key={index}
                            src={att.data_url || att.url}
                            alt={att.name}
                            className="h-20 w-20 rounded-xl border border-white/15 object-cover"
                          />
                        ) : (
                          <span key={index} className="m-chip">{att.name}</span>
                        ),
                      )}
                    </div>
                  )}
                  {renderRichText(entry.text)}
                  {entry.streaming && <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse bg-sky-300 align-middle" />}
                </div>
                {entry.role === "assistant" && entry.text && !entry.streaming && (
                  <div className="m-msg-tools">
                    <button type="button" className="m-msg-action" onClick={() => void copyMessage(entry)}>
                      {copiedId === entry.id ? "Copied" : "Copy"}
                    </button>
                    <button type="button" className="m-msg-action" onClick={() => void voicePipeline.speak(entry.text)}>
                      Speak
                    </button>
                    {entry.id === lastAssistant?.id && lastUserText && (
                      <button type="button" className="m-msg-action" onClick={() => sendToBackend(lastUserText, false)}>
                        Retry
                      </button>
                    )}
                  </div>
                )}
              </article>
            ))}
            {busy && (
              <div className="m-msg" data-role="assistant">
                <span className="m-msg-author">J.A.R.V.I.S.</span>
                <span className="m-typing" aria-label="Processing">
                  <i /><i /><i />
                </span>
              </div>
            )}
            <div className="h-2" />
          </div>
        )}
      </div>

      <div className="m-composer">
        {notice && (
          <div className="mb-2 flex items-start justify-between gap-2 rounded-xl border border-rose-300/25 bg-rose-400/10 px-3 py-2">
            <span className="m-small" style={{ color: "#fecdd3" }}>{notice}</span>
            <button type="button" className="m-btn" data-variant="ghost" data-size="sm" onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        )}

        {attachment && (
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-sky-300/20 bg-sky-300/5 p-2">
            {attachment.data_url || attachment.url ? (
              <img src={attachment.data_url || attachment.url} alt={attachment.name} className="h-12 w-12 rounded-lg object-cover" />
            ) : null}
            <span className="m-row-sub flex-1 truncate">{attachment.name}</span>
            <button type="button" className="m-btn" data-variant="ghost" data-size="sm" onClick={() => setAttachment(null)}>
              Remove
            </button>
          </div>
        )}

        <div className="m-composer-row">
          <button
            type="button"
            className="m-icon-btn"
            aria-label={listening ? "Stop listening" : speaking ? "Stop speaking" : "Start voice input"}
            data-active={listening || speaking}
            onClick={() => void toggleMic()}
            disabled={voice.state === "REQUESTING_PERMISSION" || voice.state === "TRANSCRIBING" || voice.state === "PROCESSING_AUDIO"}
          >
            {speaking ? <StopIcon /> : <MicIcon />}
          </button>
          <button
            type="button"
            className="m-icon-btn"
            aria-label="Attach a photo"
            onClick={() => void attachImage("camera")}
          >
            <CameraIcon />
          </button>
          <textarea
            ref={textareaRef}
            className="m-textarea"
            rows={1}
            value={text}
            placeholder={listening ? "Listening… speak now" : health.status === "online" ? "Ask JARVIS, or give a phone command…" : "Type a phone command (chat needs a backend)"}
            onChange={(event) => {
              setText(event.target.value);
              const el = event.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            onFocus={() => {
              setTimeout(() => scrollToBottom(true), 260);
            }}
          />
          {busy || listening ? (
            <button type="button" className="m-icon-btn" aria-label="Stop" data-active onClick={() => void stopAll()}>
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className="m-icon-btn"
              aria-label="Send"
              data-active={Boolean(text.trim() || attachment)}
              onClick={() => void submit()}
              disabled={!text.trim() && !attachment}
            >
              <SendIcon />
            </button>
          )}
        </div>
        <div className="m-composer-hint">
          {voice.state === "ERROR" && voice.error
            ? voice.error
            : `${voiceStateLabel(voice.state)}${voice.engine !== "none" ? ` · ${voice.engine} engine` : ""}${lastUserText ? " · Shift+Enter for a new line" : ""}`}
        </div>
      </div>

      <Sheet
        open={Boolean(pendingApproval)}
        title="Confirm action"
        onClose={() => setPendingApproval(null)}
      >
        <p className="m-body">{pendingApproval?.label}</p>
        <p className="m-small mt-2">
          This action has an external side effect. It runs only after you approve, and the real result is reported.
        </p>
        <div className="mt-4 flex gap-2">
          <button type="button" className="m-btn flex-1" onClick={() => setPendingApproval(null)}>
            Cancel
          </button>
          <button type="button" className="m-btn flex-1" data-variant="primary" onClick={() => void approvePending()}>
            Run action
          </button>
        </div>
      </Sheet>
    </div>
  );
}

function dataUrlToFile(dataUrl: string, name: string, mime: string): File {
  const [meta, data] = dataUrl.split(",");
  const match = /data:([^;]+)/.exec(meta || "");
  const type = match?.[1] || mime;
  const binary = atob(data || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type });
}

/** Minimal markdown: bold, inline code and links. */
function renderRichText(text: string) {
  const parts: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s<>()]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={key++} style={{ color: "#a5f3fc" }}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`")) {
      parts.push(
        <code key={key++} className="m-mono rounded bg-sky-300/10 px-1" style={{ fontSize: 13, color: "#a5f3fc" }}>
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      parts.push(
        <a key={key++} href={token} target="_blank" rel="noreferrer noopener" style={{ color: "#a5f3fc", textDecoration: "underline" }}>
          {token}
        </a>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function MicIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8.5 21h7" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
      <circle cx="12" cy="13.5" r="3.4" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12 20 4l-6 16-3-6-7-2Z" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14" />
    </svg>
  );
}

function SpeakerOffIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M16 9l5 6M21 9l-5 6" />
    </svg>
  );
}
