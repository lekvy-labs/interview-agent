# Frontend Agent Prompt — interview-agent/react SDK Integration

You are integrating the `interview-agent` React SDK into a frontend application. The SDK is installed as a local workspace dependency from `../interview-agent`.

---

## Library Location & Install

```bash
# From your React project root
npm install ../interview-agent
```

Build the SDK first if not already built:

```bash
cd ../interview-agent && npm run build && cd -
```

---

## Import Paths

```ts
// React SDK — hook, component, and utilities
import { useInterview, InterviewPanel, AudioCapture, AudioPlayback } from 'interview-agent/react';

// Types only (from root export)
import type {
  UseInterviewOptions,
  TranscriptEntry,
  InterviewStatus,
} from 'interview-agent';
```

**IMPORTANT:** Always import React code from `'interview-agent/react'`, never from the root. The root only exports types.

---

## Option A: `useInterview()` Hook (Recommended for Custom UI)

Full control over rendering. The hook manages mic capture, WebSocket, audio playback, VAD, and interruption internally.

```tsx
import { useInterview } from 'interview-agent/react';

function InterviewRoom({ wsUrl }: { wsUrl: string }) {
  const { status, transcript, isUserSpeaking, start, stop } = useInterview({ wsUrl });

  return (
    <div>
      <p>Status: {status}</p>
      {isUserSpeaking && <span>🔴 Speaking</span>}

      {status === 'idle' || status === 'error' ? (
        <button onClick={start}>Start Interview</button>
      ) : (
        <button onClick={stop}>Stop Interview</button>
      )}

      <div>
        {transcript.map((entry, i) => (
          <div key={i}>
            <strong>{entry.role === 'user' ? 'You' : 'Interviewer'}:</strong> {entry.text}
          </div>
        ))}
      </div>
    </div>
  );
}
```

### Hook Return Values

| Field | Type | Description |
|---|---|---|
| `status` | `InterviewStatus` | `'idle' \| 'connecting' \| 'ready' \| 'active' \| 'error'` |
| `transcript` | `TranscriptEntry[]` | Array of `{ role: 'user' \| 'assistant', text: string }` |
| `isUserSpeaking` | `boolean` | `true` when mic energy exceeds VAD threshold |
| `start()` | `() => Promise<void>` | Requests mic permission, connects WS, starts streaming audio |
| `stop()` | `() => void` | Closes WS, stops mic, clears audio queue |

### Hook Options

```ts
useInterview({
  wsUrl: 'ws://localhost:3001/ws',  // REQUIRED — WebSocket URL to interview server

  // All below are optional with sensible defaults:
  inputSampleRate: 48000,   // Mic sample rate hint
  targetSampleRate: 16000,  // Outgoing PCM rate (Gemini expects 16 kHz)
  aiSampleRate: 24000,      // Incoming AI audio rate
  vadThreshold: 0.001,      // Energy threshold for voice activity detection
});
```

---

## Option B: `<InterviewPanel>` Component (Drop-in, No Custom UI Needed)

Pre-built interview room UI with status indicator, start/stop button, and live transcript.

```tsx
import { InterviewPanel } from 'interview-agent/react';

function App() {
  return (
    <InterviewPanel
      wsUrl={`ws://${window.location.hostname}:3001/ws`}
      style={{ maxWidth: 800 }}
    />
  );
}
```

Accepts all `useInterview` options plus an optional `style` prop for the root container.

---

## Status Lifecycle

```
idle → connecting → active → idle
                  ↘ error → idle (after stop + start)
```

| Status | Meaning |
|---|---|
| `idle` | No session. Mic off, WS disconnected. |
| `connecting` | `start()` called, requesting mic + opening WS. |
| `ready` | Server confirmed Gemini session is set up. Transitions to `active` almost immediately. |
| `active` | Audio streaming bidirectionally. Interview in progress. |
| `error` | WS error or Gemini disconnected. Call `stop()` then `start()` to retry. |

---

## Transcript Data Shape

```ts
interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}
```

The hook automatically **merges consecutive fragments** from the same role into a single entry. So `transcript` always contains clean, concatenated turns.

---

## Interruption Behavior

When the user starts speaking (`isUserSpeaking` becomes `true`):
1. AI audio playback stops immediately (mid-word if needed)
2. An `{ type: 'interrupt' }` message is sent to the server
3. Gemini's VAD also detects the interruption server-side

No special code is needed — the hook handles this automatically.

---

## Building the WebSocket URL

The WS URL must point to the interview server's WebSocket endpoint. Common patterns:

```ts
// Development — server on different port
const wsUrl = 'ws://localhost:3001/ws';

// Production — same origin, behind reverse proxy
const wsUrl = `wss://${window.location.host}/ws/interview`;

// Dynamic from env
const wsUrl = import.meta.env.VITE_INTERVIEW_WS_URL;
```

---

## Advanced: Using Utility Classes Directly

For advanced use cases (custom audio processing, non-React frameworks):

```ts
import { AudioCapture, AudioPlayback, downsampleToInt16, decodeBase64PcmToFloat32, computeEnergy } from 'interview-agent/react';

// Manual mic capture
const capture = new AudioCapture();
await capture.start({
  onChunk: (pcmFloat32, sampleRate) => {
    const int16 = downsampleToInt16(pcmFloat32, sampleRate, 16000);
    ws.send(int16.buffer);
  },
});

// Manual audio playback
const playback = new AudioPlayback(24000);
playback.setContext(capture.context!);
playback.enqueue(decodeBase64PcmToFloat32(base64Data));
playback.stop(); // interrupt
```

---

## Browser Requirements

- **HTTPS or localhost** — `getUserMedia` requires a secure context
- **Microphone permission** — user must grant access when prompted
- **AudioWorklet support** — all modern browsers (Chrome 66+, Firefox 76+, Safari 14.1+)
- **React 18+** as a peer dependency

---

## Rules for the Agent

1. **Always use `'interview-agent/react'`** as the import path — never import from the root or from `'interview-agent/server'` in frontend code.
2. **`wsUrl` is required** — the hook will not work without it. Never hardcode `localhost` in production builds; use environment variables.
3. **Call `stop()` on unmount** — the hook does this automatically via `useEffect` cleanup, but if you conditionally render the component, ensure cleanup happens.
4. **Don't wrap `start()` in `useEffect`** — it should be triggered by user interaction (button click) because browsers require a user gesture to enable the mic and AudioContext.
5. **The transcript array is immutable** — React state updates produce new arrays. Safe for `useMemo`, `React.memo`, etc.
6. **For custom UI, use `useInterview`** — only use `<InterviewPanel>` for quick prototyping or when no custom design is needed.
7. **Don't create multiple `useInterview` instances** on the same page — each one opens its own mic + WS connection.
