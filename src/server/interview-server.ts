/**
 * InterviewServer — the main entry point for the backend SDK.
 *
 * Usage:
 *   import { InterviewServer } from 'interview-agent/server';
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
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { InterviewServerConfig, ServerToClientMessage } from '../shared/types.js';
import { DEFAULTS } from '../shared/types.js';
import { detectLiveModel, buildGeminiWsUrl } from './detect-model.js';
import { GeminiSession } from './gemini-session.js';

export class InterviewServer {
  private readonly config: InterviewServerConfig;
  private wss: WebSocketServer | null = null;
  private model: string;
  private geminiWsUrl: string;
  private standaloneServer: http.Server | null = null;

  constructor(config: InterviewServerConfig) {
    this.config = config;
    this.model = config.model ?? 'gemini-2.0-flash-live-001';
    this.geminiWsUrl = buildGeminiWsUrl(
      config.geminiApiKey,
      config.apiVersion ?? 'v1beta',
    );
  }

  /** Auto-detect the best available model + API version. Call before attach/listen. */
  async detectModel(): Promise<{ model: string; apiVersion: string } | null> {
    const result = await detectLiveModel(this.config.geminiApiKey);
    if (result) {
      this.model = result.modelId;
      this.geminiWsUrl = buildGeminiWsUrl(this.config.geminiApiKey, result.version);
      return { model: result.modelId, apiVersion: result.version };
    }
    return null;
  }

  /** Attach to an existing http.Server. */
  async attach(httpServer: http.Server): Promise<void> {
    if (!this.config.model && !this.config.apiVersion) {
      await this.detectModel();
    }
    this.wss = new WebSocketServer({
      server: httpServer,
      path: this.config.path ?? DEFAULTS.WS_PATH,
    });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
  }

  /** Start a standalone HTTP + WS server. */
  async listen(port: number): Promise<void> {
    if (!this.config.model && !this.config.apiVersion) {
      await this.detectModel();
    }
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

  /** Gracefully shut down. */
  close(): void {
    this.wss?.close();
    this.standaloneServer?.close();
  }

  private handleConnection(clientWs: WebSocket, req: http.IncomingMessage): void {
    const sessionId = randomUUID().slice(0, 8);
    this.config.onSessionStart?.(sessionId);

    const sendToClient = (msg: ServerToClientMessage): void => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(msg));
      }
    };

    const gemini = new GeminiSession({
      wsUrl: this.geminiWsUrl,
      model: this.model,
      systemInstruction: this.config.systemInstruction,
      sessionId,
      onClientMessage: sendToClient,
      onReady: () => {
        sendToClient({ type: 'status', text: 'ready' });
      },
      onClose: (_code, _reason) => {
        sendToClient({ type: 'status', text: 'gemini_disconnected' });
        clientWs.close();
        this.config.onSessionEnd?.(sessionId);
      },
      onError: (err) => {
        sendToClient({ type: 'error', text: err.message });
      },
      onTranscript: (entry) => {
        this.config.onTranscript?.(sessionId, entry);
      },
    });

    clientWs.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (!gemini.isReady) return;

      if (isBinary) {
        const pcmBase64 = Buffer.from(data as Buffer).toString('base64');
        gemini.sendAudio(pcmBase64);
      }
      // Text frames (e.g. interrupt) handled here if needed in the future
    });

    clientWs.on('close', () => {
      gemini.close();
      this.config.onSessionEnd?.(sessionId);
    });

    clientWs.on('error', (err) => {
      sendToClient({ type: 'error', text: err.message });
    });
  }
}
