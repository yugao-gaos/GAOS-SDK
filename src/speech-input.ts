/** Product-neutral segment boundaries shared by push-to-talk and hands-free input. */
export type SpeechInputBoundaryEvent =
  | { type: 'segment_start' }
  | { type: 'segment_end'; durationMs: number };

/** Presentation context used to make hands-free barge-in more conservative. */
export type SpeechInputContext = 'listening' | 'assistant_speaking';

export interface AdaptiveSpeechSegmenterOptions {
  sampleRate: number;
  onsetMs?: number;
  assistantOnsetMs?: number;
  releaseMs?: number;
  maxSegmentMs?: number;
  speechThreshold?: number;
  assistantSpeechThreshold?: number;
  noiseFloorMultiplier?: number;
  noiseFloorSmoothing?: number;
}

export interface AdaptiveSpeechSegmenterSnapshot {
  phase: 'idle' | 'candidate' | 'speaking';
  noiseFloor: number;
  speechMs: number;
  silenceMs: number;
  segmentMs: number;
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function threshold(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

/** Compute normalized RMS for little-endian mono PCM16. */
export function pcm16Rms(pcm: ArrayBuffer): number {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error('PCM16 input must contain complete samples');
  }
  const samples = new Int16Array(pcm);
  let sum = 0;
  for (const sample of samples) {
    const normalized = sample / 0x8000;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Turns PCM level frames into stable speech segment boundaries.
 *
 * The segmenter owns no transport. A host may map the same events to
 * push/release UI, a voice protocol, or durable room-agent input admission.
 */
export class AdaptiveSpeechSegmenter {
  readonly #sampleRate: number;
  readonly #onsetMs: number;
  readonly #assistantOnsetMs: number;
  readonly #releaseMs: number;
  readonly #maxSegmentMs: number;
  readonly #speechThreshold: number;
  readonly #assistantSpeechThreshold: number;
  readonly #noiseFloorMultiplier: number;
  readonly #noiseFloorSmoothing: number;
  #phase: AdaptiveSpeechSegmenterSnapshot['phase'] = 'idle';
  #noiseFloor = 0.004;
  #speechMs = 0;
  #silenceMs = 0;
  #segmentMs = 0;

  constructor(options: AdaptiveSpeechSegmenterOptions) {
    this.#sampleRate = finitePositive(options.sampleRate, 'sampleRate');
    this.#onsetMs = finitePositive(options.onsetMs ?? 80, 'onsetMs');
    this.#assistantOnsetMs = finitePositive(
      options.assistantOnsetMs ?? 240,
      'assistantOnsetMs',
    );
    this.#releaseMs = finitePositive(options.releaseMs ?? 700, 'releaseMs');
    this.#maxSegmentMs = finitePositive(options.maxSegmentMs ?? 60_000, 'maxSegmentMs');
    this.#speechThreshold = threshold(options.speechThreshold ?? 0.04, 'speechThreshold');
    this.#assistantSpeechThreshold = threshold(
      options.assistantSpeechThreshold ?? 0.14,
      'assistantSpeechThreshold',
    );
    this.#noiseFloorMultiplier = finitePositive(
      options.noiseFloorMultiplier ?? 2.5,
      'noiseFloorMultiplier',
    );
    const smoothing = options.noiseFloorSmoothing ?? 0.05;
    if (!Number.isFinite(smoothing) || smoothing <= 0 || smoothing > 1) {
      throw new Error('noiseFloorSmoothing must be between 0 and 1');
    }
    this.#noiseFloorSmoothing = smoothing;
  }

  pushPcm16(pcm: ArrayBuffer, context: SpeechInputContext): SpeechInputBoundaryEvent[] {
    const durationMs = new Int16Array(pcm).length / this.#sampleRate * 1_000;
    return this.pushLevel(pcm16Rms(pcm), durationMs, context);
  }

  pushLevel(
    rms: number,
    durationMs: number,
    context: SpeechInputContext,
  ): SpeechInputBoundaryEvent[] {
    threshold(rms, 'rms');
    finitePositive(durationMs, 'durationMs');
    const events: SpeechInputBoundaryEvent[] = [];
    const levelThreshold = context === 'assistant_speaking'
      ? Math.max(this.#assistantSpeechThreshold, this.#noiseFloor * this.#noiseFloorMultiplier)
      : Math.max(this.#speechThreshold, this.#noiseFloor * this.#noiseFloorMultiplier);
    const onsetMs = context === 'assistant_speaking' ? this.#assistantOnsetMs : this.#onsetMs;
    const voiced = rms >= levelThreshold;

    if (this.#phase !== 'speaking') {
      if (!voiced) {
        this.#phase = 'idle';
        this.#speechMs = 0;
        if (context === 'listening') {
          this.#noiseFloor += (rms - this.#noiseFloor) * this.#noiseFloorSmoothing;
        }
        return events;
      }
      this.#phase = 'candidate';
      this.#speechMs += durationMs;
      if (this.#speechMs + Number.EPSILON * 1_000 < onsetMs) return events;
      this.#phase = 'speaking';
      this.#segmentMs = this.#speechMs;
      this.#silenceMs = 0;
      events.push({ type: 'segment_start' });
      return events;
    }

    this.#segmentMs += durationMs;
    this.#silenceMs = voiced ? 0 : this.#silenceMs + durationMs;
    if (this.#silenceMs + Number.EPSILON * 1_000 >= this.#releaseMs
      || this.#segmentMs + Number.EPSILON * 1_000 >= this.#maxSegmentMs) {
      events.push({
        type: 'segment_end',
        durationMs: Math.max(0, Math.round(this.#segmentMs - this.#silenceMs)),
      });
      this.#phase = 'idle';
      this.#speechMs = 0;
      this.#silenceMs = 0;
      this.#segmentMs = 0;
    }
    return events;
  }

  cancelSegment(): void {
    this.#phase = 'idle';
    this.#speechMs = 0;
    this.#silenceMs = 0;
    this.#segmentMs = 0;
  }

  reset(): void {
    this.cancelSegment();
    this.#noiseFloor = 0.004;
  }

  snapshot(): AdaptiveSpeechSegmenterSnapshot {
    return {
      phase: this.#phase,
      noiseFloor: this.#noiseFloor,
      speechMs: this.#speechMs,
      silenceMs: this.#silenceMs,
      segmentMs: this.#segmentMs,
    };
  }
}
