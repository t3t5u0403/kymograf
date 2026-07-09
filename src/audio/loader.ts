import type { AudioTrackData, Envelopes } from '../core/types'
import { transport } from '../core/transport'

const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), {
  type: 'module',
})
let reqId = 0
const pending = new Map<number, (env: Envelopes) => void>()
worker.onmessage = (e: MessageEvent) => {
  const { id, ...env } = e.data
  pending.get(id)?.(env as Envelopes)
  pending.delete(id)
}

function analyze(mono: Float32Array, sampleRate: number): Promise<Envelopes> {
  return new Promise((resolve) => {
    const id = ++reqId
    pending.set(id, resolve)
    worker.postMessage({ id, channel: mono, sampleRate }, [mono.buffer])
  })
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < data.length; i++) out[i] += data[i]
  }
  const gain = 1 / buffer.numberOfChannels
  for (let i = 0; i < out.length; i++) out[i] *= gain
  return out
}

function computePeaks(mono: Float32Array, bins: number): Float32Array {
  const peaks = new Float32Array(bins * 2)
  const per = mono.length / bins
  for (let b = 0; b < bins; b++) {
    let min = 0
    let max = 0
    const start = Math.floor(b * per)
    const end = Math.min(mono.length, Math.ceil((b + 1) * per))
    for (let i = start; i < end; i++) {
      if (mono[i] < min) min = mono[i]
      if (mono[i] > max) max = mono[i]
    }
    peaks[b * 2] = min
    peaks[b * 2 + 1] = max
  }
  return peaks
}

export async function loadAudioFile(file: File): Promise<AudioTrackData> {
  const buffer = await transport.ctx.decodeAudioData(await file.arrayBuffer())
  const mono = mixToMono(buffer)
  const peaks = computePeaks(mono, 4096)
  const envelopes = await analyze(mono, buffer.sampleRate) // transfers `mono`
  return { fileName: file.name, buffer, envelopes, peaks }
}
