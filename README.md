# interview-agent

AI Interview Agent SDK — a TypeScript library for real-time voice interviews powered by the Gemini Multimodal Live API.

Two subpath exports:

| Import | Target | Purpose |
|---|---|---|
| `interview-agent/server` | Node.js | WebSocket server that proxies audio between browser clients and Gemini |
| `interview-agent/react` | Browser | React hook + component for mic capture, audio playback, and live transcript |

---

## Installation (local workspace)

From a sibling project (e.g. `../core-api`):

```bash
npm install ../interview-agent
```

This creates a symlink in `node_modules/interview-agent` pointing at the local folder. **You must build first:**

```bash
cd interview-agent
npm install
npm run build
```

After any SDK change, re-run `npm run build` — consumers pick up the new `dist/` automatically.

---

## Quick Start

### Backend (Node.js)

```ts
import { InterviewServer } from 'interview-agent/server';

const server = new InterviewServer({
  geminiApiKey: process.env.GEMINI_API_KEY!,
  systemInstruction: 'You are a technical interviewer for a Senior Frontend role...',
  onSessionStart: (id) => console.log(`Session ${id} started`),
  onSessionEnd:   (id) => console.log(`Session ${id} ended`),
  onTranscript:   (id, entry) => console.log(`[${id}] ${entry.role}: ${entry.text}`),
});

// Option A: attach to your existing http.Server (Express, NestJS, etc.)
await server.attach(httpServer);

// Option B: standalone
await server.listen(3001);
```

### Frontend (React)

**Option A — Hook (full control):**

```tsx
import { useInterview } from 'interview-agent/react';

function InterviewRoom() {
  const { status, transcript, isUserSpeaking, start, stop } = useInterview({
    wsUrl: 'ws://localhost:3001/ws',
  });

  return (
    <div>
      <p>Status: {status}</p>
      <button onClick={start}>Start</button>
      <button onClick={stop}>Stop</button>
      {transcript.map((t, i) => (
        <p key={i}><b>{t.role}:</b> {t.text}</p>
      ))}
    </div>
  );
}
```

**Option B — Drop-in component:**

```tsx
import { InterviewPanel } from 'interview-agent/react';

function App() {
  return <InterviewPanel wsUrl="ws://localhost:3001/ws" />;
}
```

---

## API Reference

### `interview-agent/server`

#### `InterviewServer`

```ts
new InterviewServer(config: InterviewServerConfig)
```

| Config field | Type | Required | Description |
|---|---|---|---|
| `geminiApiKey` | `string` | ✅ | Gemini API key |
| `systemInstruction` | `string` | ✅ | System prompt sent to Gemini at session start |
| `model` | `string` | — | Override model ID (auto-detected if omitted) |
| `apiVersion` | `'v1alpha' \| 'v1beta'` | — | Override API version (auto-detected if omitted) |
| `path` | `string` | — | WebSocket path (default: `'/ws'`) |
| `onSessionStart` | `(sessionId: string) => void` | — | Called when a new session starts |
| `onSessionEnd` | `(sessionId: string) => void` | — | Called when a session ends |
| `onTranscript` | `(sessionId: string, entry: TranscriptEntry) => void` | — | Called for every transcript message |

**Methods:**

| Method | Description |
|---|---|
| `attach(httpServer)` | Attach WS server to an existing `http.Server`. Auto-detects model if not configured. |
| `listen(port)` | Start a standalone HTTP + WS server on the given port. |
| `detectModel()` | Manually trigger model auto-detection. Returns `{ model, apiVersion }` or `null`. |
| `close()` | Gracefully shut down the WS server. |

#### `detectLiveModel(apiKey)`

Queries the Gemini ListModels endpoint to find models supporting `bidiGenerateContent`. Returns `{ version, modelId }` or `null`.

#### `GeminiSession`

Low-level class managing a single bidirectional WebSocket to Gemini. Used internally by `InterviewServer`; exposed for advanced use cases.

---

### `interview-agent/react`

#### `useInterview(options)`

React hook that manages the full interview lifecycle.

```ts
const { status, transcript, isUserSpeaking, start, stop } = useInterview(options);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `wsUrl` | `string` | — | **Required.** WebSocket URL to interview server |
| `inputSampleRate` | `number` | `48000` | Preferred mic sample rate |
| `targetSampleRate` | `number` | `16000` | Outgoing PCM sample rate (Gemini expects 16 kHz) |
| `aiSampleRate` | `number` | `24000` | Incoming AI audio sample rate |
| `vadThreshold` | `number` | `0.001` | Energy threshold for voice activity detection |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `status` | `'idle' \| 'connecting' \| 'ready' \| 'active' \| 'error'` | Current session status |
| `transcript` | `TranscriptEntry[]` | Array of `{ role, text }` entries |
| `isUserSpeaking` | `boolean` | `true` when user's mic energy exceeds VAD threshold |
| `start()` | `() => Promise<void>` | Request mic permission, connect WS, begin piping audio |
| `stop()` | `() => void` | Disconnect everything, release mic |

#### `InterviewPanel`

Pre-built React component rendering a complete interview UI. Accepts all `useInterview` options plus an optional `style` prop.

```tsx
<InterviewPanel wsUrl="ws://localhost:3001/ws" />
```

#### Utility exports

| Export | Description |
|---|---|
| `AudioCapture` | Class wrapping `getUserMedia` + AudioWorklet for PCM mic capture |
| `AudioPlayback` | Gapless audio queue with interrupt support |
| `downsampleToInt16()` | Downsample Float32 → Int16 with linear interpolation |
| `decodeBase64PcmToFloat32()` | Decode base64 PCM Int16 → Float32Array |
| `computeEnergy()` | RMS energy of a Float32 audio chunk |

---

### `interview-agent` (root)

Re-exports all shared types:

```ts
import type {
  InterviewServerConfig,
  UseInterviewOptions,
  TranscriptEntry,
  InterviewStatus,
  ServerToClientMessage,
  ClientToServerMessage,
} from 'interview-agent';
```

---

## Wire Protocol

**Browser → Server:**
- **Binary frames:** Raw PCM Int16 LE, 16 kHz mono
- **JSON frames:** `{ type: 'interrupt' }`

**Server → Browser (JSON):**

| `type` | Payload | Description |
|---|---|---|
| `status` | `{ text: 'ready' \| 'gemini_disconnected' }` | Connection state changes |
| `audio` | `{ data: string }` | Base64 PCM Int16 LE, 24 kHz mono |
| `transcript` | `{ role, text }` | Real-time transcription |
| `turnComplete` | — | AI finished speaking |
| `error` | `{ text: string }` | Error message |

---

## Architecture

```
src/
├── shared/
│   └── types.ts          ← Wire protocol + config types (shared by both SDKs)
├── server/
│   ├── interview-server.ts  ← InterviewServer class (main server SDK entry)
│   ├── gemini-session.ts    ← Single Gemini WS session manager
│   └── detect-model.ts      ← Auto-detect model + API version
└── react/
    ├── use-interview.ts     ← useInterview() hook (main React SDK entry)
    ├── interview-panel.tsx  ← <InterviewPanel> drop-in component
    ├── audio-capture.ts     ← AudioWorklet mic capture
    ├── audio-playback.ts    ← Gapless audio queue with interrupts
    └── audio-utils.ts       ← Downsample, decode, VAD helpers
```

---

## Development

```bash
npm install        # install dependencies
npm run check      # type-check with tsc
npm run build      # build all three entry points with tsup
npm run dev        # watch mode (rebuild on change)
npm test           # run tests with vitest
```

### Demo app

```bash
npm run build
GEMINI_API_KEY=your_key node demo/server.js   # backend on :3001
cd demo && npm run dev                         # frontend on :5173
```
