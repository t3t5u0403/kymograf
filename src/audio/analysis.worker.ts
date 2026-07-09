/**
 * Offline loudness analysis: RMS + low/mid/high band envelopes sampled at
 * ENV_RATE Hz, normalized to ~0..1 by the 99th percentile. Runs once per stem.
 */
const ENV_RATE = 120

type FilterType = 'lowpass' | 'bandpass' | 'highpass'

function biquad(
  input: Float32Array,
  sampleRate: number,
  type: FilterType,
  f0: number,
  q: number,
): Float32Array {
  const w0 = (2 * Math.PI * f0) / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const cosw = Math.cos(w0)
  let b0: number, b1: number, b2: number
  if (type === 'lowpass') {
    b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2
  } else if (type === 'highpass') {
    b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2
  } else {
    b0 = alpha; b1 = 0; b2 = -alpha
  }
  const a0 = 1 + alpha
  const a1 = -2 * cosw
  const a2 = 1 - alpha
  const out = new Float32Array(input.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    out[i] = y0
    x2 = x1; x1 = x0; y2 = y1; y1 = y0
  }
  return out
}

function rmsEnvelope(signal: Float32Array, sampleRate: number): Float32Array {
  const frames = Math.ceil((signal.length / sampleRate) * ENV_RATE)
  const win = Math.round((2 * sampleRate) / ENV_RATE)
  const out = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const start = Math.floor((f * sampleRate) / ENV_RATE)
    const end = Math.min(signal.length, start + win)
    let sum = 0
    for (let i = start; i < end; i++) sum += signal[i] * signal[i]
    out[f] = Math.sqrt(sum / Math.max(1, end - start))
  }
  return out
}

function normalize(env: Float32Array): Float32Array {
  const sample: number[] = []
  const step = Math.max(1, Math.floor(env.length / 8192))
  for (let i = 0; i < env.length; i += step) sample.push(env[i])
  sample.sort((a, b) => a - b)
  const p99 = sample[Math.floor(sample.length * 0.99)] || 0
  if (p99 <= 0) return env
  for (let i = 0; i < env.length; i++) {
    env[i] = Math.min(1.5, env[i] / p99)
  }
  return env
}

self.onmessage = (e: MessageEvent) => {
  const { id, channel, sampleRate } = e.data as {
    id: number
    channel: Float32Array
    sampleRate: number
  }
  const rms = normalize(rmsEnvelope(channel, sampleRate))
  const low = normalize(rmsEnvelope(biquad(channel, sampleRate, 'lowpass', 200, 0.707), sampleRate))
  const mid = normalize(rmsEnvelope(biquad(channel, sampleRate, 'bandpass', 1000, 0.6), sampleRate))
  const high = normalize(rmsEnvelope(biquad(channel, sampleRate, 'highpass', 2500, 0.707), sampleRate))
  ;(self as unknown as Worker).postMessage(
    { id, rate: ENV_RATE, rms, low, mid, high },
    [rms.buffer, low.buffer, mid.buffer, high.buffer],
  )
}
