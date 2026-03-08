/**
 * AudioCapture — wraps getUserMedia + AudioWorklet for PCM mic capture.
 * Returns Float32 chunks at the browser's native sample rate.
 */

const WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._chunkSize = Math.floor(sampleRate * 0.1);
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channelData = input[0];
    for (let i = 0; i < channelData.length; i++) {
      this._buffer.push(channelData[i]);
    }
    while (this._buffer.length >= this._chunkSize) {
      const chunk = this._buffer.splice(0, this._chunkSize);
      this.port.postMessage({ pcmFloat32: new Float32Array(chunk), sampleRate });
    }
    return true;
  }
}
registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;

export interface AudioCaptureCallbacks {
  onChunk: (pcmFloat32: Float32Array, sampleRate: number) => void;
}

export class AudioCapture {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  /** The AudioContext (available after start). Needed for playback. */
  get context(): AudioContext | null {
    return this.audioCtx;
  }

  async start(callbacks: AudioCaptureCallbacks, preferredSampleRate = 48000): Promise<void> {
    const audioCtx = new AudioContext({ sampleRate: preferredSampleRate });
    this.audioCtx = audioCtx;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    this.stream = stream;

    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture-processor');
    this.workletNode = workletNode;

    const source = audioCtx.createMediaStreamSource(stream);
    this.sourceNode = source;
    source.connect(workletNode);

    workletNode.port.onmessage = (e: MessageEvent) => {
      const { pcmFloat32, sampleRate } = e.data as {
        pcmFloat32: Float32Array;
        sampleRate: number;
      };
      callbacks.onChunk(pcmFloat32, sampleRate);
    };
  }

  stop(): void {
    this.workletNode?.disconnect();
    this.sourceNode?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
    }
    this.workletNode = null;
    this.sourceNode = null;
    this.stream = null;
    this.audioCtx = null;
  }
}
