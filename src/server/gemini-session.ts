/**
 * GeminiSession — manages a single Gemini Live session using the
 * @google/genai SDK. Handles audio streaming, transcription, tool calls,
 * reconnection, elapsed-time injection, and interruption gating.
 *
 * This is a 1:1 port of the handleGeminiMessage / openGeminiSession /
 * scheduleReconnect / finalizeSession logic from the NestJS gateway.
 */

import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
  type FunctionDeclaration,
  type LiveServerMessage,
  type Session,
} from '@google/genai';
import type { TranscriptEntry } from '../shared/types.js';
import { DEFAULTS, DEFAULT_TOOLS } from '../shared/types.js';
import type { StartSensitivityLevel, EndSensitivityLevel } from '../shared/types.js';

// ─── Config ─────────────────────────────────────────────────────────────────

export interface GeminiSessionConfig {
  apiKey: string;
  model?: string;
  systemInstruction?: string;
  sessionId: string;

  /**
   * Tool (function) declarations exposed to Gemini.
   * Defaults to the 3 built-in tools (conclude_interview, start_code_sharing,
   * end_code_sharing). Set to `[]` to disable all tools.
   */
  tools?: FunctionDeclaration[];

  voiceActivityDetection?: {
    startOfSpeechSensitivity?: StartSensitivityLevel;
    endOfSpeechSensitivity?: EndSensitivityLevel;
    silenceDurationMs?: number;
  };

  triggerMessage?: string | false;
  injectElapsedTime?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelayMs?: number;

  // ─── Callbacks ──────────────────────────────────────────────────────────

  onReady: () => void;
  onAudio: (base64: string, mimeType: string) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  /** Fires for every tool call (built-in and custom). */
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  /** Fires when AI calls conclude_interview — session is auto-closed after this. */
  onInterviewConcluded: () => void;
  /** Fires when AI calls start_code_sharing. */
  onCodeSharingStarted: () => void;
  /** Fires when AI calls end_code_sharing. */
  onCodeSharingEnded: () => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
  onReconnecting: (attempt: number, maxAttempts: number) => void;
  onClose: () => void;
  onError: (err: Error) => void;
}

// ─── Sensitivity mapping ────────────────────────────────────────────────────

const START_SENSITIVITY_MAP: Record<StartSensitivityLevel, StartSensitivity> = {
  low: StartSensitivity.START_SENSITIVITY_LOW,
  high: StartSensitivity.START_SENSITIVITY_HIGH,
};

const END_SENSITIVITY_MAP: Record<EndSensitivityLevel, EndSensitivity> = {
  low: EndSensitivity.END_SENSITIVITY_LOW,
  high: EndSensitivity.END_SENSITIVITY_HIGH,
};

// ─── Session class ──────────────────────────────────────────────────────────

export class GeminiSession {
  private readonly genAI: GoogleGenAI;
  private readonly config: GeminiSessionConfig;
  private session: Session | null = null;

  private pendingAiText = '';
  private isAiSpeaking = false;
  private sessionStartMs = Date.now();
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  private _ready = false;

  constructor(config: GeminiSessionConfig) {
    this.config = config;
    this.genAI = new GoogleGenAI({ apiKey: config.apiKey });
  }

  get isReady(): boolean {
    return this._ready;
  }

  /** Open the Gemini Live session. Call once after construction. */
  async connect(): Promise<void> {
    this.sessionStartMs = Date.now();
    this.session = await this.openSession();
  }

  /** Send raw PCM audio (Int16 LE, 16 kHz) to Gemini as base64. */
  sendAudio(pcmBase64: string): void {
    if (!this._ready || !this.session) return;

    try {
      this.session.sendRealtimeInput({
        audio: { data: pcmBase64, mimeType: 'audio/pcm;rate=16000' },
      });
    } catch (err: any) {
      this.config.onError(new Error(`sendRealtimeInput: ${err?.message}`));
    }
  }

  /** Inject arbitrary text context into the Gemini session. */
  sendClientContent(text: string, turnComplete = false): void {
    if (!this.session) return;

    try {
      this.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete,
      });
    } catch (err: any) {
      this.config.onError(new Error(`sendClientContent: ${err?.message}`));
    }
  }

  /** Gracefully close the session. Marks it as intentionally closed. */
  close(): void {
    this.intentionallyClosed = true;
    this._ready = false;
    try {
      this.session?.close();
    } catch {
      // best-effort
    }
  }

  // ─── Gemini live session factory ────────────────────────────────────────────

  private async openSession(): Promise<Session> {
    const { config } = this;
    const model = config.model ?? DEFAULTS.MODEL;
    const vad = config.voiceActivityDetection;

    const tools = config.tools ?? DEFAULT_TOOLS;
    const toolDeclarations = tools.length
      ? [{ functionDeclarations: tools }]
      : undefined;

    return this.genAI.live.connect({
      model,
      config: {
        systemInstruction: config.systemInstruction,
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity:
              START_SENSITIVITY_MAP[vad?.startOfSpeechSensitivity ?? 'low'],
            endOfSpeechSensitivity:
              END_SENSITIVITY_MAP[vad?.endOfSpeechSensitivity ?? 'low'],
            silenceDurationMs: vad?.silenceDurationMs ?? DEFAULTS.SILENCE_DURATION_MS,
          },
        },
        tools: toolDeclarations,
      },
      callbacks: {
        onopen: () => {
          this._ready = true;
          this.reconnectAttempts = 0;
          this.config.onReady();
        },
        onmessage: (message: LiveServerMessage) => {
          this.handleMessage(message);
        },
        onerror: (e: any) => {
          this.config.onError(
            new Error(e?.message ?? JSON.stringify(e)),
          );
        },
        onclose: (_e: any) => {
          this._ready = false;

          if (this.intentionallyClosed) {
            this.config.onClose();
            return;
          }

          this.scheduleReconnect();
        },
      },
    });
  }

  // ─── Reconnect logic ───────────────────────────────────────────────────────

  private scheduleReconnect(): void {
    const maxAttempts = this.config.maxReconnectAttempts ?? DEFAULTS.MAX_RECONNECT_ATTEMPTS;
    const delayMs = this.config.reconnectDelayMs ?? DEFAULTS.RECONNECT_DELAY_MS;

    if (this.reconnectAttempts >= maxAttempts) {
      this.config.onClose();
      return;
    }

    this.reconnectAttempts++;
    const attempt = this.reconnectAttempts;
    this.config.onReconnecting(attempt, maxAttempts);

    setTimeout(async () => {
      if (this.intentionallyClosed) return;

      try {
        this.session = await this.openSession();

        const elapsedSeconds = Math.floor((Date.now() - this.sessionStartMs) / 1000);
        try {
          this.session.sendClientContent({
            turns: [
              {
                role: 'user',
                parts: [
                  {
                    text: `[RECONNECTED after brief interruption] [elapsed: ${elapsedSeconds}s] Please continue the interview from where we left off.`,
                  },
                ],
              },
            ],
            turnComplete: false,
          });
        } catch {
          // best-effort context injection
        }
      } catch {
        this.scheduleReconnect();
      }
    }, delayMs);
  }

  // ─── Gemini message handler ─────────────────────────────────────────────────

  private handleMessage(message: LiveServerMessage): void {
    // ── Tool calls ──────────────────────────────────────────────────────────
    const toolCall = (message as any)?.toolCall;
    if (toolCall) {
      const functionCalls = (toolCall.functionCalls as any[]) ?? [];

      const hasConclude = functionCalls.some((fc) => fc.name === 'conclude_interview');
      const hasStartCodeSharing = functionCalls.some((fc) => fc.name === 'start_code_sharing');
      const hasEndCodeSharing = functionCalls.some((fc) => fc.name === 'end_code_sharing');

      // Fire generic onToolCall for every function call
      for (const fc of functionCalls) {
        this.config.onToolCall(fc.name, fc.args ?? {});
      }

      // conclude_interview → close the session
      if (hasConclude) {
        this.config.onInterviewConcluded();
        this.close();
        return;
      }

      // start_code_sharing / end_code_sharing → dedicated events
      if (hasStartCodeSharing) {
        this.config.onCodeSharingStarted();
      }
      if (hasEndCodeSharing) {
        this.config.onCodeSharingEnded();
      }
    }

    // ── Server content ──────────────────────────────────────────────────────
    const serverContent = (message as any)?.serverContent;
    if (!serverContent) return;

    // ── Audio response chunks → relay to consumer ──
    const parts = serverContent?.modelTurn?.parts ?? [];
    for (const part of parts) {
      if (part?.inlineData?.mimeType?.startsWith('audio/')) {
        if (!this.isAiSpeaking) this.isAiSpeaking = true;
        this.config.onAudio(part.inlineData.data, part.inlineData.mimeType);
      }
    }

    // ── User speech transcription ──
    const inputTranscription = serverContent?.inputTranscription;
    if (inputTranscription?.text) {
      this.config.onTranscript({ role: 'user', text: inputTranscription.text });
    }

    // ── AI output transcription (accumulate until turn complete) ──
    const outputTranscription = serverContent?.outputTranscription;
    if (outputTranscription?.text) {
      this.pendingAiText += outputTranscription.text;
    }

    // ── Turn complete → flush AI transcript + inject elapsed time ──
    if (serverContent?.turnComplete) {
      this.isAiSpeaking = false;

      if (this.pendingAiText.trim()) {
        const text = this.pendingAiText.trim();
        this.pendingAiText = '';
        this.config.onTranscript({ role: 'assistant', text, turnComplete: true });
      }

      this.config.onTurnComplete();

      // Inject elapsed interview time so the AI can pace stages.
      // turnComplete: false → AI won't respond to this alone.
      if (this.config.injectElapsedTime !== false) {
        const elapsedSeconds = Math.floor((Date.now() - this.sessionStartMs) / 1000);
        try {
          this.session?.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: `[elapsed: ${elapsedSeconds}s]` }] }],
            turnComplete: false,
          });
        } catch {
          // best-effort
        }
      }
    }

    // ── Interrupted: only fire when AI was actively speaking ──
    // Gemini sends interrupted on any turn boundary; we gate it to prevent
    // false triggers while the candidate is the one speaking.
    if (serverContent?.interrupted) {
      if (this.isAiSpeaking) {
        this.isAiSpeaking = false;
        this.pendingAiText = '';
        this.config.onInterrupted();
      } else {
        this.pendingAiText = '';
      }
    }
  }
}
