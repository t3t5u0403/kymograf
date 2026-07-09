import type { NoteEvent, SignalSpec, Track } from '../core/types'

/**
 * A Signal is a pure function of song time. Everything the visuals react to
 * is a Signal — this determinism is what makes offline export identical to
 * the live preview.
 */
export interface Signal {
  sample(t: number): number
  /** cumulative trigger-event count at time t (trigger signals only) */
  count?(t: number): number
}

export const ZERO: Signal = { sample: () => 0 }

/** index of the last note with time <= t, or -1 */
function lastIndexAtOrBefore(times: Float64Array, t: number): number {
  let lo = 0
  let hi = times.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

function filterNotes(notes: NoteEvent[], pitchLo: number, pitchHi: number) {
  const filtered = notes.filter((n) => n.midi >= pitchLo && n.midi <= pitchHi)
  const times = new Float64Array(filtered.length)
  const vels = new Float64Array(filtered.length)
  filtered.forEach((n, i) => { times[i] = n.time; vels[i] = n.velocity })
  return { times, vels }
}

/** note-on slams to velocity, exponential decay — the core "punchy" primitive */
function triggerEnvelope(notes: NoteEvent[], decay: number, pitchLo: number, pitchHi: number): Signal {
  const { times, vels } = filterNotes(notes, pitchLo, pitchHi)
  const horizon = decay * 6
  return {
    sample(t) {
      const idx = lastIndexAtOrBefore(times, t)
      let v = 0
      for (let i = idx; i >= 0 && i > idx - 32; i--) {
        const dt = t - times[i]
        if (dt > horizon) break
        v = Math.max(v, vels[i] * Math.exp(-dt / decay))
      }
      return Math.min(1, v)
    },
    count(t) {
      return lastIndexAtOrBefore(times, t) + 1
    },
  }
}

function audioEnvelope(env: Float32Array, rate: number, gain: number): Signal {
  // onsets = upward threshold crossings of the gain-scaled envelope; lets an
  // audio stem drive event params (cuts) without MIDI. Gain tunes sensitivity.
  let onsets: Float64Array | null = null
  const computeOnsets = () => {
    const times: number[] = []
    const thresh = 0.45
    const refractory = Math.max(1, Math.round(rate * 0.07)) // 70ms min gap
    let last = -refractory
    for (let i = 1; i < env.length; i++) {
      if (env[i] * gain >= thresh && env[i - 1] * gain < thresh && i - last >= refractory) {
        times.push(i / rate)
        last = i
      }
    }
    return new Float64Array(times)
  }
  return {
    sample(t) {
      const pos = t * rate
      const i = Math.floor(pos)
      if (i < 0 || i >= env.length - 1) return 0
      const frac = pos - i
      return Math.max(0, (env[i] * (1 - frac) + env[i + 1] * frac) * gain)
    },
    count(t) {
      onsets = onsets ?? computeOnsets()
      return lastIndexAtOrBefore(onsets, t) + 1
    },
  }
}

/** notes per second inside a trailing window, normalized so ~20 notes/s = 1 */
function noteDensity(notes: NoteEvent[], window: number): Signal {
  const { times } = filterNotes(notes, 0, 127)
  return {
    sample(t) {
      const hi = lastIndexAtOrBefore(times, t)
      const lo = lastIndexAtOrBefore(times, t - window)
      return Math.min(1, (hi - lo) / (window * 20))
    },
  }
}

/** pulse every `division` beats: exponential decay when set, else a sawtooth */
function beatClock(bpm: number, division: number, decay?: number): Signal {
  const cycle = (division * 60) / bpm
  return {
    sample(t) {
      if (t < 0) return 0
      const phase = ((t % cycle) + cycle) % cycle
      return decay ? Math.exp(-phase / decay) : 1 - phase / cycle
    },
    count(t) {
      return t < 0 ? 0 : Math.floor(t / cycle) + 1
    },
  }
}

export function buildSignal(spec: SignalSpec, tracks: Track[], bpm: number): Signal {
  switch (spec.kind) {
    case 'trigger': {
      const notes = tracks.find((t) => t.id === spec.trackId)?.midi?.notes
      return notes ? triggerEnvelope(notes, spec.decay, spec.pitchLo, spec.pitchHi) : ZERO
    }
    case 'audio': {
      const audio = tracks.find((t) => t.id === spec.trackId)?.audio
      return audio
        ? audioEnvelope(audio.envelopes[spec.band], audio.envelopes.rate, spec.gain)
        : ZERO
    }
    case 'density': {
      const notes = tracks.find((t) => t.id === spec.trackId)?.midi?.notes
      return notes ? noteDensity(notes, spec.window) : ZERO
    }
    case 'beat':
      return beatClock(bpm, spec.division, spec.decay)
  }
}
