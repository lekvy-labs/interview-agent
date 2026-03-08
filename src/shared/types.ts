/**
 * Wire protocol types shared between server and client SDKs.
 * These define the JSON messages exchanged over the browser ↔ server WebSocket.
 */

// ─── Server → Client messages ───────────────────────────────────────────────

export interface StatusMessage {
  type: 'status';
  text: 'ready' | 'gemini_disconnected';
}

export interface AudioMessage {
  type: 'audio';
  /** Base64-encoded PCM Int16 LE, 24 kHz mono */
  data: string;
}

export interface TranscriptMessage {
  type: 'transcript';
  role: 'user' | 'assistant';
  text: string;
}

export interface TurnCompleteMessage {
  type: 'turnComplete';
}

export interface ErrorMessage {
  type: 'error';
  text: string;
}

export type ServerToClientMessage =
  | StatusMessage
  | AudioMessage
  | TranscriptMessage
  | TurnCompleteMessage
  | ErrorMessage;

// ─── Client → Server messages ───────────────────────────────────────────────

export interface InterruptMessage {
  type: 'interrupt';
}

export type ClientToServerMessage = InterruptMessage;
// (Binary frames = raw PCM Int16 LE 16 kHz are sent as binary WS frames, not JSON)

// ─── Transcript entry (for UI state) ────────────────────────────────────────

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

// ─── Configuration types ────────────────────────────────────────────────────

export interface InterviewServerConfig {
  /** Gemini API key */
  geminiApiKey: string;
  /** System instruction sent to Gemini at session start */
  systemInstruction: string;
  /** Override model ID (auto-detected if omitted) */
  model?: string;
  /** Override API version: 'v1alpha' | 'v1beta' (auto-detected if omitted) */
  apiVersion?: string;
  /** WebSocket path to listen on (default: '/ws') */
  path?: string;
  /** Called when a new session starts */
  onSessionStart?: (sessionId: string) => void;
  /** Called when a session ends */
  onSessionEnd?: (sessionId: string) => void;
  /** Called for every transcript message */
  onTranscript?: (sessionId: string, entry: TranscriptEntry) => void;
}

export interface UseInterviewOptions {
  /** WebSocket URL to the interview server (e.g. 'ws://localhost:3001/ws') */
  wsUrl: string;
  /** Input sample rate hint (default: 48000, browser may override) */
  inputSampleRate?: number;
  /** Target sample rate for outgoing PCM (default: 16000) */
  targetSampleRate?: number;
  /** AI audio sample rate (default: 24000) */
  aiSampleRate?: number;
  /** Energy threshold for voice activity detection (default: 0.001) */
  vadThreshold?: number;
}

export type InterviewStatus = 'idle' | 'connecting' | 'ready' | 'active' | 'error';

// ─── Audio constants ────────────────────────────────────────────────────────

export const DEFAULTS = {
  INPUT_SAMPLE_RATE: 48000,
  TARGET_SAMPLE_RATE: 16000,
  AI_SAMPLE_RATE: 24000,
  VAD_THRESHOLD: 0.001,
  WS_PATH: '/ws',
} as const;
