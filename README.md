# @lekvylabs/interview-agent

AI Interview Agent SDK — a TypeScript library for real-time voice interviews powered by the Gemini Multimodal Live API.

**This SDK is used internally for the Interviewer agent of Lekvy Backend.**

Two subpath exports:

| Import | Target | Purpose |
|---|---|---|
| `@lekvylabs/interview-agent/server` | Node.js | WebSocket server that proxies audio between browser clients and Gemini |
| `@lekvylabs/interview-agent/react` | Browser | React hook + component for mic capture, audio playback, and live transcript |

---

## Installation (local workspace)

From a sibling project (e.g. `../core-api`):

```bash
npm install ../interview-agent
```

This creates a symlink in `node_modules/@lekvylabs/interview-agent` pointing at the local folder. **You must build first:**

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
import { InterviewServer } from '@lekvylabs/interview-agent/server';

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

The server registers three built-in tools by default: `conclude_interview`, `start_code_sharing`, and `end_code_sharing`. Override via `config.tools`.

### Frontend (React)

**Option A — WebSocket hook (direct to InterviewServer):**

```tsx
import { useInterview } from '@lekvylabs/interview-agent/react';

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

**Option B — Socket.IO hook (Lekvy Backend gateway):**

For the NestJS live-interview gateway, use `useLiveInterview` with `serverUrl`, `interviewId`, and `token`. Supports code sharing, interviewer activity, and session lifecycle.

```tsx
import { useLiveInterview } from '@lekvylabs/interview-agent/react';

function LiveInterviewRoom() {
  const { status, transcript, codeSharingActive, sharedCode, start, stop } = useLiveInterview({
    serverUrl: 'http://localhost:3000',
    interviewId: 'interview_123',
    token: 'jwt-or-session-token',
  });
  // ...
}
```

**Option C — Drop-in component:**

```tsx
import { InterviewPanel } from '@lekvylabs/interview-agent/react';

function App() {
  return <InterviewPanel wsUrl="ws://localhost:3001/ws" />;
}
```

---

## API Reference

### `@lekvylabs/interview-agent/server`

#### `InterviewServer`

```ts
new InterviewServer(config: InterviewServerConfig)
```

| Config field | Type | Required | Description |
|---|---|---|---|
| `geminiApiKey` | `string` | ✅ | Gemini API key |
| `systemInstruction` | `string` | — | System prompt sent to Gemini at session start |
| `model` | `string` | — | Override model ID (default: `gemini-2.5-flash-native-audio-preview-12-2025`) |
| `tools` | `FunctionDeclaration[]` | — | Tool declarations for Gemini. Defaults to `conclude_interview`, `start_code_sharing`, `end_code_sharing`. Set `[]` to disable. |
| `voiceActivityDetection` | `VoiceActivityDetectionConfig` | — | VAD sensitivity and silence duration |
| `triggerMessage` | `string \| false` | — | Message sent after session opens to trigger greeting. Default: `'START_INTERVIEW'`. Set `false` to disable. |
| `injectElapsedTime` | `boolean` | — | Inject `[elapsed: Xs]` context after each AI turn (default: `true`) |
| `maxReconnectAttempts` | `number` | — | Max reconnect attempts on Gemini disconnect (default: `3`) |
| `reconnectDelayMs` | `number` | — | Delay between reconnect attempts (default: `2000`) |
| `path` | `string` | — | WebSocket path (default: `'/ws'`) |
| `onSessionStart` | `(sessionId: string) => void` | — | Called when a new session starts |
| `onSessionEnd` | `(sessionId: string) => void` | — | Called when a session ends |
| `onTranscript` | `(sessionId: string, entry: TranscriptEntry) => void` | — | Called for every transcript message |
| `onToolCall` | `(sessionId: string, name: string, args: Record<string, unknown>) => void` | — | Called when Gemini invokes a tool |
| `onInterviewConcluded` | `(sessionId: string) => void` | — | Called when AI calls `conclude_interview` |
| `onCodeSharingStarted` | `(sessionId: string) => void` | — | Called when AI calls `start_code_sharing` |
| `onCodeSharingEnded` | `(sessionId: string) => void` | — | Called when AI calls `end_code_sharing` |

**Methods:**

| Method | Description |
|---|---|
| `attach(httpServer)` | Attach WS server to an existing `http.Server` |
| `listen(port)` | Start a standalone HTTP + WS server on the given port |
| `close()` | Gracefully shut down all sessions and the WS server |

#### `GeminiSession`

Low-level class managing a single bidirectional WebSocket to Gemini. Handles audio streaming, transcription, tool calls, reconnection, elapsed-time injection, and interruption gating. Used internally by `InterviewServer`; exposed for advanced use cases.

#### `DEFAULT_TOOLS`, `Modality`, `Type`, `StartSensitivity`, `EndSensitivity`, `FunctionDeclaration`

Re-exported from shared types and `@google/genai` for tool configuration.

---

### `@lekvylabs/interview-agent/react`

#### `useInterview(options)`

React hook for direct WebSocket connection to `InterviewServer`. Manages mic capture, audio playback, and live transcript.

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

#### `useLiveInterview(options)`

Socket.IO hook for the Lekvy Backend live-interview gateway. Supports code sharing, interviewer activity, and full session lifecycle.

```ts
const {
  status,
  transcript,
  isUserSpeaking,
  interviewerActivity,
  isAssistantSpeaking,
  codeSharingActive,
  sharedCode,
  start,
  stop,
} = useLiveInterview(options);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `serverUrl` | `string` | — | **Required.** Base URL for the Socket.IO server |
| `interviewId` | `string` | — | **Required.** Interview/session identifier sent as a query param |
| `token` | `string` | — | **Required.** Bearer token sent through Socket.IO auth |
| `namespace` | `string` | `'/live-interview'` | Socket.IO namespace |
| `targetSampleRate` | `number` | `16000` | Outgoing PCM sample rate |
| `aiSampleRate` | `number` | `24000` | Incoming AI audio sample rate |
| `vadThreshold` | `number` | `0.001` | Energy threshold for local user VAD |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `status` | `'idle' \| 'connecting' \| 'active' \| 'error'` | Current live session status |
| `transcript` | `TranscriptEntry[]` | Array of `{ role, text }` entries |
| `isUserSpeaking` | `boolean` | `true` when the local mic energy exceeds the VAD threshold |
| `interviewerActivity` | `'speaking' \| 'listening' \| 'thinking'` | Interviewer activity from socket events, with fallback to audio lifecycle |
| `isAssistantSpeaking` | `boolean` | Convenience alias for `interviewerActivity === 'speaking'` |
| `codeSharingActive` | `boolean` | `true` while the interviewer has active code sharing enabled |
| `sharedCode` | `{ code: string; language?: string; title?: string } \| null` | Latest code-sharing payload from the server, or `null` when inactive |
| `start()` | `() => Promise<void>` | Connect Socket.IO, request mic permission, and begin piping audio |
| `stop()` | `() => void` | End the live session and release resources |

**Example:**

```tsx
import { useLiveInterview } from '@lekvylabs/interview-agent/react';

function LiveInterviewRoom() {
  const {
    status,
    transcript,
    interviewerActivity,
    isAssistantSpeaking,
    codeSharingActive,
    sharedCode,
    start,
    stop,
  } = useLiveInterview({
    serverUrl: 'http://localhost:3000',
    interviewId: 'interview_123',
    token: 'jwt-or-session-token',
  });

  return (
    <div>
      <p>Status: {status}</p>
      <p>Interviewer: {interviewerActivity}</p>
      <p>Speaking: {String(isAssistantSpeaking)}</p>
      <p>Code sharing: {String(codeSharingActive)}</p>
      {sharedCode && (
        <>
          <p>Shared title: {sharedCode.title ?? 'Untitled'}</p>
          <pre>{sharedCode.code}</pre>
        </>
      )}
      <button onClick={start}>Start</button>
      <button onClick={stop}>Stop</button>
      {transcript.map((entry, i) => (
        <p key={i}><b>{entry.role}:</b> {entry.text}</p>
      ))}
    </div>
  );
}
```

#### `InterviewPanel`

Pre-built React component rendering a complete interview UI. Uses `useInterview` internally. Accepts all `useInterview` options plus an optional `style` prop.

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

### `@lekvylabs/interview-agent` (root)

Re-exports all shared types:

```ts
import type {
  InterviewServerConfig,
  UseInterviewOptions,
  TranscriptEntry,
  InterviewStatus,
  ServerToClientMessage,
  ClientToServerMessage,
} from '@lekvylabs/interview-agent';
```

---

## Wire Protocol

### WebSocket (useInterview ↔ InterviewServer)

**Browser → Server:**
- **Binary frames:** Raw PCM Int16 LE, 16 kHz mono
- **JSON frames:** `{ type: 'interrupt' }` | `{ type: 'end-session' }`

**Server → Browser (JSON):**

| `type` | Payload | Description |
|---|---|---|
| `status` | `{ text: 'ready' \| 'gemini_disconnected' }` | Connection state changes |
| `audio` | `{ data: string, mimeType?: string }` | Base64 PCM audio (24 kHz mono) |
| `transcript` | `{ role, text, turnComplete?: boolean }` | Real-time transcription |
| `turnComplete` | — | AI finished speaking |
| `interrupted` | — | AI was cut off; stop playback |
| `reconnecting` | `{ attempt, maxAttempts }` | Transparent reconnect in progress |
| `session-ended` | — | Session terminated |
| `interview-concluded` | — | AI ended interview via tool |
| `code-sharing-started` | — | AI began code sharing |
| `code-sharing-ended` | — | AI concluded code sharing |
| `tool-call` | `{ name, args }` | Gemini invoked a tool |
| `error` | `{ text: string }` | Error message |

### Live Socket.IO Events (useLiveInterview ↔ Lekvy Backend)

For `useLiveInterview()` on the `/live-interview` namespace:

**Client → Server:**
- `audio-chunk` → `{ audio: string }` (base64 16 kHz Int16 PCM)
- `end-session` → no payload

**Server → Client:**
- `session-ready` → no payload
- `audio-response` → `{ audio: string }`
- `transcript` → `{ role: 'user' | 'model', text: string }`
- `interviewer-activity` → `{ state: 'speaking' | 'listening' | 'thinking' }` (optional)
- `code-sharing-content` → `{ code: string, language?: string, title?: string }`
- `interrupted` → no payload
- `code-sharing-started` → no payload
- `code-sharing-ended` → no payload
- `session-ended` → no payload
- `interview-concluded` → no payload
- `error` → `{ message: string }`

---

## Architecture

```
src/
├── shared/
│   └── types.ts             ← Wire protocol + config types (shared by both SDKs)
├── server/
│   ├── interview-server.ts  ← InterviewServer class (main server SDK entry)
│   └── gemini-session.ts    ← Single Gemini Live session (audio, tools, reconnection)
└── react/
    ├── use-interview.ts     ← useInterview() hook (WebSocket → InterviewServer)
    ├── use-live-interview.ts← useLiveInterview() hook (Socket.IO → Lekvy Backend)
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
