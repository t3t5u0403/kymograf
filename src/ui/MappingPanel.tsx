import { useEffect, useRef } from 'react'
import { FX_PARAMS, PARAM_DEFS, type ParamDef } from '../core/params'
import { useProject } from '../core/store'
import { transport } from '../core/transport'
import type { Band, MappingConfig, SignalSpec } from '../core/types'
import type { project as ProjectStore } from '../core/store'
import { buildSignal } from '../signals/signal'
import { Slider } from './Slider'

type Project = typeof ProjectStore

/** live readout of a mapping's source signal — if this doesn't move, the visuals can't */
function SignalMeter({ spec, p }: { spec: SignalSpec; p: Project }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sig = buildSignal(spec, p.tracks, p.bpm)
    const iv = setInterval(() => {
      const v = Math.max(0, Math.min(1, sig.sample(transport.time())))
      if (ref.current) ref.current.style.width = `${(v * 100).toFixed(1)}%`
    }, 50)
    return () => clearInterval(iv)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, p.version])
  return <div className="meter"><div ref={ref} /></div>
}

function sourceValue(s: SignalSpec): string {
  switch (s.kind) {
    case 'trigger': return `trigger:${s.trackId}`
    case 'audio': return `audio:${s.trackId}:${s.band}`
    case 'density': return `density:${s.trackId}`
    case 'beat': return `beat:${s.division}`
  }
}

function decodeSource(v: string, old: SignalSpec): SignalSpec {
  const [kind, a, b] = v.split(':')
  switch (kind) {
    case 'trigger':
      return {
        kind: 'trigger', trackId: a,
        decay: old.kind === 'trigger' ? old.decay : 0.15,
        pitchLo: old.kind === 'trigger' ? old.pitchLo : 0,
        pitchHi: old.kind === 'trigger' ? old.pitchHi : 127,
      }
    case 'audio':
      return { kind: 'audio', trackId: a, band: b as Band, gain: old.kind === 'audio' ? old.gain : 1 }
    case 'density':
      return { kind: 'density', trackId: a, window: old.kind === 'density' ? old.window : 0.5 }
    default:
      return {
        kind: 'beat', division: Number(a) || 1,
        decay: old.kind === 'beat' ? old.decay : 0.15,
      }
  }
}

function sourceOptions(p: Project) {
  const opts: { value: string; label: string }[] = []
  for (const t of p.tracks) {
    if (t.midi) {
      opts.push({ value: `trigger:${t.id}`, label: `${t.name} · MIDI hits` })
      opts.push({ value: `density:${t.id}`, label: `${t.name} · note density` })
    }
    if (t.audio) {
      for (const band of ['rms', 'low', 'mid', 'high'] as const) {
        opts.push({ value: `audio:${t.id}:${band}`, label: `${t.name} · audio ${band}` })
      }
    }
  }
  opts.push({ value: 'beat:1', label: 'beat pulse' })
  opts.push({ value: 'beat:4', label: 'bar pulse' })
  return opts
}

function MappingRow({ m, p, defs }: { m: MappingConfig; p: Project; defs: ParamDef[] }) {
  const def = defs.find((d) => d.key === m.targetParam)
  const src = m.source
  const srcTrack = 'trackId' in src ? p.tracks.find((t) => t.id === src.trackId) : null
  const notesInRange = src.kind === 'trigger' && srcTrack?.midi
    ? srcTrack.midi.notes.filter((n) => n.midi >= src.pitchLo && n.midi <= src.pitchHi).length
    : null
  return (
    <div className="mapping">
      <div className="row">
        <select
          value={sourceValue(src)}
          onChange={(e) => p.updateMapping(m.id, { source: decodeSource(e.target.value, src) })}
        >
          {sourceOptions(p).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span>→</span>
        <select
          value={m.targetParam}
          onChange={(e) => p.updateMapping(m.id, { targetParam: e.target.value })}
        >
          {defs.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
        <button className="mini" onClick={() => p.removeMapping(m.id)}>✕</button>
      </div>
      <SignalMeter spec={src} p={p} />
      {src.kind === 'trigger' && (
        <>
          <Slider label="decay s" min={0.02} max={0.8} step={0.01} value={src.decay}
            onChange={(v) => p.updateMapping(m.id, { source: { ...src, decay: v } })} />
          <div className="row">
            <span className="hint">pitch range</span>
            <input className="num" type="number" min={0} max={127} value={src.pitchLo}
              onChange={(e) => p.updateMapping(m.id, { source: { ...src, pitchLo: Number(e.target.value) } })} />
            <input className="num" type="number" min={0} max={127} value={src.pitchHi}
              onChange={(e) => p.updateMapping(m.id, { source: { ...src, pitchHi: Number(e.target.value) } })} />
            <span className={notesInRange === 0 ? 'error' : 'hint'}>
              {notesInRange === 0 ? '⚠ 0 notes in range!' : `${notesInRange} notes`}
            </span>
          </div>
        </>
      )}
      {src.kind === 'audio' && (
        <Slider label="gain" min={0} max={4} step={0.02} value={src.gain}
          onChange={(v) => p.updateMapping(m.id, { source: { ...src, gain: v } })} />
      )}
      {src.kind === 'density' && (
        <Slider label="window s" min={0.1} max={2} step={0.05} value={src.window}
          onChange={(v) => p.updateMapping(m.id, { source: { ...src, window: v } })} />
      )}
      {src.kind === 'beat' && (
        <Slider label="decay s" min={0.02} max={0.8} step={0.01} value={src.decay ?? 0.15}
          onChange={(v) => p.updateMapping(m.id, { source: { ...src, decay: v } })} />
      )}
      {def && !def.event && (
        <>
          <Slider label="amount" min={-2} max={2} step={0.02} value={m.scale}
            onChange={(v) => p.updateMapping(m.id, { scale: v })} />
          <Slider label="curve" min={0.25} max={4} step={0.05} value={m.curve}
            onChange={(v) => p.updateMapping(m.id, { curve: v })} />
        </>
      )}
      {def?.event && src.kind === 'audio' && (
        <div className="hint">cuts fire on audio onsets — raise gain if hits are missed, lower if too many</div>
      )}
      {def?.event && src.kind === 'density' && (
        <div className="hint">⚠ note density can't drive cuts — use MIDI hits or an audio band</div>
      )}
    </div>
  )
}

/** all mappings targeting one layer (or 'fx'), with an add button pre-targeted */
export function MappingList({ target }: { target: string }) {
  const p = useProject()
  const layer = p.layers.find((l) => l.id === target)
  const defs = target === 'fx' ? FX_PARAMS : layer ? PARAM_DEFS[layer.kind] : []
  const maps = p.mappings.filter((m) => m.targetLayer === target)
  return (
    <div className="mappings">
      {maps.map((m) => <MappingRow key={m.id} m={m} p={p} defs={defs} />)}
      <button className="mini" onClick={() => p.addMapping(target)}>+ add signal</button>
    </div>
  )
}
