/**
 * InterviewServer — the main entry point for the backend SDK.
 *
 * Usage:
 *   import { InterviewServer } from '@lekvylabs/interview-agent/server';
 *
 *   const server = new InterviewServer({
 *     geminiApiKey: process.env.GEMINI_API_KEY!,
 *     systemInstruction: 'You are a technical interviewer...',
 *   });
 *
 *   // Attach to an existing http.Server (Express, Fastify, raw http, etc.)
 *   await server.attach(httpServer);
 *   // Or start standalone:
 *   await server.listen(3001);
 *
 * The 3 built-in tools (conclude_interview, start_code_sharing, end_code_sharing)
 * are registered by default. Override via config.tools.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { InterviewServerConfig, ServerToClientMessage } from '../shared/types.js';
import { DEFAULTS } from '../shared/types.js';
import { GeminiSession } from './gemini-session.js';

export class InterviewServer {
  private readonly config: InterviewServerConfig;
  private wss: WebSocketServer | null = null;
  private standaloneServer: http.Server | null = null;
  private readonly activeSessions = new Map<WebSocket, { sessionId: string; gemini: GeminiSession }>();

  constructor(config: InterviewServerConfig) {
    this.config = config;
  }

  /** Attach to an existing http.Server. */
  async attach(httpServer: http.Server): Promise<void> {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: this.config.path ?? DEFAULTS.WS_PATH,
    });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
  }

  /** Start a standalone HTTP + WS server. */
  async listen(port: number): Promise<void> {
    this.standaloneServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Interview Agent WS server is running.\n');
    });
    this.wss = new WebSocketServer({
      server: this.standaloneServer,
      path: this.config.path ?? DEFAULTS.WS_PATH,
    });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    await new Promise<void>((resolve) => {
      this.standaloneServer!.listen(port, resolve);
    });
  }

  /** Gracefully shut down all sessions and the server. */
  close(): void {
    for (const [ws, { gemini }] of this.activeSessions) {
      gemini.close();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    this.activeSessions.clear();
    this.wss?.close();
    this.standaloneServer?.close();
  }

  // ─── Connection handler ─────────────────────────────────────────────────────

  private handleConnection(clientWs: WebSocket, _req: http.IncomingMessage): void {
    const sessionId = randomUUID().slice(0, 8);
    this.config.onSessionStart?.(sessionId);

    const sendToClient = (msg: ServerToClientMessage): void => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(msg));
      }
    };

    const triggerMessage = this.config.triggerMessage;
    const triggerText =
      triggerMessage === false
        ? null
        : triggerMessage ?? DEFAULTS.TRIGGER_MESSAGE;

    const gemini = new GeminiSession({
      apiKey: this.config.geminiApiKey,
      model: this.config.model,
      systemInstruction: this.config.systemInstruction,
      sessionId,
      tools: this.config.tools,
      voiceActivityDetection: this.config.voiceActivityDetection,
      triggerMessage: this.config.triggerMessage,
      injectElapsedTime: this.config.injectElapsedTime,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      reconnectDelayMs: this.config.reconnectDelayMs,

      onReady: () => {
        sendToClient({ type: 'status', text: 'ready' });
        if (triggerText) {
          gemini.sendClientContent(triggerText, true);
        }
      },

      onAudio: (base64, mimeType) => {
        sendToClient({ type: 'audio', data: base64, mimeType });
      },

      onTranscript: (entry) => {
        sendToClient({ type: 'transcript', ...entry });
        this.config.onTranscript?.(sessionId, entry);
      },

      onToolCall: (name, args) => {
        sendToClient({ type: 'tool-call', name, args });
        this.config.onToolCall?.(sessionId, name, args);
      },

      onInterviewConcluded: () => {
        this.config.onInterviewConcluded?.(sessionId);
        sendToClient({ type: 'interview-concluded' });
        this.teardownSession(clientWs);
      },

      onCodeSharingStarted: () => {
        this.config.onCodeSharingStarted?.(sessionId);
        sendToClient({ type: 'code-sharing-started' });
      },

      onCodeSharingEnded: () => {
        this.config.onCodeSharingEnded?.(sessionId);
        sendToClient({ type: 'code-sharing-ended' });
      },

      onTurnComplete: () => {
        sendToClient({ type: 'turnComplete' });
      },

      onInterrupted: () => {
        sendToClient({ type: 'interrupted' });
      },

      onReconnecting: (attempt, maxAttempts) => {
        sendToClient({ type: 'reconnecting', attempt, maxAttempts });
      },

      onClose: () => {
        sendToClient({ type: 'status', text: 'gemini_disconnected' });
        sendToClient({ type: 'session-ended' });
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close();
        this.activeSessions.delete(clientWs);
        this.config.onSessionEnd?.(sessionId);
      },

      onError: (err) => {
        sendToClient({ type: 'error', text: err.message });
      },
    });

    this.activeSessions.set(clientWs, { sessionId, gemini });

    gemini.connect().catch((err) => {
      sendToClient({ type: 'error', text: `Failed to connect to Gemini: ${err?.message}` });
      clientWs.close();
      this.activeSessions.delete(clientWs);
      this.config.onSessionEnd?.(sessionId);
    });

    // ─── Client messages ──────────────────────────────────────────────────────

    clientWs.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (!gemini.isReady) return;

      if (isBinary) {
        const pcmBase64 = Buffer.from(data as Buffer).toString('base64');
        gemini.sendAudio(pcmBase64);
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'end-session') {
          this.teardownSession(clientWs);
        }
      } catch {
        // ignore malformed text frames
      }
    });

    clientWs.on('close', () => {
      const entry = this.activeSessions.get(clientWs);
      if (entry) {
        entry.gemini.close();
        this.activeSessions.delete(clientWs);
        this.config.onSessionEnd?.(sessionId);
      }
    });

    clientWs.on('error', (err) => {
      sendToClient({ type: 'error', text: err.message });
    });
  }

  private teardownSession(clientWs: WebSocket): void {
    const entry = this.activeSessions.get(clientWs);
    if (!entry) return;

    entry.gemini.close();
    this.activeSessions.delete(clientWs);

    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'session-ended' } satisfies ServerToClientMessage));
      clientWs.close();
    }

    this.config.onSessionEnd?.(entry.sessionId);
  }
}
