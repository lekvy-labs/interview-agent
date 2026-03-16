/**
 * Wire protocol types shared between server and client SDKs.
 * These define the JSON messages exchanged over the browser ↔ server WebSocket.
 */

import { Type, type FunctionDeclaration } from '@google/genai';

// ─── Server → Client messages ───────────────────────────────────────────────

export interface StatusMessage {
  type: 'status';
  text: 'ready' | 'gemini_disconnected';
}

export interface AudioMessage {
  type: 'audio';
  /** Base64-encoded PCM audio */
  data: string;
  /** e.g. 'audio/pcm;rate=24000' */
  mimeType: string;
}

export interface TranscriptMessage {
  type: 'transcript';
  role: 'user' | 'assistant';
  text: string;
  turnComplete?: boolean;
}

export interface TurnCompleteMessage {
  type: 'turnComplete';
}

export interface InterruptedMessage {
  type: 'interrupted';
}

export interface ReconnectingMessage {
  type: 'reconnecting';
  attempt: number;
  maxAttempts: number;
}

export interface SessionEndedMessage {
  type: 'session-ended';
}

export interface InterviewConcludedMessage {
  type: 'interview-concluded';
}

export interface CodeSharingStartedMessage {
  type: 'code-sharing-started';
}

export interface CodeSharingEndedMessage {
  type: 'code-sharing-ended';
}

export interface ToolCallMessage {
  type: 'tool-call';
  name: string;
  args: Record<string, unknown>;
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
  | InterruptedMessage
  | ReconnectingMessage
  | SessionEndedMessage
  | InterviewConcludedMessage
  | CodeSharingStartedMessage
  | CodeSharingEndedMessage
  | ToolCallMessage
  | ErrorMessage;

// ─── Client → Server messages ───────────────────────────────────────────────

export interface InterruptClientMessage {
  type: 'interrupt';
}

export interface EndSessionClientMessage {
  type: 'end-session';
}

export type ClientToServerMessage = InterruptClientMessage | EndSessionClientMessage;
// (Binary frames = raw PCM Int16 LE 16 kHz are sent as binary WS frames, not JSON)

// ─── Transcript entry (for UI state) ────────────────────────────────────────

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
  turnComplete?: boolean;
}

// ─── Voice activity detection config ────────────────────────────────────────

export type StartSensitivityLevel = 'low' | 'high';
export type EndSensitivityLevel = 'low' | 'high';

export interface VoiceActivityDetectionConfig {
  startOfSpeechSensitivity?: StartSensitivityLevel;
  endOfSpeechSensitivity?: EndSensitivityLevel;
  /** Silence duration in ms before end-of-speech is triggered (default: 1200) */
  silenceDurationMs?: number;
}

// ─── Default tool declarations ──────────────────────────────────────────────

export const DEFAULT_TOOLS: FunctionDeclaration[] = [
  {
    name: 'conclude_interview',
    description:
      'Call this function after you have delivered the final sign-off statement to the candidate. This terminates the session.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'start_code_sharing',
    description:
      'Call this function when you are about to begin the code sharing discussion. This displays the code snippet to the candidate. Call it immediately before you start speaking about the code.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'end_code_sharing',
    description:
      'Call this function when the code sharing stage is concluded and you are about to move to the next stage. This hides the code editor from the candidate.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

// ─── Configuration types ────────────────────────────────────────────────────

export interface InterviewServerConfig {
  /** Gemini API key */
  geminiApiKey: string;
  /** System instruction sent to Gemini at session start */
  systemInstruction?: string;
  /** Gemini model ID (default: 'gemini-2.5-flash-native-audio-preview-12-2025') */
  model?: string;
  /**
   * Tool (function) declarations exposed to Gemini.
   * Uses `@google/genai` FunctionDeclaration type directly.
   * Defaults to the 3 built-in tools: conclude_interview, start_code_sharing, end_code_sharing.
   * Set to `[]` to disable all tools, or provide your own array to fully override.
   */
  tools?: FunctionDeclaration[];
  /** Voice activity detection sensitivity & silence duration */
  voiceActivityDetection?: VoiceActivityDetectionConfig;
  /**
   * Message sent to Gemini immediately after session opens to trigger the
   * opening greeting. Set to `false` to disable. Default: 'START_INTERVIEW'
   */
  triggerMessage?: string | false;
  /**
   * Inject `[elapsed: Xs]` context after every AI turn so Gemini can pace
   * interview stages. Default: true
   */
  injectElapsedTime?: boolean;
  /** Max transparent reconnect attempts on unexpected Gemini disconnect (default: 3) */
  maxReconnectAttempts?: number;
  /** Delay in ms between reconnect attempts (default: 2000) */
  reconnectDelayMs?: number;

  // ─── WebSocket server options ─────────────────────────────────────────────

  /** WebSocket path to listen on (default: '/ws') */
  path?: string;

  // ─── Lifecycle callbacks ──────────────────────────────────────────────────

  /** Called when a new session starts */
  onSessionStart?: (sessionId: string) => void;
  /** Called when a session ends */
  onSessionEnd?: (sessionId: string) => void;
  /** Called for every transcript entry (for server-side logging / DB persistence) */
  onTranscript?: (sessionId: string, entry: TranscriptEntry) => void;
  /**
   * Called when Gemini invokes a tool. Fires for every tool call including
   * built-in ones (conclude_interview, start_code_sharing, end_code_sharing).
   */
  onToolCall?: (sessionId: string, name: string, args: Record<string, unknown>) => void;
  /** Called when the AI naturally concludes the interview via conclude_interview tool */
  onInterviewConcluded?: (sessionId: string) => void;
  /** Called when the AI triggers start_code_sharing */
  onCodeSharingStarted?: (sessionId: string) => void;
  /** Called when the AI triggers end_code_sharing */
  onCodeSharingEnded?: (sessionId: string) => void;
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
  MODEL: 'gemini-2.5-flash-native-audio-preview-12-2025',
  MAX_RECONNECT_ATTEMPTS: 3,
  RECONNECT_DELAY_MS: 2000,
  SILENCE_DURATION_MS: 1200,
  TRIGGER_MESSAGE: 'START_INTERVIEW',
} as const;
