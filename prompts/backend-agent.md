# Backend Agent Prompt — interview-agent/server SDK Integration

You are integrating the `interview-agent` server SDK into an existing NestJS backend (`core-api`). The SDK is installed as a local workspace dependency.

---

## Library Location & Install

The library lives at `../interview-agent` relative to `core-api`. Install it:

```bash
# From core-api/
npm install ../interview-agent
```

Build the SDK first if not already built:

```bash
cd ../interview-agent && npm run build && cd -
```

---

## Import Paths

```ts
// Server SDK — Node.js classes
import { InterviewServer, GeminiSession, detectLiveModel } from 'interview-agent/server';

// Shared types only
import type {
  InterviewServerConfig,
  TranscriptEntry,
  ServerToClientMessage,
  InterviewStatus,
} from 'interview-agent';
```

**IMPORTANT:** Always import server code from `'interview-agent/server'`, never from the root `'interview-agent'`. The root only exports types.

---

## Core API: `InterviewServer`

This is the main class. It manages a WebSocket server that proxies audio between browser clients and the Gemini Multimodal Live API.

### Constructor

```ts
const server = new InterviewServer({
  // REQUIRED
  geminiApiKey: string,       // Gemini API key — read from env
  systemInstruction: string,  // System prompt for the AI interviewer

  // OPTIONAL
  model?: string,             // Gemini model ID (auto-detected if omitted)
  apiVersion?: string,        // 'v1alpha' | 'v1beta' (auto-detected if omitted)
  path?: string,              // WebSocket path (default: '/ws')

  // LIFECYCLE CALLBACKS
  onSessionStart?: (sessionId: string) => void,
  onSessionEnd?: (sessionId: string) => void,
  onTranscript?: (sessionId: string, entry: TranscriptEntry) => void,
});
```

### Key Methods

| Method | Signature | Description |
|---|---|---|
| `attach` | `(httpServer: http.Server) => Promise<void>` | Attach to an existing http.Server. **Use this in NestJS.** |
| `listen` | `(port: number) => Promise<void>` | Start standalone server (for testing/simple cases) |
| `detectModel` | `() => Promise<{ model, apiVersion } \| null>` | Force re-detection of Gemini model |
| `close` | `() => void` | Gracefully shut down |

---

## NestJS Integration Pattern

Create a NestJS module that wraps `InterviewServer`:

```ts
// src/live-interviews/interview-agent.module.ts
import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { InterviewServer } from 'interview-agent/server';

@Module({})
export class InterviewAgentModule implements OnModuleInit, OnModuleDestroy {
  private interviewServer: InterviewServer;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    const systemInstruction = this.buildSystemPrompt();

    this.interviewServer = new InterviewServer({
      geminiApiKey: this.configService.getOrThrow('GEMINI_API_KEY'),
      systemInstruction,
      path: '/ws/interview',
      onSessionStart: (id) => console.log(`[interview] Session ${id} started`),
      onSessionEnd: (id) => console.log(`[interview] Session ${id} ended`),
      onTranscript: (id, entry) => {
        // Save transcript to DB, emit to dashboard, etc.
        console.log(`[interview][${id}] ${entry.role}: ${entry.text}`);
      },
    });

    // Get the underlying http.Server from NestJS
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();
    await this.interviewServer.attach(httpServer);
    console.log('Interview agent attached to NestJS server');
  }

  onModuleDestroy() {
    this.interviewServer?.close();
  }

  private buildSystemPrompt(): string {
    // Build dynamic system prompt based on job/interview context
    return `You are a technical interviewer...`;
  }
}
```

Then import it in your app module:

```ts
@Module({
  imports: [InterviewAgentModule, /* ... */],
})
export class AppModule {}
```

---

## Callback Data Shapes

### `TranscriptEntry`

```ts
interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}
```

### `onTranscript` callback

Called for every transcript fragment received from Gemini. Consecutive fragments from the same role arrive incrementally — the SDK does NOT merge them. Your callback may receive:

```
[session1] assistant: "Hello"
[session1] assistant: ", welcome to"
[session1] assistant: " the interview."
[session1] user: "Hi, thanks"
```

If you need full turns, accumulate text until the role switches.

---

## Data Flow

```
Browser Mic → AudioWorklet (48 kHz Float32)
  → downsample to Int16 16 kHz → binary WS frame
  → InterviewServer → base64-wrap → Gemini Live API

Gemini Live API → InterviewServer (parse serverContent)
  → JSON WS frame { type: 'audio' | 'transcript' | ... }
  → Browser → AudioPlayback (24 kHz) + Transcript UI
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Google AI Studio API key with Gemini Live API access |

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `1008 model not found` | Wrong model/version combo | Omit `model` and `apiVersion` — let auto-detect handle it |
| `1007 invalid argument` | Bad setup message shape | Ensure you're on latest SDK build (`npm run build`) |
| `1011 quota exceeded` | API key out of quota | Check billing at console.cloud.google.com |
| WS closes immediately | No audio modality | SDK handles this — don't override `generation_config` |

---

## Rules for the Agent

1. **Never hardcode the Gemini API key.** Always read from environment / ConfigService.
2. **Always use `attach(httpServer)`** in NestJS — never `listen()` which creates a separate server.
3. **The WS path must not conflict** with existing Socket.IO or other WS endpoints. Use a unique path like `'/ws/interview'`.
4. **Build the SDK before importing:** `cd ../interview-agent && npm run build`.
5. **System instructions are dynamic** — build them per-interview from job descriptions, candidate profiles, and evaluation criteria stored in the database.
6. **Store transcripts** via the `onTranscript` callback — this is the only server-side hook for conversation data.
