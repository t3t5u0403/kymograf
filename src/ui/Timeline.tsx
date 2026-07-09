import { useEffect, useRef } from 'react'
import { project, useProject } from '../core/store'
import { transport } from '../core/transport'
import type { LayerConfig, Track } from '../core/types'

const LABEL_W = 118
const LANE_H = 48
const LAYER_H = 30
const RULER_H = 20

/** capture/release can throw for exotic pointer states — never let that kill the edit */
const capture = (el: Element, id: number) => { try { el.setPointerCapture(id) } catch { /* ok */ } }
const release = (el: Element, id: number) => { try { el.releasePointerCapture(id) } catch { /* ok */ } }

type Drag =
  | { mode: 'scrub'; wasPlaying: boolean }
  | { mode: 'select'; startT: number; moved: boolean }
  | { mode: 'create' | 'resize-l' | 'resize-r' | 'move'
      layerId: string; idx: number; grab: number; width: number }

interface Row {
  kind: 'track' | 'layer'
  track?: Track
  layer?: LayerConfig
  /** layer lane sits directly under the track that drives it */
  anchored?: boolean
  y0: number
  h: number
}

/**
 * Row layout: each track lane is followed by the lanes of layers whose first
 * signal source is that track — so you draw a layer's active regions right
 * against the waveform/MIDI that drives it. Unmapped layers sink to the bottom.
 */
function buildRows(): Row[] {
  const rows: Row[] = []
  let y = RULER_H
  const anchorTrack = (l: LayerConfig): string | null => {
    for (const m of project.mappings) {
      if (m.targetLayer === l.id && 'trackId' in m.source) return m.source.trackId
    }
    return null
  }
  // the FX chain rides the same gate machinery as layers, id 'fx'
  const fxLayer: LayerConfig = {
    id: 'fx', kind: 'shapes', name: 'FX chain', photoIds: [],
    enabled: project.fxEnabled, regions: project.fxRegions, params: {},
  }
  const anchored = new Map<string, LayerConfig[]>()
  const loose: LayerConfig[] = []
  for (const l of [...project.layers, fxLayer]) {
    const a = anchorTrack(l)
    if (a && project.tracks.some((t) => t.id === a)) {
      if (!anchored.has(a)) anchored.set(a, [])
      anchored.get(a)!.push(l)
    } else {
      loose.push(l)
    }
  }
  for (const t of project.tracks) {
    rows.push({ kind: 'track', track: t, y0: y, h: LANE_H })
    y += LANE_H
    for (const l of anchored.get(t.id) ?? []) {
      rows.push({ kind: 'layer', layer: l, anchored: true, y0: y, h: LAYER_H })
      y += LAYER_H
    }
  }
  for (const l of loose) {
    rows.push({ kind: 'layer', layer: l, y0: y, h: LAYER_H })
    y += LAYER_H
  }
  return rows
}

interface Geometry {
  rect: DOMRect
  pxPerSec: number
}

export function Timeline() {
  const p = useProject()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const view = useRef({ zoom: 1, offset: 0 })
  const drag = useRef<Drag | null>(null)

  const rowsKey = `${p.tracks.length}:${p.layers.length}`

  const geometry = (): Geometry | null => {
    const canvas = canvasRef.current
    const dur = project.duration
    if (!canvas || !dur) return null
    const rect = canvas.getBoundingClientRect()
    return { rect, pxPerSec: ((rect.width - LABEL_W) / dur) * view.current.zoom }
  }
  const xToT = (clientX: number, geo: Geometry) =>
    view.current.offset + (clientX - geo.rect.left - LABEL_W) / geo.pxPerSec
  const snap = (t: number, altBypass = false) => {
    t = Math.max(0, t)
    if (!project.snapEnabled || altBypass) return t
    const beat = 60 / project.bpm
    return Math.round(t / beat) * beat
  }
  const rowAt = (clientY: number, geo: Geometry): Row | null => {
    const y = clientY - geo.rect.top
    return buildRows().find((r) => y >= r.y0 && y < r.y0 + r.h) ?? null
  }
  const hitRegion = (layer: LayerConfig, clientX: number, geo: Geometry) => {
    if (!layer.regions) return null
    const x = clientX - geo.rect.left
    for (let i = 0; i < layer.regions.length; i++) {
      const [a, b] = layer.regions[i]
      const x0 = LABEL_W + (a - view.current.offset) * geo.pxPerSec
      const x1 = LABEL_W + (b - view.current.offset) * geo.pxPerSec
      if (Math.abs(x - x0) < 6) return { i, edge: 'l' as const }
      if (Math.abs(x - x1) < 6) return { i, edge: 'r' as const }
      if (x > x0 && x < x1) return { i, edge: null }
    }
    return null
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const draw = () => {
      const rows = buildRows()
      const dur = project.duration
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const last = rows[rows.length - 1]
      const h = last ? last.y0 + last.h : RULER_H + LANE_H
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
        canvas.style.height = `${h}px`
      }
      const g = canvas.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.fillStyle = '#101014'
      g.fillRect(0, 0, w, h)
      if (!dur || !rows.length) {
        g.fillStyle = '#8b8b96'
        g.font = '12px system-ui'
        g.fillText('timeline — drop stems + MIDI to populate', 12, h / 2 + 4)
        return
      }

      const { zoom, offset } = view.current
      const pxPerSec = ((w - LABEL_W) / dur) * zoom
      const tToX = (t: number) => LABEL_W + (t - offset) * pxPerSec
      const visibleEnd = offset + (w - LABEL_W) / pxPerSec

      // --- ruler labels
      const beat = 60 / project.bpm
      const bar = beat * 4
      let major = bar
      while (major * pxPerSec < 46) major *= 2
      let minor = 0
      for (const cand of [bar, beat, beat / 4]) {
        if (cand < major && cand * pxPerSec >= 8) minor = cand
      }
      g.font = '10px system-ui'
      g.fillStyle = '#8b8b96'
      for (let t = Math.floor(offset / major) * major; t <= visibleEnd; t += major) {
        const x = tToX(t)
        if (x >= LABEL_W) g.fillText(`${Math.round(t / bar) + 1}`, x + 3, 13)
      }

      // --- lanes
      let laneIdx = 0
      for (const row of rows) {
        const y0 = row.y0
        laneIdx++
        if (row.kind === 'track') {
          const track = row.track!
          g.fillStyle = laneIdx % 2 ? '#131318' : '#101014'
          g.fillRect(LABEL_W, y0, w - LABEL_W, LANE_H)
          const dim = project.isAudible(track) ? 1 : 0.28

          if (track.audio) {
            const { peaks, buffer } = track.audio
            const bins = peaks.length / 2
            g.fillStyle = `rgba(95, 174, 127, ${0.75 * dim})`
            const mid = y0 + LANE_H / 2
            for (let x = LABEL_W; x < w; x++) {
              const t = offset + (x - LABEL_W) / pxPerSec
              if (t < 0 || t >= buffer.duration) continue
              const b = Math.min(bins - 1, Math.floor((t / buffer.duration) * bins))
              const hh = Math.max(0.5, ((peaks[b * 2 + 1] - peaks[b * 2]) / 2) * (LANE_H - 8))
              g.fillRect(x, mid - hh / 2, 1, hh)
            }
          }
          if (track.midi?.notes.length) {
            let lo = 127
            let hi = 0
            for (const n of track.midi.notes) {
              lo = Math.min(lo, n.midi)
              hi = Math.max(hi, n.midi)
            }
            const span = Math.max(1, hi - lo)
            g.fillStyle = `rgba(232, 179, 75, ${0.95 * dim})`
            for (const n of track.midi.notes) {
              if (n.time + n.duration < offset || n.time > visibleEnd) continue
              const y = y0 + LANE_H - 7 - ((n.midi - lo) / span) * (LANE_H - 14)
              g.fillRect(tToX(n.time), y, Math.max(2, n.duration * pxPerSec), 3)
            }
          }

          g.fillStyle = '#17171b'
          g.fillRect(0, y0, LABEL_W, LANE_H)
          g.strokeStyle = '#2a2a32'
          g.strokeRect(-1, y0 + 0.5, LABEL_W + 1, LANE_H)
          g.fillStyle = dim === 1 ? '#d8d8de' : '#8b8b96'
          g.font = '600 12px system-ui'
          g.fillText(track.name.slice(0, 9), 8, y0 + 19)
          g.font = '10px system-ui'
          g.fillStyle = track.solo ? '#e8b34b' : '#2a2a32'
          g.fillRect(LABEL_W - 48, y0 + 8, 18, 15)
          g.fillStyle = track.solo ? '#17171b' : '#8b8b96'
          g.fillText('S', LABEL_W - 43, y0 + 19.5)
          g.fillStyle = track.muted ? '#ff7a7a' : '#2a2a32'
          g.fillRect(LABEL_W - 26, y0 + 8, 18, 15)
          g.fillStyle = track.muted ? '#17171b' : '#8b8b96'
          g.fillText('M', LABEL_W - 21, y0 + 19.5)
        } else {
          const layer = row.layer!
          const on = layer.enabled ?? true
          g.fillStyle = row.anchored ? '#12141b' : '#101116'
          g.fillRect(LABEL_W, y0, w - LABEL_W, LAYER_H)

          const regions = layer.regions ?? []
          const a = on ? 1 : 0.3
          if (!regions.length) {
            g.fillStyle = `rgba(110, 168, 255, ${0.08 * a})`
            g.fillRect(LABEL_W, y0 + 3, w - LABEL_W, LAYER_H - 6)
            g.fillStyle = `rgba(139, 139, 150, ${0.7 * a})`
            g.font = '9px system-ui'
            g.fillText('always on — drag to gate', LABEL_W + 6, y0 + LAYER_H / 2 + 3)
          }
          for (const [ra, rb] of regions) {
            if (rb < offset || ra > visibleEnd) continue
            const x0 = tToX(ra)
            const x1 = tToX(rb)
            g.fillStyle = `rgba(110, 168, 255, ${0.32 * a})`
            g.strokeStyle = `rgba(110, 168, 255, ${0.9 * a})`
            g.beginPath()
            g.roundRect(x0, y0 + 3, Math.max(2, x1 - x0), LAYER_H - 6, 3)
            g.fill()
            g.stroke()
          }

          g.fillStyle = '#17171b'
          g.fillRect(0, y0, LABEL_W, LAYER_H)
          g.strokeStyle = '#2a2a32'
          g.strokeRect(-1, y0 + 0.5, LABEL_W + 1, LAYER_H)
          g.fillStyle = on ? '#6ea8ff' : '#3a3a44'
          const indent = row.anchored ? 14 : 8
          if (row.anchored) {
            g.fillStyle = '#3a3a44'
            g.fillText('↳', 4, y0 + LAYER_H / 2 + 4)
            g.fillStyle = on ? '#6ea8ff' : '#3a3a44'
          }
          g.fillRect(indent, y0 + LAYER_H / 2 - 4, 8, 8)
          g.fillStyle = on ? '#d8d8de' : '#8b8b96'
          g.font = '11px system-ui'
          g.fillText(layer.name.slice(0, 11), indent + 14, y0 + LAYER_H / 2 + 4)
        }
      }

      // --- bpm grid, over the lanes (DAW-style translucent lines)
      if (minor) {
        g.fillStyle = 'rgba(255, 255, 255, 0.08)'
        for (let t = Math.floor(offset / minor) * minor; t <= visibleEnd; t += minor) {
          if (Math.abs(t / major - Math.round(t / major)) < 1e-6) continue
          const x = tToX(t)
          if (x >= LABEL_W) g.fillRect(x, RULER_H, 1, h - RULER_H)
        }
      }
      g.fillStyle = 'rgba(255, 255, 255, 0.2)'
      for (let t = Math.floor(offset / major) * major; t <= visibleEnd; t += major) {
        const x = tToX(t)
        if (x >= LABEL_W) g.fillRect(x, RULER_H, 1, h - RULER_H)
      }

      // --- selection highlight (drag across a track lane; ctrl+L makes it the loop)
      if (transport.selection) {
        const [sa, sb] = transport.selection
        const x0 = Math.max(LABEL_W, tToX(sa))
        const x1 = tToX(sb)
        if (x1 > LABEL_W) {
          g.fillStyle = 'rgba(255, 255, 255, 0.09)'
          g.fillRect(x0, RULER_H, x1 - x0, h - RULER_H)
          g.fillStyle = 'rgba(255, 255, 255, 0.5)'
          g.fillRect(x0, RULER_H, 1, h - RULER_H)
          g.fillRect(x1, RULER_H, 1, h - RULER_H)
        }
      }

      // --- loop brace in the ruler
      if (transport.loopValid) {
        const x0 = Math.max(LABEL_W, tToX(transport.loopStart))
        const x1 = tToX(transport.loopEnd)
        if (x1 > LABEL_W) {
          const a = transport.loopEnabled ? 0.95 : 0.35
          g.fillStyle = `rgba(110, 168, 255, ${a})`
          g.fillRect(x0, 0, Math.max(2, x1 - x0), 5)
          g.fillRect(x0, 0, 2, RULER_H - 4)
          g.fillRect(x1 - 2, 0, 2, RULER_H - 4)
        }
      }

      // --- playhead
      const px = tToX(transport.time())
      if (px >= LABEL_W) {
        g.fillStyle = '#ffffff'
        g.fillRect(px, 0, 1.5, h)
        g.beginPath()
        g.moveTo(px - 4, 0); g.lineTo(px + 5, 0); g.lineTo(px + 0.5, 7)
        g.fill()
      }
    }

    draw()
    const iv = setInterval(draw, 50)

    const onWheel = (e: WheelEvent) => {
      const geo = geometry()
      if (!geo) return
      const dur = project.duration
      const v = view.current
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const anchor = xToT(e.clientX, geo)
        v.zoom = Math.max(1, Math.min(60, v.zoom * Math.exp(-e.deltaY * 0.0016)))
        const newPxPerSec = ((geo.rect.width - LABEL_W) / dur) * v.zoom
        v.offset = anchor - (e.clientX - geo.rect.left - LABEL_W) / newPxPerSec
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault()
        v.offset += (e.deltaX || e.deltaY) / geo.pxPerSec
      } else {
        return // plain wheel: let the timeline wrap scroll vertically
      }
      const visible = (geo.rect.width - LABEL_W) / (((geo.rect.width - LABEL_W) / dur) * v.zoom)
      v.offset = Math.max(0, Math.min(dur - visible, v.offset))
      draw()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      clearInterval(iv)
      canvas.removeEventListener('wheel', onWheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey])

  return (
    <canvas
      ref={canvasRef}
      className="timeline"
      onPointerDown={(e) => {
        const geo = geometry()
        if (!geo) return
        const inLabel = e.clientX - geo.rect.left < LABEL_W
        const row = rowAt(e.clientY, geo)

        // ruler: click = snapped seek, drag = scrub
        if (!inLabel && e.clientY - geo.rect.top < RULER_H) {
          drag.current = { mode: 'scrub', wasPlaying: transport.playing }
          transport.pause()
          capture(e.currentTarget, e.pointerId)
          transport.seek(snap(xToT(e.clientX, geo), e.altKey))
          return
        }

        if (!row || row.kind === 'track') {
          // track row: solo/mute via label; click = snapped seek; drag = highlight
          if (inLabel) {
            if (row?.track) {
              const xl = e.clientX - geo.rect.left
              if (xl >= LABEL_W - 48 && xl < LABEL_W - 28) p.toggleSolo(row.track.id)
              else p.toggleMute(row.track.id)
              transport.refresh()
            }
            return
          }
          capture(e.currentTarget, e.pointerId)
          drag.current = { mode: 'select', startT: xToT(e.clientX, geo), moved: false }
          return
        }

        const layer = row.layer!
        if (inLabel) { p.toggleLayerEnabled(layer.id); return }
        capture(e.currentTarget, e.pointerId)
        p.beginGesture() // whole region drag = one undo step
        const hit = hitRegion(layer, e.clientX, geo)
        const t = xToT(e.clientX, geo)
        if (!hit) {
          const s = snap(t, e.altKey)
          const idx = p.addLayerRegion(layer.id, s, s)
          drag.current = { mode: 'create', layerId: layer.id, idx, grab: s, width: 0 }
        } else if (hit.edge === 'l') {
          drag.current = {
            mode: 'resize-l', layerId: layer.id, idx: hit.i,
            grab: layer.regions![hit.i][1], width: 0,
          }
        } else if (hit.edge === 'r') {
          drag.current = {
            mode: 'resize-r', layerId: layer.id, idx: hit.i,
            grab: layer.regions![hit.i][0], width: 0,
          }
        } else {
          const [a, b] = layer.regions![hit.i]
          drag.current = {
            mode: 'move', layerId: layer.id, idx: hit.i, grab: t - a, width: b - a,
          }
        }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        const geo = geometry()
        if (!d || !geo) return
        const t = xToT(e.clientX, geo)
        if (d.mode === 'scrub') { transport.seek(t); return }
        if (d.mode === 'select') {
          d.moved = true
          transport.setSelection(snap(d.startT, e.altKey), snap(t, e.altKey))
          return
        }
        if (d.mode === 'create') p.updateLayerRegion(d.layerId, d.idx, d.grab, snap(t, e.altKey))
        else if (d.mode === 'resize-l') p.updateLayerRegion(d.layerId, d.idx, snap(t, e.altKey), d.grab)
        else if (d.mode === 'resize-r') p.updateLayerRegion(d.layerId, d.idx, d.grab, snap(t, e.altKey))
        else {
          const start = snap(t - d.grab, e.altKey)
          p.updateLayerRegion(d.layerId, d.idx, start, start + d.width)
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        release(e.currentTarget, e.pointerId)
        if (!d) return
        if (d.mode === 'scrub') {
          if (d.wasPlaying) void transport.play()
          return
        }
        if (d.mode === 'select') {
          if (!d.moved) {
            // plain click: clear any selection and snap the playhead to the grid
            transport.clearSelection()
            transport.seek(snap(d.startT, e.altKey))
          }
          return
        }
        // a click without drag stamps a 1-bar region
        const region = p.regionsOf(d.layerId)?.[d.idx]
        if (d.mode === 'create' && region && region[1] - region[0] < 0.02) {
          p.updateLayerRegion(d.layerId, d.idx, region[0], region[0] + (60 / p.bpm) * 4)
        }
        p.endGesture()
      }}
      onDoubleClick={(e) => {
        const geo = geometry()
        if (!geo) return
        if (e.clientX - geo.rect.left < LABEL_W) return
        const row = rowAt(e.clientY, geo)
        if (row?.kind !== 'layer') return
        const hit = hitRegion(row.layer!, e.clientX, geo)
        if (hit) p.removeLayerRegion(row.layer!.id, hit.i)
      }}
    />
  )
}
