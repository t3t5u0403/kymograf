export interface NoteEvent {
  time: number // seconds
  duration: number
  midi: number // pitch 0-127
  velocity: number // 0-1
  ticks: number
  durationTicks: number
}

/** Per-band loudness envelopes sampled at `rate` Hz, computed once at load. */
export interface Envelopes {
  rate: number
  rms: Float32Array
  low: Float32Array
  mid: Float32Array
  high: Float32Array
}

export interface AudioTrackData {
  fileName: string
  buffer: AudioBuffer
  envelopes: Envelopes
  /** min/max peak pairs for waveform drawing */
  peaks: Float32Array
}

export interface MidiTrackData {
  fileName: string
  notes: NoteEvent[]
  /** tempo found in the file; null = none, note times must be derived from project bpm */
  bpm: number | null
  ppq: number
}

export interface Track {
  id: string
  name: string
  audio: AudioTrackData | null
  midi: MidiTrackData | null
  muted: boolean
  solo: boolean
}

export interface Photo {
  id: string
  name: string
  bitmap: ImageBitmap
}

export type LayerKind = 'photo' | 'shards' | 'shapes' | 'scope' | 'bg'

export interface LayerConfig {
  id: string
  kind: LayerKind
  name: string
  photoIds: string[]
  /** audio source track (scope layers) */
  trackId?: string
  /** second audio source — Y axis for lissajous scope mode */
  trackId2?: string
  /** master on/off (toggled from the timeline label) */
  enabled?: boolean
  /** active time regions [start, end) in seconds; empty/undefined = always on */
  regions?: [number, number][]
  /** base values for mappable params; mappings add on top each frame */
  params: Record<string, number>
}

export type Band = 'rms' | 'low' | 'mid' | 'high'

export type SignalSpec =
  | { kind: 'trigger'; trackId: string; decay: number; pitchLo: number; pitchHi: number }
  | { kind: 'audio'; trackId: string; band: Band; gain: number }
  | { kind: 'density'; trackId: string; window: number }
  | { kind: 'beat'; division: number; decay?: number }

export interface MappingConfig {
  id: string
  source: SignalSpec
  /** layer id, or 'fx' for the post-processing chain */
  targetLayer: string
  targetParam: string
  scale: number
  curve: number // pow exponent applied to the 0..1 signal
}

/**
 * Serializable project file. Assets are referenced by file name (re-linked by
 * re-drop in the browser); `assetPaths` holds absolute paths so the Electron
 * shell can reload everything automatically.
 */
export interface ProjectFile {
  version: 1
  bpm: number
  seed: number
  tracks: { id: string; name: string; audioFile: string | null; midiFile: string | null }[]
  photos: { id: string; name: string }[]
  layers: LayerConfig[]
  mappings: MappingConfig[]
  assetPaths?: Record<string, string>
  fxBase?: Record<string, number>
  fxRegions?: [number, number][]
  fxEnabled?: boolean
}
