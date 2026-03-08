/**
 * GeminiSession — manages a single bidirectional WebSocket connection
 * to the Gemini Multimodal Live API for one interview session.
 */

import WebSocket from 'ws';
import type { ServerToClientMessage, TranscriptEntry } from '../shared/types.js';

export interface GeminiSessionConfig {
  wsUrl: string;
  model: string;
  systemInstruction: string;
  sessionId: string;
  /** Called for every message that should be forwarded to the browser client */
  onClientMessage: (msg: ServerToClientMessage) => void;
  /** Called when the Gemini connection is ready */
  onReady: () => void;
  /** Called when the Gemini connection closes */
  onClose: (code: number, reason: string) => void;
  /** Called on error */
  onError: (err: Error) => void;
  /** Called for transcript entries (for server-side logging) */
  onTranscript?: (entry: TranscriptEntry) => void;
}

export class GeminiSession {
  private ws: WebSocket;
  private ready = false;
  private readonly config: GeminiSessionConfig;

  constructor(config: GeminiSessionConfig) {
    this.config = config;
    this.ws = new WebSocket(config.wsUrl);
    this.setup();
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Send raw PCM audio (Int16 LE, 16 kHz) to Gemini. */
  sendAudio(pcmBase64: string): void {
    if (!this.ready || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        realtime_input: {
          media_chunks: [
            {
              mime_type: 'audio/pcm;rate=16000',
              data: pcmBase64,
            },
          ],
        },
      }),
    );
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  private setup(): void {
    const { config } = this;

    this.ws.on('open', () => {
      const setupMessage = {
        setup: {
          model: `models/${config.model}`,
          system_instruction: {
            parts: [{ text: config.systemInstruction }],
          },
          generation_config: {
            response_modalities: ['AUDIO'],
          },
        },
      };
      this.ws.send(JSON.stringify(setupMessage));
    });

    this.ws.on('message', (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg['setupComplete']) {
        this.ready = true;
        config.onReady();
        return;
      }

      if (msg['serverContent']) {
        this.handleServerContent(msg['serverContent'] as Record<string, unknown>);
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.ready = false;
      config.onClose(code, reason.toString());
    });

    this.ws.on('error', (err: Error) => {
      config.onError(err);
    });
  }

  private handleServerContent(sc: Record<string, unknown>): void {
    const { onClientMessage, onTranscript } = this.config;

    // Model turn — audio + text parts
    const modelTurn = sc['modelTurn'] as
      | { parts?: Array<{ inlineData?: { data: string }; text?: string }> }
      | undefined;
    if (modelTurn?.parts) {
      for (const part of modelTurn.parts) {
        if (part.inlineData) {
          onClientMessage({ type: 'audio', data: part.inlineData.data });
        }
        if (part.text) {
          const entry: TranscriptEntry = { role: 'assistant', text: part.text };
          onClientMessage({ type: 'transcript', ...entry });
          onTranscript?.(entry);
        }
      }
    }

    if (sc['turnComplete']) {
      onClientMessage({ type: 'turnComplete' });
    }

    const inputTranscription = sc['inputTranscription'] as { text?: string } | undefined;
    if (inputTranscription?.text) {
      const entry: TranscriptEntry = { role: 'user', text: inputTranscription.text };
      onClientMessage({ type: 'transcript', ...entry });
      onTranscript?.(entry);
    }

    const outputTranscription = sc['outputTranscription'] as { text?: string } | undefined;
    if (outputTranscription?.text) {
      const entry: TranscriptEntry = { role: 'assistant', text: outputTranscription.text };
      onClientMessage({ type: 'transcript', ...entry });
      onTranscript?.(entry);
    }
  }
}
