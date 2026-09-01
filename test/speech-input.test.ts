import { describe, expect, it } from 'vitest';
import {
  AdaptiveSpeechSegmenter,
  pcm16Rms,
  type SpeechInputBoundaryEvent,
} from '../src/speech-input.js';

function pcm16(level: number, durationMs: number, sampleRate = 16_000): ArrayBuffer {
  const samples = Math.round(sampleRate * durationMs / 1_000);
  const output = new Int16Array(samples);
  output.fill(Math.round(Math.max(-1, Math.min(1, level)) * 0x7fff));
  return output.buffer;
}

function collect(
  segmenter: AdaptiveSpeechSegmenter,
  frames: Array<{ level: number; durationMs: number; context?: 'listening' | 'assistant_speaking' }>,
): SpeechInputBoundaryEvent[] {
  return frames.flatMap((frame) => segmenter.pushPcm16(
    pcm16(frame.level, frame.durationMs),
    frame.context ?? 'listening',
  ));
}

describe('AdaptiveSpeechSegmenter', () => {
  it('waits for the configured 1.5 second release tail', () => {
    const segmenter = new AdaptiveSpeechSegmenter({
      sampleRate: 16_000,
      onsetMs: 80,
      releaseMs: 1_500,
      speechThreshold: 0.04,
    });

    const events = collect(segmenter, [
      { level: 0.2, durationMs: 80 },
      { level: 0, durationMs: 1_490 },
      { level: 0.2, durationMs: 80 },
      { level: 0, durationMs: 1_500 },
    ]);

    expect(events.map((event) => event.type)).toEqual(['segment_start', 'segment_end']);
    expect(events[1]).toEqual({ type: 'segment_end', durationMs: 1_650 });
  });

  it('requires sustained louder speech while assistant playback is active', () => {
    const segmenter = new AdaptiveSpeechSegmenter({
      sampleRate: 16_000,
      onsetMs: 80,
      assistantOnsetMs: 240,
      releaseMs: 1_500,
      speechThreshold: 0.04,
      assistantSpeechThreshold: 0.14,
    });

    const echo = collect(segmenter, [
      ...Array.from({ length: 20 }, () => ({
        level: 0.09,
        durationMs: 30,
        context: 'assistant_speaking' as const,
      })),
    ]);
    const bargeIn = collect(segmenter, [
      { level: 0.22, durationMs: 120, context: 'assistant_speaking' },
      { level: 0.22, durationMs: 120, context: 'assistant_speaking' },
    ]);

    expect(echo).toEqual([]);
    expect(bargeIn).toEqual([{ type: 'segment_start' }]);
    expect(segmenter.snapshot().noiseFloor).toBe(0.004);
  });

  it('adapts the listening threshold above a stable noise floor', () => {
    const segmenter = new AdaptiveSpeechSegmenter({
      sampleRate: 16_000,
      onsetMs: 80,
      releaseMs: 1_500,
      speechThreshold: 0.04,
      noiseFloorMultiplier: 2.5,
    });

    collect(segmenter, Array.from({ length: 20 }, () => ({
      level: 0.03,
      durationMs: 40,
    })));
    expect(collect(segmenter, [
      { level: 0.05, durationMs: 160 },
    ])).toEqual([]);
    expect(collect(segmenter, [
      { level: 0.12, durationMs: 80 },
    ])).toEqual([{ type: 'segment_start' }]);
  });

  it('cancels a candidate or open segment without clearing calibration', () => {
    const segmenter = new AdaptiveSpeechSegmenter({
      sampleRate: 16_000,
      onsetMs: 80,
      releaseMs: 1_500,
    });

    collect(segmenter, [{ level: 0.2, durationMs: 80 }]);
    const before = segmenter.snapshot().noiseFloor;
    segmenter.cancelSegment();

    expect(segmenter.snapshot()).toMatchObject({ phase: 'idle', noiseFloor: before });
    expect(collect(segmenter, [{ level: 0, durationMs: 2_000 }])).toEqual([]);
  });
});

describe('pcm16Rms', () => {
  it('rejects malformed PCM and measures signed samples', () => {
    expect(() => pcm16Rms(new Uint8Array([1]).buffer)).toThrow(/PCM16/);
    expect(pcm16Rms(pcm16(0.5, 20))).toBeCloseTo(0.5, 2);
  });
});
