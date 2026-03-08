/**
 * InterviewComponent.jsx — "The Interview Room"
 *
 * Minimal React component that:
 *  1. Captures mic audio via getUserMedia + AudioWorklet.
 *  2. Downsamples to 16 kHz Int16 PCM and sends binary frames over WebSocket.
 *  3. Receives JSON frames from the server: AI audio (base64 PCM 24 kHz),
 *     transcripts, and status updates.
 *  4. Queues and plays back AI audio seamlessly.
 *  5. Supports interruption — stops AI playback when the user speaks.
 */

import React, { useState, useRef, useCallback, useEffect } from "react";

// ─── Constants ──────────────────────────────────────────────────────────────

const WS_URL = `ws://${window.location.hostname}:3001/ws`;
const INPUT_SAMPLE_RATE = 48000; // browser default; will be set dynamically
const TARGET_SAMPLE_RATE = 16000;
const AI_SAMPLE_RATE = 24000;

// ─── AudioWorklet processor inline code ─────────────────────────────────────
// We create the worklet from a Blob so no extra file is needed.

const WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    // Send a chunk every ~100ms worth of samples
    this._chunkSize = Math.floor(sampleRate * 0.1);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0]; // Float32, mono
    for (let i = 0; i < channelData.length; i++) {
      this._buffer.push(channelData[i]);
    }

    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.splice(0, this._chunkSize);
      this.port.postMessage({ pcmFloat32: new Float32Array(chunk), sampleRate });
    }

    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Downsample Float32 audio from srcRate to dstRate using linear interpolation,
 * then convert to Int16 LE for Gemini.
 */
function downsampleAndConvertToInt16(float32, srcRate, dstRate) {
  const ratio = srcRate / dstRate;
  const outLength = Math.floor(float32.length / ratio);
  const result = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, float32.length - 1);
    const frac = srcIdx - lo;
    const sample = float32[lo] * (1 - frac) + float32[hi] * frac;
    // Clamp to [-1, 1] then scale to Int16
    result[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
  }

  return result;
}

/**
 * Decode base64 PCM Int16 LE (24 kHz) into a Float32Array for Web Audio playback.
 */
function decodeBase64PcmToFloat32(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 0x7fff;
  }
  return float32;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function InterviewComponent() {
  const [status, setStatus] = useState("idle"); // idle | connecting | ready | active | error
  const [transcript, setTranscript] = useState([]); // {role, text}[]
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);

  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const workletNodeRef = useRef(null);
  const sourceNodeRef = useRef(null);

  // Audio playback queue
  const playbackQueueRef = useRef([]); // Float32Array[]
  const isPlayingRef = useRef(false);
  const currentSourceRef = useRef(null);

  // ─── Audio Playback Queue Logic ─────────────────────────────────────────

  const stopAIPlayback = useCallback(() => {
    // Immediately stop current AI audio (interruption support)
    if (currentSourceRef.current) {
      try {
        currentSourceRef.current.stop();
      } catch {
        // already stopped
      }
      currentSourceRef.current = null;
    }
    playbackQueueRef.current = [];
    isPlayingRef.current = false;
  }, []);

  const playNextChunk = useCallback(() => {
    if (playbackQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }

    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") return;

    isPlayingRef.current = true;

    // Concatenate all queued chunks into one buffer for gapless playback
    const chunks = playbackQueueRef.current.splice(0);
    let totalLength = 0;
    for (const c of chunks) totalLength += c.length;

    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    const buf = ctx.createBuffer(1, merged.length, AI_SAMPLE_RATE);
    buf.getChannelData(0).set(merged);

    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(ctx.destination);
    currentSourceRef.current = source;

    source.onended = () => {
      currentSourceRef.current = null;
      // Check if more chunks arrived while we were playing
      if (playbackQueueRef.current.length > 0) {
        playNextChunk();
      } else {
        isPlayingRef.current = false;
      }
    };

    source.start();
  }, []);

  const enqueueAudio = useCallback(
    (float32) => {
      playbackQueueRef.current.push(float32);
      if (!isPlayingRef.current) {
        playNextChunk();
      }
    },
    [playNextChunk]
  );

  // ─── WebSocket handlers ─────────────────────────────────────────────────

  const handleWsMessage = useCallback(
    (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "status":
          if (msg.text === "ready") {
            setStatus("ready");
          } else if (msg.text === "gemini_disconnected") {
            setStatus("error");
          }
          break;

        case "audio":
          // Base64-encoded PCM Int16 LE at 24 kHz
          if (msg.data) {
            const float32 = decodeBase64PcmToFloat32(msg.data);
            enqueueAudio(float32);
          }
          break;

        case "transcript":
          if (msg.text) {
            setTranscript((prev) => {
              // Merge consecutive messages from the same role
              if (prev.length > 0 && prev[prev.length - 1].role === msg.role) {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  text: updated[updated.length - 1].text + msg.text,
                };
                return updated;
              }
              return [...prev, { role: msg.role, text: msg.text }];
            });
          }
          break;

        case "turnComplete":
          // AI finished its turn
          break;

        case "error":
          console.error("Server error:", msg.text);
          setStatus("error");
          break;

        default:
          break;
      }
    },
    [enqueueAudio]
  );

  // ─── Voice Activity Detection (simple energy-based) ─────────────────────
  // Used to trigger interruption: when user speaks, stop AI audio.

  const handleUserAudioChunk = useCallback(
    (float32) => {
      let energy = 0;
      for (let i = 0; i < float32.length; i++) {
        energy += float32[i] * float32[i];
      }
      energy /= float32.length;

      const speaking = energy > 0.001; // threshold
      if (speaking && !isUserSpeaking) {
        setIsUserSpeaking(true);
        // Interrupt AI playback
        stopAIPlayback();
        // Signal server
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "interrupt" }));
        }
      } else if (!speaking && isUserSpeaking) {
        setIsUserSpeaking(false);
      }
    },
    [isUserSpeaking, stopAIPlayback]
  );

  // ─── Start Interview ───────────────────────────────────────────────────

  const startInterview = useCallback(async () => {
    setStatus("connecting");
    setTranscript([]);

    try {
      // 1. Create AudioContext
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: INPUT_SAMPLE_RATE,
      });
      audioCtxRef.current = audioCtx;

      // 2. Get mic stream
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: INPUT_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;

      // 3. Set up AudioWorklet
      const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const workletNode = new AudioWorkletNode(audioCtx, "pcm-capture-processor");
      workletNodeRef.current = workletNode;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;
      source.connect(workletNode);
      // Don't connect worklet to destination (we don't want to hear ourselves)

      // 4. Open WebSocket to our server
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("Connected to interview server");
        setStatus("active");
      };

      ws.onmessage = (event) => handleWsMessage(event);

      ws.onclose = () => {
        console.log("Disconnected from interview server");
        setStatus("idle");
      };

      ws.onerror = (err) => {
        console.error("WebSocket error:", err);
        setStatus("error");
      };

      // 5. Wire worklet output → downsample → send binary over WS
      workletNode.port.onmessage = (e) => {
        const { pcmFloat32, sampleRate: srcRate } = e.data;

        // Voice activity detection
        handleUserAudioChunk(pcmFloat32);

        // Downsample to 16 kHz Int16
        const int16 = downsampleAndConvertToInt16(pcmFloat32, srcRate, TARGET_SAMPLE_RATE);

        // Send binary frame
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(int16.buffer);
        }
      };

      setStatus("active");
    } catch (err) {
      console.error("Failed to start interview:", err);
      setStatus("error");
    }
  }, [handleWsMessage, handleUserAudioChunk]);

  // ─── Stop Interview ───────────────────────────────────────────────────

  const stopInterview = useCallback(() => {
    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    // Stop playback
    stopAIPlayback();

    // Disconnect audio nodes
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    // Stop mic stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    // Close audio context
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }

    setStatus("idle");
    setIsUserSpeaking(false);
  }, [stopAIPlayback]);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopInterview();
  }, [stopInterview]);

  // ─── Render ─────────────────────────────────────────────────────────────

  const statusLabel = {
    idle: "⏸ Idle",
    connecting: "🔄 Connecting…",
    ready: "✅ Ready",
    active: "🎙 Active",
    error: "❌ Error",
  };

  return (
    <div style={{ fontFamily: "monospace", maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
      <h1 style={{ fontSize: "1.4rem" }}>AI Interview Room</h1>

      {/* Status */}
      <div style={{ marginBottom: "1rem" }}>
        <strong>Status: </strong>
        <span>{statusLabel[status] || status}</span>
        {isUserSpeaking && <span style={{ marginLeft: 12, color: "#c00" }}>🔴 You are speaking</span>}
      </div>

      {/* Controls */}
      <div style={{ marginBottom: "1.5rem" }}>
        {status === "idle" || status === "error" ? (
          <button onClick={startInterview} style={btnStyle}>
            ▶ Start Interview
          </button>
        ) : (
          <button onClick={stopInterview} style={{ ...btnStyle, background: "#c00" }}>
            ■ Stop Interview
          </button>
        )}
      </div>

      {/* Live Transcript */}
      <div>
        <h2 style={{ fontSize: "1.1rem" }}>Live Transcript</h2>
        <div
          style={{
            border: "1px solid #444",
            borderRadius: 4,
            padding: "0.75rem",
            height: 400,
            overflowY: "auto",
            background: "#1a1a1a",
            color: "#eee",
          }}
        >
          {transcript.length === 0 && (
            <p style={{ color: "#777" }}>Transcript will appear here once the interview starts…</p>
          )}
          {transcript.map((entry, i) => (
            <div key={i} style={{ marginBottom: "0.5rem" }}>
              <strong style={{ color: entry.role === "user" ? "#4fc3f7" : "#aed581" }}>
                {entry.role === "user" ? "You" : "Interviewer"}:
              </strong>{" "}
              <span>{entry.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Minimal button style ───────────────────────────────────────────────────

const btnStyle = {
  padding: "0.6rem 1.4rem",
  fontSize: "1rem",
  fontFamily: "monospace",
  background: "#1976d2",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
};
