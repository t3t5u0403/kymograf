import {
  Application, ColorMatrixFilter, Container, Graphics, NoiseFilter, RenderTexture, Sprite, Texture,
} from 'pixi.js'
import {
  BulgePinchFilter, CRTFilter, GlitchFilter, PixelateFilter, RGBSplitFilter,
  TwistFilter, ZoomBlurFilter,
} from 'pixi-filters'
import { randAt } from '../core/rand'
import type { project as ProjectStore } from '../core/store'
import type { LayerKind } from '../core/types'
import type { FrameParams } from '../mapping/engine'
import { createLayer, type LayerObj } from './layers'

type Project = typeof ProjectStore

export const STAGE_W = 1920
export const STAGE_H = 1080

/**
 * Photosensitivity guard: hard-caps full-frame flash events (white flashes +
 * invert toggles combined) to 3 per rolling second. Not opt-in.
 */
class StrobeGuard {
  private events: number[] = []
  private invertState = 0
  private prevRawFlash = 0
  private lastT = -1

  private allow(t: number): boolean {
    this.events = this.events.filter((x) => t - x < 1)
    if (this.events.length < 3) { this.events.push(t); return true }
    return false
  }

  apply(t: number, rawFlash: number, rawInvert: number): { flash: number; invert: number } {
    if (t < this.lastT - 1e-4) this.reset()
    this.lastT = t
    let flash = rawFlash
    if (this.prevRawFlash < 0.5 && rawFlash >= 0.5 && !this.allow(t)) flash = 0.45
    this.prevRawFlash = rawFlash
    const want = rawInvert >= 0.5 ? 1 : 0
    if (want !== this.invertState && this.allow(t)) this.invertState = want
    return { flash, invert: this.invertState }
  }

  reset() {
    this.events = []
    this.invertState = 0
    this.prevRawFlash = 0
    this.lastT = -1
  }
}

/**
 * The render stage: layer stack → scene texture → feedback composite →
 * filtered output. `render(t, evaluate, project)` is deterministic in t
 * (modulo the feedback/stutter temporal state, which is reset per export).
 */
export class Stage {
  readonly app = new Application()
  private scene = new Container()
  private layerObjs = new Map<string, { kind: LayerKind; obj: LayerObj }>()
  private textures = new Map<string, Texture>()

  private sceneRT!: RenderTexture
  private rtA!: RenderTexture
  private rtB!: RenderTexture
  private sceneSprite = new Sprite()
  private feedbackSprite = new Sprite()
  private compose = new Container()
  private outSprite = new Sprite()
  private flashG = new Graphics()
  private rgb = new RGBSplitFilter({ red: [0, 0], green: [0, 0], blue: [0, 0] })
  private cm = new ColorMatrixFilter()
  private glitch = new GlitchFilter({ slices: 10, offset: 0 })
  private glitchSizes = new Float32Array(10)
  private glitchOffsets = new Float32Array(10)
  private pixelate = new PixelateFilter(10)
  private zoomBlur = new ZoomBlurFilter({ strength: 0, center: [STAGE_W / 2, STAGE_H / 2], innerRadius: 60 })
  private crt = new CRTFilter({ curvature: 1.5, lineWidth: 3, noiseSize: 1, vignetting: 0.3 })
  private noise = new NoiseFilter({ noise: 0 })
  private twist = new TwistFilter({ angle: 0, radius: STAGE_H * 0.75, offset: { x: STAGE_W / 2, y: STAGE_H / 2 } })
  private bulge = new BulgePinchFilter({ strength: 0, radius: STAGE_H * 0.75, center: [0.5, 0.5] })
  private guard = new StrobeGuard()
  private syncVersion = -1
  ready = false

  async init(): Promise<HTMLCanvasElement> {
    await this.app.init({
      width: STAGE_W,
      height: STAGE_H,
      background: '#000000',
      antialias: true,
      preserveDrawingBuffer: true, // required for VideoFrame capture at export
      autoStart: false,
      sharedTicker: false,
      preference: 'webgl',
    })
    this.app.ticker.stop()
    const opts = { width: STAGE_W, height: STAGE_H, antialias: true }
    this.sceneRT = RenderTexture.create(opts)
    this.rtA = RenderTexture.create(opts)
    this.rtB = RenderTexture.create(opts)
    this.feedbackSprite.anchor.set(0.5)
    this.feedbackSprite.position.set(STAGE_W / 2, STAGE_H / 2)
    this.compose.addChild(this.sceneSprite, this.feedbackSprite)
    this.outSprite.anchor.set(0.5)
    this.outSprite.position.set(STAGE_W / 2, STAGE_H / 2)
    // warp → pixel ops → color; zeroed filters are disabled per-frame for perf
    this.outSprite.filters = [
      this.twist, this.bulge, this.pixelate, this.glitch, this.zoomBlur,
      this.rgb, this.crt, this.noise, this.cm,
    ]
    this.flashG.rect(0, 0, STAGE_W, STAGE_H).fill(0xffffff)
    this.flashG.alpha = 0
    this.app.stage.addChild(this.outSprite, this.flashG)
    this.ready = true
    return this.app.canvas
  }

  /** reconcile pixi objects with the project (cached against project.version) */
  private sync(project: Project) {
    if (project.version === this.syncVersion) return
    this.syncVersion = project.version
    for (const photo of project.photos) {
      if (!this.textures.has(photo.id)) this.textures.set(photo.id, Texture.from(photo.bitmap))
    }
    const wanted = new Set(project.layers.map((l) => l.id))
    for (const [id, entry] of this.layerObjs) {
      if (!wanted.has(id)) { entry.obj.destroy(); this.layerObjs.delete(id) }
    }
    for (const l of project.layers) {
      const existing = this.layerObjs.get(l.id)
      if (!existing || existing.kind !== l.kind) {
        existing?.obj.destroy()
        this.layerObjs.set(l.id, { kind: l.kind, obj: createLayer(l.kind) })
      }
    }
    this.scene.removeChildren()
    for (const l of project.layers) this.scene.addChild(this.layerObjs.get(l.id)!.obj.container)
  }

  /** clear feedback/stutter/strobe state (called on seek-back and before export) */
  resetTemporal() {
    this.guard.reset()
    if (!this.ready) return
    const empty = new Container()
    this.app.renderer.render({ container: empty, target: this.rtA, clear: true, clearColor: '#000000' })
    this.app.renderer.render({ container: empty, target: this.rtB, clear: true, clearColor: '#000000' })
  }

  render(t: number, evaluate: (t: number) => FrameParams, project: Project) {
    if (!this.ready) return
    this.sync(project)

    let frame = evaluate(t)
    // stutter is a time-warp: quantize t and the whole scene re-renders the
    // held instant — a true deterministic frame-repeat
    const stutter = frame.fx.stutter
    if (stutter > 0.25) {
      const step = (2 + Math.round(stutter * 10)) / 60
      const tq = Math.floor(t / step) * step
      frame = evaluate(tq)
      t = tq
    }

    const ctx = {
      textures: this.textures,
      tracks: project.tracks,
      seed: project.seed,
      t,
      W: STAGE_W,
      H: STAGE_H,
    }
    for (const l of project.layers) {
      const obj = this.layerObjs.get(l.id)?.obj
      if (!obj) continue
      const active = (l.enabled ?? true)
        && (!l.regions?.length || l.regions.some((r) => t >= r[0] && t < r[1]))
      obj.container.visible = active
      if (active) obj.update(l, frame.layers.get(l.id) ?? l.params, ctx)
    }

    const r = this.app.renderer
    r.render({ container: this.scene, target: this.sceneRT, clear: true, clearColor: '#000000' })

    // previous output echoes over the new frame, zoomed/rotated — decays as alpha^n
    this.sceneSprite.texture = this.sceneRT
    this.feedbackSprite.texture = this.rtB
    const fb = frame.fx.feedback
    this.feedbackSprite.visible = fb > 0.001
    this.feedbackSprite.alpha = fb
    this.feedbackSprite.scale.set(frame.fx.fbZoom)
    this.feedbackSprite.rotation = frame.fx.fbRotate
    r.render({ container: this.compose, target: this.rtA, clear: true, clearColor: '#000000' })

    const { flash, invert } = this.guard.apply(t, frame.fx.flash, frame.fx.invert)
    const fx = frame.fx
    this.outSprite.texture = this.rtA
    const frameKey = Math.floor(t * 60)
    const fxSeed = project.seed ^ frameKey

    // impact transforms: zoom punch + seeded shake
    const shake = (fx.shake ?? 0) * 45
    this.outSprite.scale.set(1 + (fx.punch ?? 0) * 0.15)
    this.outSprite.position.set(
      STAGE_W / 2 + (randAt(fxSeed, 901) - 0.5) * 2 * shake,
      STAGE_H / 2 + (randAt(fxSeed, 902) - 0.5) * 2 * shake,
    )

    const split = fx.rgbSplit
    this.rgb.enabled = split > 0.01
    this.rgb.red = { x: -split, y: 0 }
    this.rgb.blue = { x: split, y: 0 }
    this.rgb.green = { x: 0, y: split * 0.35 }

    // slice glitch: pattern re-rolls every few frames, fully seeded
    const gl = fx.glitch ?? 0
    this.glitch.enabled = gl > 0.01
    if (this.glitch.enabled) {
      const gseed = project.seed ^ Math.floor(frameKey / 3)
      let total = 0
      for (let i = 0; i < 10; i++) {
        this.glitchSizes[i] = 0.05 + randAt(gseed, i)
        total += this.glitchSizes[i]
        this.glitchOffsets[i] = (randAt(gseed, i + 50) - 0.5) * 2
      }
      for (let i = 0; i < 10; i++) this.glitchSizes[i] /= total
      this.glitch.sizes = this.glitchSizes
      this.glitch.offsets = this.glitchOffsets
      this.glitch.offset = gl * 100
    }

    const px = fx.pixelate ?? 0
    this.pixelate.enabled = px > 0.01
    if (this.pixelate.enabled) this.pixelate.size = 1 + px * 47

    const zb = fx.zoomBlur ?? 0
    this.zoomBlur.enabled = zb > 0.01
    if (this.zoomBlur.enabled) this.zoomBlur.strength = zb * 0.35

    const crtAmt = fx.crt ?? 0
    this.crt.enabled = crtAmt > 0.01
    if (this.crt.enabled) {
      this.crt.time = t * 30
      this.crt.seed = randAt(fxSeed, 903)
      this.crt.lineContrast = crtAmt * 0.3
      this.crt.noise = crtAmt * 0.2
      this.crt.vignettingAlpha = crtAmt
    }

    const grain = fx.grain ?? 0
    this.noise.enabled = grain > 0.01
    if (this.noise.enabled) {
      this.noise.noise = grain * 0.6
      this.noise.seed = randAt(fxSeed, 904)
    }

    const tw = fx.twist ?? 0
    this.twist.enabled = Math.abs(tw) > 0.005
    if (this.twist.enabled) this.twist.angle = tw * 8

    const bg = fx.bulge ?? 0
    this.bulge.enabled = Math.abs(bg) > 0.005
    if (this.bulge.enabled) this.bulge.strength = bg * 0.8

    this.cm.reset()
    const hueShift = fx.hueShift ?? 0
    const sat = fx.saturate ?? 0
    const con = fx.contrast ?? 0
    if (hueShift > 0.5) this.cm.hue(hueShift, true)
    if (Math.abs(sat) > 0.005) this.cm.saturate(sat, true)
    if (Math.abs(con) > 0.005) this.cm.contrast(con, true)
    if (invert) this.cm.negative(true)
    this.cm.enabled = hueShift > 0.5 || Math.abs(sat) > 0.005 || Math.abs(con) > 0.005 || invert > 0

    this.flashG.alpha = flash
    this.app.render()
    ;[this.rtA, this.rtB] = [this.rtB, this.rtA]
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas
  }
}
