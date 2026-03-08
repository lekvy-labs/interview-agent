/**
 * InterviewPanel — ready-made React component for an interview room.
 * Uses useInterview internally. Drop-in replacement for the old InterviewComponent.jsx.
 */

import React from 'react';
import type { UseInterviewOptions } from '../shared/types.js';
import { useInterview } from './use-interview.js';

export interface InterviewPanelProps extends UseInterviewOptions {
  /** Override inline styles for the root container */
  style?: React.CSSProperties;
}

export function InterviewPanel({ style, ...options }: InterviewPanelProps) {
  const { status, transcript, isUserSpeaking, start, stop } = useInterview(options);

  const statusLabel: Record<string, string> = {
    idle: '⏸ Idle',
    connecting: '🔄 Connecting…',
    ready: '✅ Ready',
    active: '🎙 Active',
    error: '❌ Error',
  };

  const btnBase: React.CSSProperties = {
    padding: '0.6rem 1.4rem',
    fontSize: '1rem',
    fontFamily: 'monospace',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
  };

  return (
    <div
      style={{
        fontFamily: 'monospace',
        maxWidth: 720,
        margin: '2rem auto',
        padding: '0 1rem',
        ...style,
      }}
    >
      <h1 style={{ fontSize: '1.4rem' }}>AI Interview Room</h1>

      <div style={{ marginBottom: '1rem' }}>
        <strong>Status: </strong>
        <span>{statusLabel[status] ?? status}</span>
        {isUserSpeaking && (
          <span style={{ marginLeft: 12, color: '#c00' }}>🔴 You are speaking</span>
        )}
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        {status === 'idle' || status === 'error' ? (
          <button onClick={start} style={{ ...btnBase, background: '#1976d2' }}>
            ▶ Start Interview
          </button>
        ) : (
          <button onClick={stop} style={{ ...btnBase, background: '#c00' }}>
            ■ Stop Interview
          </button>
        )}
      </div>

      <div>
        <h2 style={{ fontSize: '1.1rem' }}>Live Transcript</h2>
        <div
          style={{
            border: '1px solid #444',
            borderRadius: 4,
            padding: '0.75rem',
            height: 400,
            overflowY: 'auto',
            background: '#1a1a1a',
            color: '#eee',
          }}
        >
          {transcript.length === 0 && (
            <p style={{ color: '#777' }}>Transcript will appear here once the interview starts…</p>
          )}
          {transcript.map((entry, i) => (
            <div key={i} style={{ marginBottom: '0.5rem' }}>
              <strong style={{ color: entry.role === 'user' ? '#4fc3f7' : '#aed581' }}>
                {entry.role === 'user' ? 'You' : 'Interviewer'}:
              </strong>{' '}
              <span>{entry.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
