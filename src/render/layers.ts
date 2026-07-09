import {
  ColorMatrixFilter, Container, Graphics, Rectangle, Sprite, Texture,
} from 'pixi.js'
import { hashString, randAt } from '../core/rand'
import type { LayerConfig, LayerKind, Track } from '../core/types'

export interface LayerCtx {
  textures: Map<string, Texture>
  tracks: Track[]
  seed: number
  t: number
  W: number
  H: number
}

/** hsl (h 0-360, s/l 0-1) -> 0xRRGGBB; sat 0 stays pure white/gray */
export function hsl(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255)
  }
  return (f(0) << 16) | (f(8) << 8) | f(4)
}

export interface LayerObj {
  readonly container: Container
  update(cfg: LayerConfig, params: Record<string, number>, ctx: LayerCtx): void
  destroy(): void
}

const clampInt = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)))

/**
 * Deterministic random walk over the photo pool that never repeats the same
 * photo on consecutive cuts — pure function of (seed, count), incrementally
 * memoized so dense breaks stay cheap.
 */
class PhotoWalk {
  private seed = 0
  private len = 0
  private count = 0
  private idx = 0

  pick(pool: string[], seed: number, count: number): string {
    if (pool.length === 1) return pool[0]
    if (seed !== this.seed || pool.length !== this.len || count < this.count) {
      this.seed = seed
      this.len = pool.length
      this.count = 0
      this.idx = 0
    }
    for (let c = this.count + 1; c <= count; c++) {
      this.idx = (this.idx + 1 + Math.floor(randAt(seed, c) * (this.len - 1))) % this.len
    }
    this.count = count
    return pool[this.idx]
  }
}

// --- photo ------------------------------------------------------------------

class PhotoLayer implements LayerObj {
  container = new Container()
  private sprite = new Sprite()
  private cm = new ColorMatrixFilter()
  private walk = new PhotoWalk()

  constructor() {
    this.sprite.anchor.set(0.5)
    this.container.addChild(this.sprite)
    this.container.filters = [this.cm]
  }

  update(cfg: LayerConfig, p: Record<string, number>, ctx: LayerCtx) {
    const pool = cfg.photoIds.filter((id) => ctx.textures.has(id))
    if (!pool.length) { this.sprite.visible = false; return }
    const layerSeed = ctx.seed ^ hashString(cfg.id)
    const count = Math.floor(p.cut ?? 0)
    const tex = ctx.textures.get(this.walk.pick(pool, layerSeed, count))!
    this.sprite.visible = true
    if (this.sprite.texture !== tex) this.sprite.texture = tex
    // every cut lands with a slightly different crop — keeps fast cuts alive
    const jitterScale = 1 + (randAt(layerSeed, count, 1) - 0.5) * 0.12
    const jx = (randAt(layerSeed, count, 2) - 0.5) * 0.08 * ctx.W
    const jy = (randAt(layerSeed, count, 3) - 0.5) * 0.08 * ctx.H
    const cover = Math.max(ctx.W / tex.width, ctx.H / tex.height)
    this.sprite.scale.set(cover * (p.scale ?? 1) * jitterScale)
    this.sprite.position.set(ctx.W / 2 + jx, ctx.H / 2 + jy)
    this.sprite.alpha = p.alpha ?? 1
    this.cm.reset()
    const b = p.brightness ?? 1
    if (b !== 1) this.cm.brightness(b, false)
  }

  destroy() { this.container.destroy({ children: true }) }
}

// --- shards -----------------------------------------------------------------

class ShardLayer implements LayerObj {
  container = new Container()
  private inner = new Container()
  private cells: Sprite[] = []
  private subTextures: Texture[] = []
  private builtKey = ''
  private texSize = { w: 1, h: 1 }
  private walk = new PhotoWalk()

  constructor() {
    this.container.addChild(this.inner)
  }

  private rebuild(tex: Texture, grid: number) {
    for (const s of this.cells) s.destroy()
    for (const t of this.subTextures) t.destroy()
    this.cells = []
    this.subTextures = []
    this.inner.removeChildren()
    const cw = tex.width / grid
    const ch = tex.height / grid
    for (let j = 0; j < grid; j++) {
      for (let i = 0; i < grid; i++) {
        const sub = new Texture({
          source: tex.source,
          frame: new Rectangle(tex.frame.x + i * cw, tex.frame.y + j * ch, cw, ch),
        })
        const sprite = new Sprite(sub)
        sprite.anchor.set(0.5)
        this.inner.addChild(sprite)
        this.cells.push(sprite)
        this.subTextures.push(sub)
      }
    }
    this.texSize = { w: tex.width, h: tex.height }
    this.inner.pivot.set(tex.width / 2, tex.height / 2)
  }

  update(cfg: LayerConfig, p: Record<string, number>, ctx: LayerCtx) {
    const pool = cfg.photoIds.filter((id) => ctx.textures.has(id))
    if (!pool.length) { this.inner.visible = false; return }
    this.inner.visible = true
    const layerSeed = ctx.seed ^ hashString(cfg.id)
    const count = Math.floor(p.cut ?? 0)
    const grid = clampInt(p.grid ?? 5, 2, 12)
    const photoId = this.walk.pick(pool, layerSeed, count)
    const tex = ctx.textures.get(photoId)!
    const key = `${photoId}:${grid}`
    if (key !== this.builtKey) { this.rebuild(tex, grid); this.builtKey = key }

    const cw = this.texSize.w / grid
    const ch = this.texSize.h / grid
    const displace = p.displace ?? 0
    for (let k = 0; k < this.cells.length; k++) {
      const i = k % grid
      const j = Math.floor(k / grid)
      const ang = randAt(layerSeed, count, k * 2 + 10) * Math.PI * 2
      const mag = randAt(layerSeed, count, k * 2 + 11)
      const s = this.cells[k]
      s.position.set(
        i * cw + cw / 2 + Math.cos(ang) * mag * displace * cw * 2.5,
        j * ch + ch / 2 + Math.sin(ang) * mag * displace * ch * 2.5,
      )
      s.rotation = (mag - 0.5) * displace * 0.6
      s.scale.set(1 + displace * mag * 0.35)
    }
    const cover = Math.max(ctx.W / this.texSize.w, ctx.H / this.texSize.h)
    this.inner.scale.set(cover * (p.scale ?? 1))
    this.inner.position.set(ctx.W / 2, ctx.H / 2)
    this.inner.alpha = p.alpha ?? 1
  }

  destroy() {
    for (const t of this.subTextures) t.destroy()
    this.container.destroy({ children: true })
  }
}

// --- shapes -----------------------------------------------------------------

class ShapeLayer implements LayerObj {
  container = new Container()
  private g = new Graphics()

  constructor() {
    this.container.addChild(this.g)
  }

  update(cfg: LayerConfig, p: Record<string, number>, ctx: LayerCtx) {
    const { W, H } = ctx
    const layerSeed = ctx.seed ^ hashString(cfg.id)
    const count = Math.floor(p.cut ?? 0)
    const n = clampInt(p.count ?? 8, 1, 32)
    const mode = clampInt(p.mode ?? 0, 0, 15)
    const pulse = Math.max(0, Math.min(1, p.pulse ?? 0))
    const alpha = (p.alpha ?? 1) * (0.2 + 0.8 * pulse)
    const sat = p.sat ?? 0
    const color = sat > 0.01 ? hsl((p.hue ?? 0) % 360, sat, 0.6) : 0xffffff
    const g = this.g
    g.clear()
    // whole-layer rotation: `rotate` is a mappable phase, `spin` a constant
    // rate — both functions of t, so exports stay deterministic
    g.pivot.set(W / 2, H / 2)
    g.position.set(W / 2, H / 2)
    g.rotation = (p.rotate ?? 0) * Math.PI * 2 + ctx.t * (p.spin ?? 0) * 2
    if (alpha <= 0.004) return
    if (mode === 0) { // bars
      for (let i = 0; i < n; i++) {
        const x = randAt(layerSeed, count, i) * W
        const w = (W / n) * 0.25 * (0.4 + pulse)
        g.rect(x - w / 2, 0, w, H).fill({ color, alpha })
      }
    } else if (mode === 1) { // rings
      for (let i = 0; i < n; i++) {
        const r = (((i + 1) / n) * H * 0.45) * (1 + pulse * 0.3)
        g.circle(W / 2, H / 2, r).stroke({ width: 3 + pulse * 14, color, alpha })
      }
    } else if (mode === 2) { // grid
      for (let i = 0; i < n; i++) {
        const x = randAt(layerSeed, count, i) * W
        const y = randAt(layerSeed, count, i + 100) * H
        const th = 2 + pulse * 6
        g.rect(x, 0, th, H).fill({ color, alpha })
        g.rect(0, y, W, th).fill({ color, alpha })
      }
    } else if (mode === 3) { // triangles
      for (let i = 0; i < n; i++) {
        const cx = randAt(layerSeed, count, i) * W
        const cy = randAt(layerSeed, count, i + 100) * H
        const r = H * (0.06 + 0.14 * randAt(layerSeed, count, i + 200)) * (0.5 + pulse)
        const rot = randAt(layerSeed, count, i + 300) * Math.PI * 2
        const pts: number[] = []
        for (let k = 0; k < 3; k++) {
          const a = rot + (k / 3) * Math.PI * 2
          pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
        }
        if (i % 2) g.poly(pts).fill({ color, alpha })
        else g.poly(pts).stroke({ width: 2 + pulse * 8, color, alpha })
      }
    } else if (mode === 4) { // burst — rays from center
      // build every ray first, stroke ONCE — stroking per-ray restrokes the
      // accumulated path and overdraws earlier rays into a frozen blob
      for (let i = 0; i < n; i++) {
        const a = randAt(layerSeed, count, i) * Math.PI * 2
        const len = H * 0.55 * (0.5 + pulse) * (0.6 + 0.4 * randAt(layerSeed, count, i + 100))
        const inner = H * 0.05
        g.moveTo(W / 2 + Math.cos(a) * inner, H / 2 + Math.sin(a) * inner)
        g.lineTo(W / 2 + Math.cos(a) * len, H / 2 + Math.sin(a) * len)
      }
      g.stroke({ width: 2 + pulse * 10, color, alpha })
    } else if (mode === 5) { // dots
      for (let i = 0; i < n; i++) {
        const x = randAt(layerSeed, count, i) * W
        const y = randAt(layerSeed, count, i + 100) * H
        const r = (5 + 26 * randAt(layerSeed, count, i + 200)) * (0.4 + pulse)
        g.circle(x, y, r).fill({ color, alpha })
      }
    } else if (mode === 6) { // tunnel — concentric rotated squares
      for (let i = 0; i < n; i++) {
        const half = ((i + 1) / n) * H * 0.55 * (1 + pulse * 0.3)
        const rot = (randAt(layerSeed, count, i) - 0.5) * 0.9 + i * 0.05
        const r = half * Math.SQRT2
        const pts: number[] = []
        for (let k = 0; k < 4; k++) {
          const a = rot + Math.PI / 4 + (k * Math.PI) / 2
          pts.push(W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r)
        }
        g.poly(pts).stroke({ width: 2 + pulse * 8, color, alpha })
      }
    } else if (mode === 7) { // polygons — nested n-gons, sides change per cut
      const sides = 3 + (count % 4)
      for (let i = 0; i < n; i++) {
        const r = ((i + 1) / n) * H * 0.5 * (0.6 + pulse * 0.6)
        const rot = randAt(layerSeed, count, i) * Math.PI * 2
        const pts: number[] = []
        for (let k = 0; k < sides; k++) {
          const a = rot + (k / sides) * Math.PI * 2
          pts.push(W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r)
        }
        g.poly(pts).stroke({ width: 2 + pulse * 8, color, alpha })
      }
    } else if (mode === 8) { // scatter lines — glitchy segments quantized to 45° angles
      for (let i = 0; i < n; i++) {
        const x = randAt(layerSeed, count, i) * W
        const y = randAt(layerSeed, count, i + 100) * H
        const a = Math.floor(randAt(layerSeed, count, i + 200) * 4) * (Math.PI / 4)
        const len = H * (0.1 + 0.25 * randAt(layerSeed, count, i + 300)) * (0.5 + pulse)
        g.moveTo(x, y)
        g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
      }
      g.stroke({ width: 2 + pulse * 8, color, alpha })
    } else if (mode === 9) { // crosses — scattered + and × marks
      for (let i = 0; i < n; i++) {
        const cx = randAt(layerSeed, count, i) * W
        const cy = randAt(layerSeed, count, i + 100) * H
        const s = H * (0.03 + 0.08 * randAt(layerSeed, count, i + 200)) * (0.5 + pulse)
        const rot = (randAt(layerSeed, count, i + 300) - 0.5) * 0.4 + (i % 2) * (Math.PI / 4)
        for (const a of [rot, rot + Math.PI / 2]) {
          g.moveTo(cx - Math.cos(a) * s, cy - Math.sin(a) * s)
          g.lineTo(cx + Math.cos(a) * s, cy + Math.sin(a) * s)
        }
      }
      g.stroke({ width: 3 + pulse * 8, color, alpha })
    } else if (mode === 10) { // diamonds
      for (let i = 0; i < n; i++) {
        const cx = randAt(layerSeed, count, i) * W
        const cy = randAt(layerSeed, count, i + 100) * H
        const r = H * (0.05 + 0.12 * randAt(layerSeed, count, i + 200)) * (0.5 + pulse)
        const rot = (randAt(layerSeed, count, i + 300) - 0.5) * 0.3
        const pts: number[] = []
        for (let k = 0; k < 4; k++) {
          const a = rot + (k * Math.PI) / 2
          pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 1.5)
        }
        if (i % 2) g.poly(pts).fill({ color, alpha })
        else g.poly(pts).stroke({ width: 2 + pulse * 6, color, alpha })
      }
    } else if (mode === 11) { // spiral
      const turns = 3 + pulse * 4
      const rot0 = randAt(layerSeed, count, 7) * Math.PI * 2
      const NPT = 240
      for (let k = 0; k <= NPT; k++) {
        const frac = k / NPT
        const a = rot0 + frac * turns * Math.PI * 2
        const r = frac * H * 0.48
        const x = W / 2 + Math.cos(a) * r
        const y = H / 2 + Math.sin(a) * r
        if (k === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.stroke({ width: 2 + pulse * 9, color, alpha })
    } else if (mode === 12) { // checker — rearrange flips the board
      const cols = Math.max(2, n)
      const cell = W / cols
      const rows = Math.ceil(H / cell)
      const phase = count % 2
      const size = cell * (0.35 + 0.65 * pulse)
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          if ((i + j + phase) % 2) continue
          g.rect(i * cell + (cell - size) / 2, j * cell + (cell - size) / 2, size, size)
            .fill({ color, alpha })
        }
      }
    } else if (mode === 13) { // arcs — broken ring fragments
      for (let i = 0; i < n * 2; i++) {
        const r = H * (0.1 + 0.38 * randAt(layerSeed, count, i))
        const a0 = randAt(layerSeed, count, i + 100) * Math.PI * 2
        const len = 0.3 + randAt(layerSeed, count, i + 200) * 1.4
        g.moveTo(W / 2 + Math.cos(a0) * r, H / 2 + Math.sin(a0) * r)
        g.arc(W / 2, H / 2, r, a0, a0 + len)
      }
      g.stroke({ width: 3 + pulse * 10, color, alpha })
    } else if (mode === 14) { // stars — point count changes per cut
      for (let i = 0; i < n; i++) {
        const cx = randAt(layerSeed, count, i) * W
        const cy = randAt(layerSeed, count, i + 100) * H
        const R = H * (0.05 + 0.1 * randAt(layerSeed, count, i + 200)) * (0.5 + pulse)
        const points = 4 + ((count + i) % 4)
        const rot = randAt(layerSeed, count, i + 300) * Math.PI * 2
        const pts: number[] = []
        for (let k = 0; k < points * 2; k++) {
          const a = rot + (k / (points * 2)) * Math.PI * 2
          const rr = k % 2 ? R * 0.45 : R
          pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)
        }
        if (i % 2) g.poly(pts).fill({ color, alpha })
        else g.poly(pts).stroke({ width: 2 + pulse * 5, color, alpha })
      }
    } else { // blocks — grid-quantized digital noise
      const gx = W / 24
      const gy = H / 24
      for (let i = 0; i < n * 2; i++) {
        const x = Math.floor(randAt(layerSeed, count, i) * 24) * gx
        const y = Math.floor(randAt(layerSeed, count, i + 100) * 24) * gy
        const bw = (1 + Math.floor(randAt(layerSeed, count, i + 200) * 4)) * gx
        const bh = (1 + Math.floor(randAt(layerSeed, count, i + 300) * 3)) * gy
        g.rect(x, y, bw, bh)
          .fill({ color, alpha: alpha * (0.4 + 0.6 * randAt(layerSeed, count, i + 400)) })
      }
    }
  }

  destroy() { this.container.destroy({ children: true }) }
}

// --- scope ------------------------------------------------------------------

/**
 * Oscilloscope over real stem samples. Modes: line, mirrored fill, circle,
 * lissajous (stem A = X, stem B = Y), waterfall (Unknown Pleasures ridges).
 * Trigger lock aligns the window to a rising zero-crossing so periodic
 * waveforms hold still instead of scrolling.
 */
class ScopeLayer implements LayerObj {
  container = new Container()
  private g = new Graphics()

  constructor() {
    this.container.addChild(this.g)
  }

  update(cfg: LayerConfig, p: Record<string, number>, ctx: LayerCtx) {
    const g = this.g
    g.clear()
    const trackA = ctx.tracks.find((t) => t.id === cfg.trackId && t.audio)
      ?? ctx.tracks.find((t) => t.audio)
    if (!trackA?.audio) return
    const alpha = p.alpha ?? 1
    if (alpha <= 0.004) return
    const { W, H } = ctx
    const layerSeed = ctx.seed ^ hashString(cfg.id)
    const mode = clampInt(p.mode ?? 0, 0, 4)
    const amp = p.amp ?? 1
    const fuzz = Math.max(0, Math.min(1, p.fuzz ?? 0))
    const thickness = p.thickness ?? 3
    const sat = p.sat ?? 0
    const color = sat > 0.01 ? hsl((p.hue ?? 0) % 360, sat, 0.62) : 0xffffff
    const yBase = (p.ypos ?? 0.5) * H
    const frameKey = Math.floor(ctx.t * 60) // fuzz keyed per frame — deterministic
    const windowS = 0.045
    const N = 220
    const useTrigger = (p.trigger ?? 1) >= 0.5 && mode <= 2

    /** window reader; optionally aligned to the next rising zero-crossing */
    const reader = (audio: NonNullable<Track['audio']>, tt: number, trig: boolean) => {
      const data = audio.buffer.getChannelData(0)
      const sr = audio.buffer.sampleRate
      let start = (tt - windowS / 2) * sr
      if (trig) {
        const s0 = Math.max(1, Math.floor(start))
        const span = Math.floor(windowS * sr * 0.5)
        for (let i = s0; i < s0 + span && i < data.length; i++) {
          if (data[i - 1] < 0 && data[i] >= 0) { start = i; break }
        }
      }
      return (frac: number) => {
        const idx = Math.floor(start + frac * windowS * sr)
        return idx >= 0 && idx < data.length ? data[idx] : 0
      }
    }
    const read = reader(trackA.audio, ctx.t, useTrigger)
    const jit = (i: number, pass: number, amt: number) =>
      amt * (randAt(layerSeed ^ frameKey, i, pass) - 0.5)
    const strokePath = (pts: number[], width: number, a: number, close = false) => {
      g.moveTo(pts[0], pts[1])
      for (let k = 2; k < pts.length; k += 2) g.lineTo(pts[k], pts[k + 1])
      if (close) g.closePath()
      g.stroke({ width, color, alpha: a })
    }

    // glow underlay + main trace + fuzz ghosts
    const passes = [
      { jitter: 0, width: thickness * 3.5, alpha: alpha * 0.12 },
      { jitter: fuzz * 6, width: thickness, alpha: alpha * 0.85 },
    ]
    for (let k = 0; k < Math.round(fuzz * 3); k++) {
      passes.push({ jitter: fuzz * 26, width: Math.max(1, thickness * 0.5), alpha: alpha * 0.22 })
    }

    if (mode === 0) { // line
      passes.forEach((pass, pi) => {
        const pts: number[] = []
        for (let i = 0; i <= N; i++) {
          const j = jit(i, pi, pass.jitter)
          pts.push((i / N) * W + j, yBase - read(i / N) * amp * H * 0.35 + j)
        }
        strokePath(pts, pass.width, pass.alpha)
      })
    } else if (mode === 1) { // mirrored fill
      const top: number[] = []
      const bottom: number[] = []
      for (let i = 0; i <= N; i++) {
        const j = jit(i, 1, fuzz * 8)
        const v = Math.abs(read(i / N)) * amp * H * 0.3 + Math.abs(j)
        const x = (i / N) * W
        top.push(x, yBase - v)
        bottom.unshift(x, yBase + v)
      }
      g.poly([...top, ...bottom]).fill({ color, alpha: alpha * 0.55 })
      strokePath(top, Math.max(1, thickness * 0.6), alpha * 0.9)
      strokePath(bottom, Math.max(1, thickness * 0.6), alpha * 0.9)
    } else if (mode === 2) { // circle
      const baseR = H * (0.1 + 0.35 * (p.ypos ?? 0.5))
      passes.forEach((pass, pi) => {
        const pts: number[] = []
        for (let i = 0; i <= N; i++) {
          const th = (i / N) * Math.PI * 2 - Math.PI / 2
          const r = baseR * (1 + read(i / N) * amp * 0.5) + jit(i, pi, pass.jitter)
          pts.push(W / 2 + Math.cos(th) * r, H / 2 + Math.sin(th) * r)
        }
        strokePath(pts, pass.width, pass.alpha, true)
      })
    } else if (mode === 3) { // lissajous: stem A -> X, stem B -> Y
      const trackB = ctx.tracks.find((t) => t.id === cfg.trackId2 && t.audio) ?? trackA
      const readB = trackB === trackA ? read : reader(trackB.audio!, ctx.t, false)
      const size = H * 0.4 * amp
      passes.forEach((pass, pi) => {
        const pts: number[] = []
        for (let i = 0; i <= N; i++) {
          pts.push(
            W / 2 + read(i / N) * size + jit(i, pi, pass.jitter),
            yBase + readB(i / N) * size + jit(i * 7 + 3, pi, pass.jitter),
          )
        }
        strokePath(pts, pass.width, pass.alpha)
      })
    } else { // waterfall — stacked ridges of the recent past, oldest at the top
      const RIDGES = 14
      const span = H * 0.42
      for (let k = RIDGES - 1; k >= 0; k--) {
        const rk = reader(trackA.audio, ctx.t - k * 0.055, false)
        const ridgeY = yBase - span / 2 + ((RIDGES - 1 - k) / (RIDGES - 1)) * span
        const pts: number[] = []
        for (let i = 0; i <= N; i++) {
          const v = Math.abs(rk(i / N)) * amp * H * 0.14 + Math.abs(jit(i + k * 37, 1, fuzz * 5))
          pts.push(W * 0.12 + (i / N) * W * 0.76, ridgeY - v)
        }
        // solid black under each ridge occludes older ones — the classic look
        g.poly([...pts, W * 0.88, ridgeY + 1, W * 0.12, ridgeY + 1])
          .fill({ color: 0x000000, alpha: alpha * 0.8 })
        strokePath(pts, Math.max(1, thickness * 0.7), alpha * (1 - (k / RIDGES) * 0.75))
      }
    }
  }

  destroy() { this.container.destroy({ children: true }) }
}

// --- background --------------------------------------------------------------

/** full-frame color wash; `color jump` cuts to a new seeded hue on MIDI hits */
class BgLayer implements LayerObj {
  container = new Container()
  private g = new Graphics()

  constructor() {
    this.container.addChild(this.g)
  }

  update(cfg: LayerConfig, p: Record<string, number>, ctx: LayerCtx) {
    const g = this.g
    g.clear()
    const alpha = p.alpha ?? 1
    if (alpha <= 0.004) return
    const layerSeed = ctx.seed ^ hashString(cfg.id)
    const count = Math.floor(p.cut ?? 0)
    const jump = count > 0 ? randAt(layerSeed, count) * 360 : 0
    const hue = ((p.hue ?? 0) + jump) % 360
    const color = hsl(hue, p.sat ?? 0.7, Math.max(0.001, p.light ?? 0.15))
    g.rect(0, 0, ctx.W, ctx.H).fill({ color, alpha })
  }

  destroy() { this.container.destroy({ children: true }) }
}

export function createLayer(kind: LayerKind): LayerObj {
  if (kind === 'photo') return new PhotoLayer()
  if (kind === 'shards') return new ShardLayer()
  if (kind === 'scope') return new ScopeLayer()
  if (kind === 'bg') return new BgLayer()
  return new ShapeLayer()
}
