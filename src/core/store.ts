import { useSyncExternalStore } from 'react'
import type {
  AudioTrackData, LayerConfig, LayerKind, MappingConfig, MidiTrackData,
  Photo, ProjectFile, Track,
} from './types'
import { PARAM_DEFS } from './params'

let idCounter = 1
export const uid = (prefix: string) => `${prefix}_${idCounter++}`

export const baseName = (fileName: string) =>
  fileName.replace(/\.[^.]+$/, '').toLowerCase()

/** After loading a project file, dropped assets re-link by file name. */
interface PendingAssets {
  audio: Map<string, string> // fileName -> trackId
  midi: Map<string, string>
  photos: Map<string, string> // fileName -> saved photoId
}

/**
 * Undo snapshot: structural data is deep-cloned; tracks/photos are reference
 * lists (membership is undoable, the heavy AudioBuffers/bitmaps are shared).
 */
interface Snapshot {
  bpm: number
  seed: number
  tracks: Track[]
  photos: Photo[]
  layers: LayerConfig[]
  mappings: MappingConfig[]
  fxBase: Record<string, number>
  fxRegions: [number, number][]
  fxEnabled: boolean
}

class ProjectStore {
  bpm = 200
  seed = 1234
  tracks: Track[] = []
  photos: Photo[] = []
  layers: LayerConfig[] = []
  mappings: MappingConfig[] = []
  pending: PendingAssets | null = null
  /** fileName -> absolute path (Electron only; lets projects reload themselves) */
  assetPaths = new Map<string, string>()
  /** timeline clicks magnetize to the beat grid (Alt bypasses temporarily) */
  snapEnabled = true
  /** static base levels for FX params (mappings add on top) */
  fxBase: Record<string, number> = {}
  /** FX chain gate regions + master toggle (mirrors layer gating) */
  fxRegions: [number, number][] = []
  fxEnabled = true

  setFxBase(key: string, value: number) {
    this.checkpoint()
    this.fxBase[key] = value
    this.touch()
  }

  toggleSnap() {
    this.snapEnabled = !this.snapEnabled
    this.touch()
  }

  version = 0
  private listeners = new Set<() => void>()
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  touch() {
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  // --- undo/redo ------------------------------------------------------------

  private undoStack: Snapshot[] = []
  private redoStack: Snapshot[] = []
  private lastCheckpoint = 0
  private inGesture = false

  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }

  private capture(): Snapshot {
    return {
      bpm: this.bpm,
      seed: this.seed,
      tracks: [...this.tracks],
      photos: [...this.photos],
      layers: structuredClone(this.layers),
      mappings: structuredClone(this.mappings),
      fxBase: { ...this.fxBase },
      fxRegions: structuredClone(this.fxRegions),
      fxEnabled: this.fxEnabled,
    }
  }

  /**
   * Push an undo step for the state as it is NOW — called at the top of every
   * undoable mutation. Rapid mutations within 500ms coalesce into one step,
   * and none are taken mid-gesture (slider/region drags = one step total).
   */
  private checkpoint(force = false) {
    if (this.inGesture) return
    const now = Date.now()
    if (!force && now - this.lastCheckpoint < 500) return
    this.lastCheckpoint = now
    this.undoStack.push(this.capture())
    if (this.undoStack.length > 100) this.undoStack.shift()
    this.redoStack.length = 0
  }

  beginGesture() {
    this.checkpoint(true)
    this.inGesture = true
  }

  endGesture() {
    this.inGesture = false
    this.lastCheckpoint = 0
  }

  private restore(s: Snapshot) {
    this.bpm = s.bpm
    this.seed = s.seed
    this.tracks = [...s.tracks]
    this.photos = [...s.photos]
    this.layers = structuredClone(s.layers)
    this.mappings = structuredClone(s.mappings)
    this.fxBase = { ...s.fxBase }
    this.fxRegions = structuredClone(s.fxRegions)
    this.fxEnabled = s.fxEnabled
    this.lastCheckpoint = 0
    this.touch()
  }

  undo() {
    const snap = this.undoStack.pop()
    if (!snap) return
    this.redoStack.push(this.capture())
    this.restore(snap)
  }

  redo() {
    const snap = this.redoStack.pop()
    if (!snap) return
    this.undoStack.push(this.capture())
    this.restore(snap)
  }

  setBpm(bpm: number) {
    this.checkpoint()
    this.bpm = Math.max(1, bpm)
    for (const t of this.tracks) this.retime(t)
    this.touch()
  }

  /**
   * MIDI files with no tempo event get parsed at the MIDI-default 120 BPM,
   * which lands every note late at faster tempos — recompute times from raw
   * ticks using the project bpm instead.
   */
  private retime(track: Track) {
    if (!track.midi || track.midi.bpm !== null) return
    const secPerTick = 60 / this.bpm / track.midi.ppq
    for (const n of track.midi.notes) {
      n.time = n.ticks * secPerTick
      n.duration = n.durationTicks * secPerTick
    }
  }

  // --- tracks -------------------------------------------------------------

  private trackForFile(fileName: string, slot: 'audio' | 'midi'): Track {
    const pendingId = this.pending?.[slot].get(fileName)
    if (pendingId) {
      const t = this.tracks.find((t) => t.id === pendingId)
      if (t) {
        this.pending![slot].delete(fileName)
        return t
      }
    }
    const base = baseName(fileName)
    const match = this.tracks.find((t) => baseName(t.name) === base && !t[slot])
    if (match) return match
    const track: Track = {
      id: uid('track'), name: base, audio: null, midi: null, muted: false, solo: false,
    }
    this.tracks.push(track)
    return track
  }

  addAudio(fileName: string, data: AudioTrackData) {
    // re-ingest of a known file (file watcher / re-drop) replaces in place
    const existing = this.tracks.find((t) => t.audio?.fileName === fileName)
    if (existing) existing.audio = data
    else this.trackForFile(fileName, 'audio').audio = data
    this.touch()
  }

  addMidi(fileName: string, data: MidiTrackData) {
    const track = this.tracks.find((t) => t.midi?.fileName === fileName)
      ?? this.trackForFile(fileName, 'midi')
    track.midi = data
    if (data.bpm && this.tracks.every((t) => t.midi === data || !t.midi)) {
      this.bpm = Math.round(data.bpm * 100) / 100
    }
    this.retime(track)
    this.touch()
  }

  toggleMute(trackId: string) {
    const t = this.tracks.find((t) => t.id === trackId)
    if (t) { t.muted = !t.muted; this.touch() }
  }

  toggleSolo(trackId: string) {
    const t = this.tracks.find((t) => t.id === trackId)
    if (t) { t.solo = !t.solo; this.touch() }
  }

  /** solo anywhere overrides mutes: only soloed tracks are audible */
  isAudible(track: Track): boolean {
    const anySolo = this.tracks.some((t) => t.solo)
    return anySolo ? track.solo : !track.muted
  }

  removeTrack(trackId: string) {
    this.checkpoint()
    this.tracks = this.tracks.filter((t) => t.id !== trackId)
    this.mappings = this.mappings.filter(
      (m) => !('trackId' in m.source) || m.source.trackId !== trackId,
    )
    this.touch()
  }

  get duration(): number {
    let d = 0
    for (const t of this.tracks) {
      if (t.audio) d = Math.max(d, t.audio.buffer.duration)
      if (t.midi) for (const n of t.midi.notes) d = Math.max(d, n.time + n.duration)
    }
    return d
  }

  // --- photos -------------------------------------------------------------

  addPhoto(fileName: string, bitmap: ImageBitmap) {
    const existing = this.photos.find((p) => p.name === fileName)
    if (existing) { existing.bitmap = bitmap; this.touch(); return }
    const savedId = this.pending?.photos.get(fileName)
    if (savedId) this.pending!.photos.delete(fileName)
    const photo: Photo = { id: savedId ?? uid('photo'), name: fileName, bitmap }
    this.photos.push(photo)
    // photo/shard layers pick up new photos automatically
    for (const l of this.layers) {
      if ((l.kind === 'photo' || l.kind === 'shards') && !this.pending) l.photoIds.push(photo.id)
    }
    this.touch()
  }

  removePhoto(photoId: string) {
    this.checkpoint()
    this.photos = this.photos.filter((p) => p.id !== photoId)
    for (const l of this.layers) l.photoIds = l.photoIds.filter((id) => id !== photoId)
    this.touch()
  }

  // --- layers -------------------------------------------------------------

  addLayer(kind: LayerKind): LayerConfig {
    this.checkpoint()
    const params: Record<string, number> = {}
    for (const def of PARAM_DEFS[kind]) params[def.key] = def.base
    const layer: LayerConfig = {
      id: uid('layer'),
      kind,
      name: `${kind} ${this.layers.filter((l) => l.kind === kind).length + 1}`,
      photoIds: kind === 'photo' || kind === 'shards' ? this.photos.map((p) => p.id) : [],
      trackId: kind === 'scope' ? this.tracks.find((t) => t.audio)?.id : undefined,
      params,
    }
    // backgrounds go under everything by default
    if (kind === 'bg') this.layers.unshift(layer)
    else this.layers.push(layer)
    this.touch()
    return layer
  }

  setLayerTrack(layerId: string, trackId: string, slot: 1 | 2 = 1) {
    this.checkpoint()
    const l = this.layers.find((l) => l.id === layerId)
    if (!l) return
    if (slot === 1) l.trackId = trackId
    else l.trackId2 = trackId
    this.touch()
  }

  renameLayer(layerId: string, name: string) {
    this.checkpoint()
    const l = this.layers.find((l) => l.id === layerId)
    if (l) { l.name = name; this.touch() }
  }

  toggleLayerEnabled(layerId: string) {
    this.checkpoint()
    if (layerId === 'fx') { this.fxEnabled = !this.fxEnabled; this.touch(); return }
    const l = this.layers.find((l) => l.id === layerId)
    if (l) { l.enabled = !(l.enabled ?? true); this.touch() }
  }

  /** region list for a layer id — 'fx' addresses the FX chain's gate lane */
  regionsOf(layerId: string): [number, number][] | undefined {
    if (layerId === 'fx') return this.fxRegions
    const l = this.layers.find((l) => l.id === layerId)
    if (!l) return undefined
    l.regions = l.regions ?? []
    return l.regions
  }

  addLayerRegion(layerId: string, start: number, end: number): number {
    this.checkpoint()
    const regions = this.regionsOf(layerId)
    if (!regions) return -1
    regions.push([Math.max(0, Math.min(start, end)), Math.max(start, end)])
    this.touch()
    return regions.length - 1
  }

  updateLayerRegion(layerId: string, idx: number, start: number, end: number) {
    this.checkpoint()
    const region = this.regionsOf(layerId)?.[idx]
    if (!region) return
    region[0] = Math.max(0, Math.min(start, end))
    region[1] = Math.max(start, end)
    this.touch()
  }

  removeLayerRegion(layerId: string, idx: number) {
    this.checkpoint()
    const regions = this.regionsOf(layerId)
    if (regions?.[idx]) { regions.splice(idx, 1); this.touch() }
  }

  setLayerParam(layerId: string, key: string, value: number) {
    this.checkpoint()
    const l = this.layers.find((l) => l.id === layerId)
    if (l) { l.params[key] = value; this.touch() }
  }

  togglePhotoInLayer(layerId: string, photoId: string) {
    this.checkpoint()
    const l = this.layers.find((l) => l.id === layerId)
    if (!l) return
    l.photoIds = l.photoIds.includes(photoId)
      ? l.photoIds.filter((id) => id !== photoId)
      : [...l.photoIds, photoId]
    this.touch()
  }

  removeLayer(layerId: string) {
    this.checkpoint()
    this.layers = this.layers.filter((l) => l.id !== layerId)
    this.mappings = this.mappings.filter((m) => m.targetLayer !== layerId)
    this.touch()
  }

  moveLayer(layerId: string, dir: -1 | 1) {
    this.checkpoint()
    const i = this.layers.findIndex((l) => l.id === layerId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= this.layers.length) return
    ;[this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]]
    this.touch()
  }

  // --- mappings -----------------------------------------------------------

  addMapping(targetLayer?: string): MappingConfig {
    this.checkpoint()
    // busiest MIDI track is the most likely trigger source (the break, not the bass)
    const midiTrack = this.tracks
      .filter((t) => t.midi)
      .sort((a, b) => b.midi!.notes.length - a.midi!.notes.length)[0]
    const audioTrack = this.tracks.find((t) => t.audio)
    const target = targetLayer ?? this.layers[0]?.id ?? 'fx'
    const layer = this.layers.find((l) => l.id === target)
    const mapping: MappingConfig = {
      id: uid('map'),
      source: midiTrack
        ? { kind: 'trigger', trackId: midiTrack.id, decay: 0.15, pitchLo: 0, pitchHi: 127 }
        : audioTrack
          ? { kind: 'audio', trackId: audioTrack.id, band: 'rms', gain: 1 }
          : { kind: 'beat', division: 1 },
      targetLayer: target,
      targetParam: layer ? PARAM_DEFS[layer.kind][0].key : 'flash',
      scale: 1,
      curve: 1,
    }
    this.mappings.push(mapping)
    this.touch()
    return mapping
  }

  updateMapping(id: string, patch: Partial<MappingConfig>) {
    this.checkpoint()
    const m = this.mappings.find((m) => m.id === id)
    if (m) { Object.assign(m, patch); this.touch() }
  }

  removeMapping(id: string) {
    this.checkpoint()
    this.mappings = this.mappings.filter((m) => m.id !== id)
    this.touch()
  }

  // --- persistence ----------------------------------------------------------

  toJSON(): ProjectFile {
    return {
      version: 1,
      bpm: this.bpm,
      seed: this.seed,
      tracks: this.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        audioFile: t.audio?.fileName ?? null,
        midiFile: t.midi?.fileName ?? null,
      })),
      photos: this.photos.map((p) => ({ id: p.id, name: p.name })),
      layers: this.layers,
      mappings: this.mappings,
      assetPaths: Object.fromEntries(this.assetPaths),
      fxBase: this.fxBase,
      fxRegions: this.fxRegions,
      fxEnabled: this.fxEnabled,
    }
  }

  loadJSON(file: ProjectFile) {
    this.undoStack.length = 0
    this.redoStack.length = 0
    // the uid counter resets each session, but loaded ids persist — bump it
    // past every loaded id or new layers would mint duplicates (which makes
    // gates/expansion/mappings hit the wrong layer)
    const bump = (id: string) => {
      const m = /_(\d+)$/.exec(id)
      if (m) idCounter = Math.max(idCounter, Number(m[1]) + 1)
    }
    file.tracks.forEach((t) => bump(t.id))
    file.photos.forEach((p) => bump(p.id))
    file.layers.forEach((l) => bump(l.id))
    file.mappings.forEach((m) => bump(m.id))

    this.bpm = file.bpm
    this.seed = file.seed
    this.layers = file.layers
    this.mappings = file.mappings
    this.fxBase = file.fxBase ?? {}
    this.fxRegions = file.fxRegions ?? []
    this.fxEnabled = file.fxEnabled ?? true

    // repair projects saved while duplicates existed
    const seen = new Set<string>()
    for (const l of this.layers) {
      if (seen.has(l.id)) l.id = uid('layer')
      seen.add(l.id)
    }
    this.photos = []
    this.tracks = file.tracks.map((t) => ({
      id: t.id, name: t.name, audio: null, midi: null, muted: false, solo: false,
    }))
    this.pending = { audio: new Map(), midi: new Map(), photos: new Map() }
    for (const t of file.tracks) {
      if (t.audioFile) this.pending.audio.set(t.audioFile, t.id)
      if (t.midiFile) this.pending.midi.set(t.midiFile, t.id)
    }
    for (const p of file.photos) this.pending.photos.set(p.name, p.id)
    this.assetPaths = new Map(Object.entries(file.assetPaths ?? {}))
    this.touch()
  }

  missingAssets(): string[] {
    if (!this.pending) return []
    return [
      ...this.pending.audio.keys(),
      ...this.pending.midi.keys(),
      ...this.pending.photos.keys(),
    ]
  }
}

export const project = new ProjectStore()

export function useProject(): ProjectStore {
  useSyncExternalStore(project.subscribe, () => project.version)
  return project
}
