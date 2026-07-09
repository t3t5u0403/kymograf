import { project } from './store'

/**
 * Playback transport. The AudioContext clock is the master clock —
 * the render loop asks `transport.time()` every frame and draws that instant.
 */
class Transport {
  readonly ctx = new AudioContext()
  private master = this.ctx.createGain()
  private sources: AudioBufferSourceNode[] = []
  playing = false
  private startCtx = 0
  private offset = 0

  loopStart = 0
  loopEnd = 0
  loopEnabled = false

  constructor() {
    this.master.gain.value = 0.9
    this.master.connect(this.ctx.destination)
  }

  /** highlighted time range on the timeline (drag across a track lane) */
  selection: [number, number] | null = null

  get loopValid(): boolean {
    return this.loopEnd > this.loopStart + 0.01
  }

  get selectionValid(): boolean {
    return !!this.selection && this.selection[1] - this.selection[0] > 0.01
  }

  setSelection(a: number, b: number) {
    this.selection = [Math.min(a, b), Math.max(a, b)]
    project.touch()
  }

  clearSelection() {
    if (!this.selection) return
    this.selection = null
    project.touch()
  }

  /** ctrl+L / loop button: selection becomes the loop, else toggle loop */
  applyLoopOrToggle() {
    if (this.selectionValid) {
      this.loopStart = this.selection![0]
      this.loopEnd = this.selection![1]
      this.loopEnabled = true
      this.selection = null
      if (this.playing) this.refresh()
      project.touch()
    } else {
      this.toggleLoop()
    }
  }

  private get looping(): boolean {
    return this.loopEnabled && this.loopValid
  }

  setLoop(start: number, end: number) {
    this.loopStart = Math.max(0, Math.min(start, end))
    this.loopEnd = Math.max(start, end)
    if (this.playing) this.refresh()
    project.touch()
  }

  toggleLoop() {
    if (!this.loopValid) return
    this.loopEnabled = !this.loopEnabled
    if (this.playing) this.refresh()
    project.touch()
  }

  time(): number {
    const raw = this.playing
      ? this.offset + Math.max(0, this.ctx.currentTime - this.startCtx)
      : this.offset
    let t = raw
    // audio engine loops sample-accurately; map wall-time onto the loop
    if (this.playing && this.looping && raw > this.loopEnd) {
      const len = this.loopEnd - this.loopStart
      t = this.loopStart + ((raw - this.loopEnd) % len)
    }
    return Math.min(t, project.duration)
  }

  async play() {
    if (this.playing) return
    await this.ctx.resume()
    if (this.offset >= project.duration) this.offset = 0
    if (this.looping && this.offset >= this.loopEnd) this.offset = this.loopStart
    const when = this.ctx.currentTime + 0.08
    for (const track of project.tracks) {
      if (!track.audio || !project.isAudible(track)) continue
      if (this.offset >= track.audio.buffer.duration) continue
      const src = this.ctx.createBufferSource()
      src.buffer = track.audio.buffer
      // sample-accurate looping via the source itself — only when the stem is
      // long enough to contain the region, else stems would wrap out of sync
      if (this.looping && track.audio.buffer.duration >= this.loopEnd - 0.001) {
        src.loop = true
        src.loopStart = this.loopStart
        src.loopEnd = this.loopEnd
      }
      src.connect(this.master)
      src.start(when, this.offset)
      this.sources.push(src)
    }
    this.startCtx = when
    this.playing = true
    project.touch()
  }

  pause() {
    if (!this.playing) return
    this.offset = this.time()
    this.playing = false
    for (const s of this.sources) { try { s.stop() } catch { /* not started yet */ } }
    this.sources = []
    project.touch()
  }

  seek(t: number) {
    const wasPlaying = this.playing
    this.pause()
    this.offset = Math.max(0, Math.min(t, project.duration))
    if (wasPlaying) void this.play()
    project.touch()
  }

  /** restart playback with current mute states */
  refresh() {
    if (this.playing) { this.pause(); void this.play() }
  }
}

export const transport = new Transport()
