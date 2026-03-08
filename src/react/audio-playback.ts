/**
 * AudioPlayback — gapless queued playback of PCM Float32 audio chunks.
 * Supports immediate interruption (stop all queued + playing audio).
 */

export class AudioPlayback {
  private queue: Float32Array[] = [];
  private playing = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private ctx: AudioContext | null = null;
  private sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  /** Must be called before enqueue. Shares the AudioContext from AudioCapture. */
  setContext(ctx: AudioContext): void {
    this.ctx = ctx;
  }

  enqueue(float32: Float32Array): void {
    this.queue.push(float32);
    if (!this.playing) {
      this.playNext();
    }
  }

  /** Stop all playback immediately (for interruption). */
  stop(): void {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        // already stopped
      }
      this.currentSource = null;
    }
    this.queue = [];
    this.playing = false;
  }

  private playNext(): void {
    if (this.queue.length === 0 || !this.ctx || this.ctx.state === 'closed') {
      this.playing = false;
      return;
    }

    this.playing = true;

    // Drain all queued chunks into one buffer for gapless playback
    const chunks = this.queue.splice(0);
    let totalLength = 0;
    for (const c of chunks) totalLength += c.length;

    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    const buf = this.ctx.createBuffer(1, merged.length, this.sampleRate);
    buf.getChannelData(0).set(merged);

    const source = this.ctx.createBufferSource();
    source.buffer = buf;
    source.connect(this.ctx.destination);
    this.currentSource = source;

    source.onended = () => {
      this.currentSource = null;
      if (this.queue.length > 0) {
        this.playNext();
      } else {
        this.playing = false;
      }
    };

    source.start();
  }
}
