/**
 * useLiveInterview — Socket.IO hook for the NestJS live-interview gateway.
 *
 * Usage:
 *   import { useLiveInterview } from 'interview-agent/react';
 *
 *   const {
 *     status,
 *     transcript,
 *     isUserSpeaking,
 *     interviewerActivity,
 *     isAssistantSpeaking,
 *     start,
 *     stop,
 *   } = useLiveInterview({
 *     serverUrl: 'http://localhost:3000',
 *     interviewId: '...',
 *     token: '...',
 *   });
 *
 * Protocol (namespace: /live-interview by default):
 *   connection params : { auth: { token }, query: { interviewId } }
 *
 *   Server → Client events:
 *     session-ready        — Gemini session open, safe to stream audio
 *     audio-response       — { audio: string (base64 24 kHz Int16 PCM) }
 *     transcript           — { role: 'user'|'model', text: string }
 *     interviewer-activity — { state: 'speaking'|'listening'|'thinking' } (optional)
 *     code-sharing-content — { code: string, language?: string, title?: string }
 *     interrupted          — AI was cut off; stop playback immediately
 *     code-sharing-started — AI began code sharing; show code editor to candidate
 *     code-sharing-ended   — AI concluded code sharing; hide code editor
 *     session-ended        — session terminated by server/client request
 *     interview-concluded  — AI naturally ended the interview via tool call
 *     error                — { message: string }
 *
 *   Client → Server events:
 *     audio-chunk          — { audio: string (base64 16 kHz Int16 PCM) }
 *     end-session          — graceful close requested by user
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { TranscriptEntry } from '../shared/types.js';
import { AudioCapture } from './audio-capture.js';
import { AudioPlayback } from './audio-playback.js';
import { downsampleToInt16, decodeBase64PcmToFloat32, computeEnergy } from './audio-utils.js';

export interface UseLiveInterviewOptions {
  /** Base URL of the NestJS server, e.g. 'http://localhost:3000' */
  serverUrl: string;
  /** Interview session ID passed as a query param to the gateway */
  interviewId: string;
  /** Bearer token sent via Socket.IO auth */
  token: string;
  /** Socket.IO namespace (default: '/live-interview') */
  namespace?: string;
  /** Sample rate for captured mic audio sent to the server (default: 16000) */
  targetSampleRate?: number;
  /** Sample rate of AI audio responses from the server (default: 24000) */
  aiSampleRate?: number;
  /** RMS energy threshold for voice-activity detection (default: 0.001) */
  vadThreshold?: number;
}

export type LiveInterviewStatus = 'idle' | 'connecting' | 'active' | 'error';
export type InterviewerActivity = 'speaking' | 'listening' | 'thinking';
export interface SharedCodeState {
  code: string;
  language?: string;
  title?: string;
}

export interface UseLiveInterviewReturn {
  status: LiveInterviewStatus;
  transcript: TranscriptEntry[];
  isUserSpeaking: boolean;
  interviewerActivity: InterviewerActivity;
  isAssistantSpeaking: boolean;
  codeSharingActive: boolean;
  sharedCode: SharedCodeState | null;
  start: () => Promise<void>;
  stop: () => void;
}

interface InterviewerActivityEvent {
  state: InterviewerActivity;
}

interface CodeSharingContentEvent {
  code: string;
  language?: string;
  title?: string;
}

function isInterviewerActivity(value: unknown): value is InterviewerActivity {
  return value === 'speaking' || value === 'listening' || value === 'thinking';
}

function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function useLiveInterview(options: UseLiveInterviewOptions): UseLiveInterviewReturn {
  const {
    serverUrl,
    interviewId,
    token,
    namespace = '/live-interview',
    targetSampleRate = 16_000,
    aiSampleRate = 24_000,
    vadThreshold = 0.001,
  } = options;

  const [status, setStatus] = useState<LiveInterviewStatus>('idle');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [interviewerActivity, setInterviewerActivity] = useState<InterviewerActivity>('listening');
  const [codeSharingActive, setCodeSharingActive] = useState(false);
  const [sharedCode, setSharedCode] = useState<SharedCodeState | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const playbackRef = useRef<AudioPlayback | null>(null);
  const supportsActivityEventsRef = useRef(false);
  const isUserSpeakingRef = useRef(false);
  isUserSpeakingRef.current = isUserSpeaking;

  const setFallbackInterviewerActivity = useCallback((next: InterviewerActivity) => {
    if (!supportsActivityEventsRef.current) {
      setInterviewerActivity(next);
    }
  }, []);

  const cleanup = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    playbackRef.current?.stop();
    playbackRef.current = null;
    supportsActivityEventsRef.current = false;
    if (socketRef.current) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setIsUserSpeaking(false);
    setInterviewerActivity('listening');
    setCodeSharingActive(false);
    setSharedCode(null);
  }, []);

  const stop = useCallback(() => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('end-session');
    }
    cleanup();
    setStatus('idle');
  }, [cleanup]);

  const start = useCallback(async () => {
    setStatus('connecting');
    setTranscript([]);
    setInterviewerActivity('listening');
    supportsActivityEventsRef.current = false;

    try {
      const socket = io(`${serverUrl}${namespace}`, {
        auth: { token },
        query: { interviewId },
      });
      socketRef.current = socket;

      socket.on('connect_error', () => {
        cleanup();
        setStatus('error');
      });

      socket.on('error', () => {
        cleanup();
        setStatus('error');
      });

      socket.on('session-ended', () => {
        setSharedCode(null);
        cleanup();
        setStatus('idle');
      });

      socket.on('interview-concluded', () => {
        setSharedCode(null);
        cleanup();
        setStatus('idle');
      });

      socket.on('code-sharing-started', () => {
        setCodeSharingActive(true);
      });

      socket.on('code-sharing-ended', () => {
        setCodeSharingActive(false);
        setSharedCode(null);
      });

      socket.on('code-sharing-content', (data: CodeSharingContentEvent) => {
        if (typeof data?.code === 'string') {
          setSharedCode({
            code: data.code,
            language: data.language,
            title: data.title,
          });
        }
      });

      socket.on('audio-response', (data: { audio: string }) => {
        if (data.audio) {
          setFallbackInterviewerActivity('speaking');
          const float32 = decodeBase64PcmToFloat32(data.audio);
          playbackRef.current?.enqueue(float32);
        }
      });

      socket.on('interviewer-activity', (data: InterviewerActivityEvent) => {
        if (isInterviewerActivity(data?.state)) {
          supportsActivityEventsRef.current = true;
          setInterviewerActivity(data.state);
        }
      });

      socket.on('transcript', (data: { role: string; text: string }) => {
        const role: TranscriptEntry['role'] = data.role === 'model' ? 'assistant' : 'user';
        if (data.text) {
          setTranscript((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.role === role) {
              const updated = [...prev];
              updated[updated.length - 1] = { ...last, text: last.text + data.text };
              return updated;
            }
            return [...prev, { role, text: data.text }];
          });
        }
      });

      socket.on('interrupted', () => {
        playbackRef.current?.stop();
        setFallbackInterviewerActivity('listening');
      });

      // Start mic + audio pipeline once Gemini signals ready
      socket.on('session-ready', async () => {
        if (!socket.connected) return;
        try {
          const capture = new AudioCapture();
          captureRef.current = capture;

          const playback = new AudioPlayback(aiSampleRate, () => {
            setFallbackInterviewerActivity('thinking');
          });
          playbackRef.current = playback;

          await capture.start({
            onChunk: (pcmFloat32: Float32Array, sampleRate: number) => {
              const energy = computeEnergy(pcmFloat32);
              const speaking = energy > vadThreshold;
              if (speaking !== isUserSpeakingRef.current) {
                setIsUserSpeaking(speaking);
              }

              const int16 = downsampleToInt16(pcmFloat32, sampleRate, targetSampleRate);
              const audio = int16ToBase64(int16);
              if (socket.connected) {
                socket.emit('audio-chunk', { audio });
              }
            },
          });

          if (capture.context) {
            playback.setContext(capture.context);
          }

          setFallbackInterviewerActivity('listening');
          setStatus('active');
        } catch {
          cleanup();
          setStatus('error');
        }
      });
    } catch {
      cleanup();
      setStatus('error');
    }
  }, [
    serverUrl,
    namespace,
    token,
    interviewId,
    targetSampleRate,
    aiSampleRate,
    vadThreshold,
    cleanup,
    setFallbackInterviewerActivity,
  ]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    status,
    transcript,
    isUserSpeaking,
    interviewerActivity,
    isAssistantSpeaking: interviewerActivity === 'speaking',
    codeSharingActive,
    sharedCode,
    start,
    stop,
  };
}
