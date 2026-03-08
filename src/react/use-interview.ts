/**
 * useInterview — React hook for conducting an AI interview session.
 *
 * Usage:
 *   import { useInterview } from 'interview-agent/react';
 *
 *   function MyComponent() {
 *     const interview = useInterview({ wsUrl: 'ws://localhost:3001/ws' });
 *     return (
 *       <>
 *         <button onClick={interview.start}>Start</button>
 *         <button onClick={interview.stop}>Stop</button>
 *         <p>Status: {interview.status}</p>
 *         {interview.transcript.map((t, i) => (
 *           <p key={i}><b>{t.role}:</b> {t.text}</p>
 *         ))}
 *       </>
 *     );
 *   }
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type {
  UseInterviewOptions,
  InterviewStatus,
  TranscriptEntry,
  ServerToClientMessage,
} from '../shared/types.js';
import { DEFAULTS } from '../shared/types.js';
import { AudioCapture } from './audio-capture.js';
import { AudioPlayback } from './audio-playback.js';
import { downsampleToInt16, decodeBase64PcmToFloat32, computeEnergy } from './audio-utils.js';

export interface UseInterviewReturn {
  status: InterviewStatus;
  transcript: TranscriptEntry[];
  isUserSpeaking: boolean;
  start: () => Promise<void>;
  stop: () => void;
}

export function useInterview(options: UseInterviewOptions): UseInterviewReturn {
  const {
    wsUrl,
    inputSampleRate = DEFAULTS.INPUT_SAMPLE_RATE,
    targetSampleRate = DEFAULTS.TARGET_SAMPLE_RATE,
    aiSampleRate = DEFAULTS.AI_SAMPLE_RATE,
    vadThreshold = DEFAULTS.VAD_THRESHOLD,
  } = options;

  const [status, setStatus] = useState<InterviewStatus>('idle');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const playbackRef = useRef<AudioPlayback | null>(null);
  const userSpeakingRef = useRef(false);

  // Keep refs in sync with state for use in callbacks
  userSpeakingRef.current = isUserSpeaking;

  const handleServerMessage = useCallback(
    (event: MessageEvent) => {
      let msg: ServerToClientMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerToClientMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'status':
          if (msg.text === 'ready') setStatus('ready');
          else if (msg.text === 'gemini_disconnected') setStatus('error');
          break;

        case 'audio':
          if (msg.data) {
            const float32 = decodeBase64PcmToFloat32(msg.data);
            playbackRef.current?.enqueue(float32);
          }
          break;

        case 'transcript':
          if (msg.text) {
            setTranscript((prev) => {
              const last = prev[prev.length - 1];
              if (last && last.role === msg.role) {
                const updated = [...prev];
                updated[updated.length - 1] = { ...last, text: last.text + msg.text };
                return updated;
              }
              return [...prev, { role: msg.role, text: msg.text }];
            });
          }
          break;

        case 'turnComplete':
          break;

        case 'error':
          setStatus('error');
          break;
      }
    },
    [],
  );

  const stop = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    playbackRef.current?.stop();
    captureRef.current?.stop();
    captureRef.current = null;
    playbackRef.current = null;
    setStatus('idle');
    setIsUserSpeaking(false);
  }, []);

  const start = useCallback(async () => {
    setStatus('connecting');
    setTranscript([]);

    try {
      // 1. Audio capture
      const capture = new AudioCapture();
      captureRef.current = capture;

      // 2. Audio playback
      const playback = new AudioPlayback(aiSampleRate);
      playbackRef.current = playback;

      // 3. WebSocket
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => setStatus('active');
      ws.onmessage = handleServerMessage;
      ws.onclose = () => setStatus('idle');
      ws.onerror = () => setStatus('error');

      // 4. Start mic capture → downsample → send
      await capture.start(
        {
          onChunk: (pcmFloat32, sampleRate) => {
            // VAD
            const energy = computeEnergy(pcmFloat32);
            const speaking = energy > vadThreshold;
            if (speaking && !userSpeakingRef.current) {
              setIsUserSpeaking(true);
              playback.stop(); // Interrupt AI
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'interrupt' }));
              }
            } else if (!speaking && userSpeakingRef.current) {
              setIsUserSpeaking(false);
            }

            // Downsample and send
            const int16 = downsampleToInt16(pcmFloat32, sampleRate, targetSampleRate);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(int16.buffer);
            }
          },
        },
        inputSampleRate,
      );

      // Share audio context with playback
      if (capture.context) {
        playback.setContext(capture.context);
      }
    } catch (err) {
      console.error('Failed to start interview:', err);
      setStatus('error');
    }
  }, [wsUrl, inputSampleRate, targetSampleRate, aiSampleRate, vadThreshold, handleServerMessage]);

  // Cleanup on unmount
  useEffect(() => {
    return () => stop();
  }, [stop]);

  return { status, transcript, isUserSpeaking, start, stop };
}
