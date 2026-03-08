/**
 * server.js — Backend Orchestrator
 *
 * 1. Serves a static build of the React frontend.
 * 2. Opens a WebSocket server on /ws for browser clients.
 * 3. For every browser session, opens a bidirectional WebSocket to the
 *    Gemini 2.0 Flash Multimodal Live API and pipes audio/text between them.
 *
 * Env: GEMINI_API_KEY must be set.
 *
 * Audio conventions:
 *   Browser → Server  : raw PCM Int16 LE, 16 kHz mono  (binary frames)
 *   Server → Browser  : JSON frames  { type, data/text }
 *   Gemini ↔ Server   : Gemini Multimodal Live wire protocol (JSON over WS)
 */

import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import { randomUUID } from "node:crypto";

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3001", 10);
const GEMINI_API_KEY = "AIzaSyBJME6IKNW1bo3Df8zTgtuQCmzvlybv--0";

// ── Discover which model/version works on startup ───────────────────────────
async function detectLiveModel() {
  for (const version of ["v1beta", "v1alpha"]) {
    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/${version}/models?key=${GEMINI_API_KEY}&pageSize=100`
      );
    } catch (e) {
      console.warn(`[detect] fetch failed for ${version}:`, e.message);
      continue;
    }
    if (!res.ok) {
      console.warn(`[detect] ${version} ListModels returned HTTP ${res.status}`);
      continue;
    }
    const json = await res.json();
    const liveModels = (json.models || []).filter(
      (m) => Array.isArray(m.supportedGenerationMethods) &&
             m.supportedGenerationMethods.includes("bidiGenerateContent")
    );
    if (liveModels.length > 0) {
      console.log(`[detect] ${version} — models supporting bidiGenerateContent:`);
      liveModels.forEach((m) => console.log(`  • ${m.name}`));
      // Prefer models with 'live' in the name (conversational), not image-generation
      const preferred =
        liveModels.find((m) => m.name.includes("live")) ||
        liveModels.find((m) => !m.name.includes("image")) ||
        liveModels[0];
      return { version, modelId: preferred.name.replace("models/", "") };
    } else {
      console.log(`[detect] ${version} — no models support bidiGenerateContent`);
    }
  }
  return null;
}

let GEMINI_MODEL = "gemini-2.0-flash-live-001";
let GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

// Override with auto-detected values right before the server starts listening.
detectLiveModel().then((result) => {
  if (result) {
    GEMINI_MODEL = result.modelId;
    GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${result.version}.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
    console.log(`[detect] Using model=${GEMINI_MODEL} via ${result.version}`);
  } else {
    console.warn("[detect] Could not auto-detect a live model — using defaults, expect errors.");
  }
});

// System instruction sent once when the Gemini session starts.
const SYSTEM_INSTRUCTION = `You are a technical interviewer for a Senior Frontend Engineer role at a FinTech startup.
Your task is to conduct a structured, 30-minute technical interview.
Be conversational but focused. Ask one question at a time and wait for the candidate's answer.
Cover topics like: React architecture, state management, performance optimization, TypeScript, testing, and system design.
Start by greeting the candidate and asking them to introduce themselves briefly.`;

// ─── HTTP server (minimal — just for health-check / future static serving) ──

const httpServer = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Interview Agent WS server is running.\n");
});

// ─── WebSocket server for browser clients ───────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (clientWs, req) => {
  const sessionId = randomUUID().slice(0, 8);
  console.log(`[${sessionId}] Browser client connected from ${req.socket.remoteAddress}`);

  // --- Open connection to Gemini Multimodal Live API ---
  const geminiWs = new WebSocket(GEMINI_WS_URL);
  let geminiReady = false;

  // Track whether we've sent the setup message
  let setupSent = false;

  geminiWs.on("open", () => {
    console.log(`[${sessionId}] Connected to Gemini Live API`);

    // Send the setup message (must be the first message).
    const setupMessage = {
      setup: {
        model: `models/${GEMINI_MODEL}`,
        system_instruction: {
          parts: [{ text: SYSTEM_INSTRUCTION }],
        },
        generation_config: {
          response_modalities: ["AUDIO"],
        },
      },
    };

    geminiWs.send(JSON.stringify(setupMessage));
    setupSent = true;
    console.log(`[${sessionId}] Sent setup message to Gemini`);
  });

  geminiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn(`[${sessionId}] Non-JSON from Gemini, ignoring`);
      return;
    }

    // Handle setup completion
    if (msg.setupComplete) {
      geminiReady = true;
      console.log(`[${sessionId}] Gemini session ready`);
      safeSendJSON(clientWs, { type: "status", text: "ready" });
      return;
    }

    // Handle server content (audio + transcript from AI)
    if (msg.serverContent) {
      const sc = msg.serverContent;

      // Model turn — contains parts with inline audio and/or text
      if (sc.modelTurn && sc.modelTurn.parts) {
        for (const part of sc.modelTurn.parts) {
          // Audio part
          if (part.inlineData) {
            // part.inlineData.data is base64-encoded PCM (24 kHz, Int16 LE mono)
            safeSendJSON(clientWs, {
              type: "audio",
              data: part.inlineData.data, // base64
            });
          }
          // Text part (model's own words as text)
          if (part.text) {
            safeSendJSON(clientWs, {
              type: "transcript",
              role: "assistant",
              text: part.text,
            });
          }
        }
      }

      // Turn complete signal — lets the frontend know the AI is done speaking
      if (sc.turnComplete) {
        safeSendJSON(clientWs, { type: "turnComplete" });
      }

      // Input transcription (what the user said, transcribed by Gemini)
      if (sc.inputTranscription) {
        safeSendJSON(clientWs, {
          type: "transcript",
          role: "user",
          text: sc.inputTranscription.text,
        });
      }

      // Output transcription (what the model said, as text)
      if (sc.outputTranscription) {
        safeSendJSON(clientWs, {
          type: "transcript",
          role: "assistant",
          text: sc.outputTranscription.text,
        });
      }
    }
  });

  geminiWs.on("close", (code, reason) => {
    console.log(`[${sessionId}] Gemini WS closed: ${code} ${reason}`);
    geminiReady = false;
    safeSendJSON(clientWs, { type: "status", text: "gemini_disconnected" });
    clientWs.close();
  });

  geminiWs.on("error", (err) => {
    console.error(`[${sessionId}] Gemini WS error:`, err.message);
    safeSendJSON(clientWs, { type: "error", text: "Gemini connection error" });
  });

  // --- Handle messages from browser client ---

  clientWs.on("message", (data, isBinary) => {
    if (!geminiReady) {
      // Queue or drop; for this POC we simply drop pre-ready audio.
      return;
    }

    if (isBinary) {
      // Binary frame = raw PCM Int16 LE, 16 kHz mono from the browser mic.
      // Convert to base64 and wrap in the Gemini realtime_input message.
      const pcmBase64 = Buffer.from(data).toString("base64");

      const realtimeInput = {
        realtime_input: {
          media_chunks: [
            {
              mime_type: "audio/pcm;rate=16000",
              data: pcmBase64,
            },
          ],
        },
      };

      if (geminiWs.readyState === WebSocket.OPEN) {
        geminiWs.send(JSON.stringify(realtimeInput));
      }
    } else {
      // Text frame — could be a control message from the frontend.
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }

      // "interrupt" — user started talking, tell Gemini to stop generating
      // (Gemini handles this automatically via voice activity detection,
      //  but we can also signal it explicitly if needed in the future.)
      if (parsed.type === "interrupt") {
        console.log(`[${sessionId}] User interrupt signal`);
      }
    }
  });

  clientWs.on("close", () => {
    console.log(`[${sessionId}] Browser client disconnected`);
    if (geminiWs.readyState === WebSocket.OPEN) {
      geminiWs.close();
    }
  });

  clientWs.on("error", (err) => {
    console.error(`[${sessionId}] Client WS error:`, err.message);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Safely send a JSON message to a WebSocket if it's open. */
function safeSendJSON(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`Interview Agent server listening on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
});
