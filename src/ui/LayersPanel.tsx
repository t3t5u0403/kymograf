import { useState } from 'react'
import { FX_PARAMS, PARAM_DEFS, SCOPE_MODES, SHAPE_MODES } from '../core/params'
import { useProject } from '../core/store'
import type { LayerConfig, LayerKind } from '../core/types'
import type { project as ProjectStore } from '../core/store'
import { MappingList } from './MappingPanel'
import { Slider } from './Slider'

type Project = typeof ProjectStore

const KINDS: { kind: LayerKind; label: string }[] = [
  { kind: 'photo', label: '+ photo' },
  { kind: 'shards', label: '+ shards' },
  { kind: 'shapes', label: '+ shapes' },
  { kind: 'scope', label: '+ scope' },
  { kind: 'bg', label: '+ background' },
]

function LayerCard({ l, p, open, onToggle }: {
  l: LayerConfig
  p: Project
  open: boolean
  onToggle: () => void
}) {
  const enabled = l.enabled ?? true
  const nMaps = p.mappings.filter((m) => m.targetLayer === l.id).length
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <div className={`layer card ${enabled ? '' : 'disabled'}`}>
      <div className="row head" onClick={onToggle}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <input
          className="name-edit"
          value={l.name}
          onClick={stop}
          onChange={(e) => p.renameLayer(l.id, e.target.value)}
        />
        <span className="hint">{l.kind}</span>
        <button
          className={`mini ${enabled ? 'on' : ''}`}
          title="enable/disable"
          onClick={(e) => { stop(e); p.toggleLayerEnabled(l.id) }}
        >{enabled ? 'on' : 'off'}</button>
        <button className="mini" title="move up" onClick={(e) => { stop(e); p.moveLayer(l.id, -1) }}>↑</button>
        <button className="mini" title="move down" onClick={(e) => { stop(e); p.moveLayer(l.id, 1) }}>↓</button>
        <button className="mini" title="delete" onClick={(e) => { stop(e); p.removeLayer(l.id) }}>✕</button>
      </div>
      {!open && (
        <div className="hint summary" onClick={onToggle}>
          {nMaps ? `${nMaps} signal${nMaps > 1 ? 's' : ''}` : 'no signals — static'}
          {(l.kind === 'photo' || l.kind === 'shards') ? ` · ${l.photoIds.length} photos` : ''}
          {l.regions?.length ? ` · gated ×${l.regions.length}` : ''}
        </div>
      )}
      {open && (
        <>
          {l.kind === 'scope' && (
            <>
              <label className="param">
                <span>mode</span>
                <select
                  value={Math.round(l.params.mode ?? 0)}
                  onChange={(e) => p.setLayerParam(l.id, 'mode', Number(e.target.value))}
                >
                  {SCOPE_MODES.map((m, i) => <option key={m} value={i}>{m}</option>)}
                </select>
              </label>
              <label className="param">
                <span>{Math.round(l.params.mode ?? 0) === 3 ? 'stem X' : 'stem'}</span>
                <select value={l.trackId ?? ''} onChange={(e) => p.setLayerTrack(l.id, e.target.value)}>
                  {p.tracks.filter((t) => t.audio).map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
              {Math.round(l.params.mode ?? 0) === 3 && (
                <label className="param">
                  <span>stem Y</span>
                  <select value={l.trackId2 ?? ''} onChange={(e) => p.setLayerTrack(l.id, e.target.value, 2)}>
                    <option value="">(same as X)</option>
                    {p.tracks.filter((t) => t.audio).map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          {l.kind === 'shapes' && (
            <label className="param">
              <span>mode</span>
              <select
                value={Math.round(l.params.mode ?? 0)}
                onChange={(e) => p.setLayerParam(l.id, 'mode', Number(e.target.value))}
              >
                {SHAPE_MODES.map((m, i) => <option key={m} value={i}>{m}</option>)}
              </select>
            </label>
          )}
          {PARAM_DEFS[l.kind].filter((d) => !d.event && d.key !== 'mode').map((def) => (
            <Slider
              key={def.key}
              label={def.label}
              min={def.min}
              max={def.max}
              step={(def.max - def.min) / 200}
              value={l.params[def.key] ?? def.base}
              onChange={(v) => p.setLayerParam(l.id, def.key, v)}
            />
          ))}
          {(l.kind === 'photo' || l.kind === 'shards') && (
            <div className="chips">
              {p.photos.map((ph) => (
                <button
                  key={ph.id}
                  className={`chip ${l.photoIds.includes(ph.id) ? 'on' : ''}`}
                  title={ph.name}
                  onClick={() => p.togglePhotoInLayer(l.id, ph.id)}
                >
                  {ph.name.replace(/\.[^.]+$/, '').slice(0, 12)}
                </button>
              ))}
              {p.photos.length === 0 && <span className="hint">needs photos</span>}
            </div>
          )}
          <h4>driven by</h4>
          <MappingList target={l.id} />
        </>
      )}
    </div>
  )
}

export function LayersPanel() {
  const p = useProject()
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  const nFx = p.mappings.filter((m) => m.targetLayer === 'fx').length

  const toggle = (id: string) => setOpenIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <div className="panel">
      <h3>Layers <span className="hint">(bottom renders first)</span></h3>
      <div className="row">
        {KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            onClick={() => {
              const layer = p.addLayer(kind)
              setOpenIds((prev) => new Set(prev).add(layer.id))
            }}
          >{label}</button>
        ))}
      </div>
      {p.layers.map((l) => (
        <LayerCard key={l.id} l={l} p={p} open={openIds.has(l.id)} onToggle={() => toggle(l.id)} />
      ))}
      {p.layers.length === 0 && <div className="hint">add a layer to start rendering</div>}

      <div className="layer card">
        <div className="row head" onClick={() => toggle('fx')}>
          <span className="chev">{openIds.has('fx') ? '▾' : '▸'}</span>
          <span className="name">FX chain</span>
          <span className="hint">whole frame</span>
        </div>
        {!openIds.has('fx') && (
          <div className="hint summary" onClick={() => toggle('fx')}>
            {nFx ? `${nFx} signal${nFx > 1 ? 's' : ''}` : 'rgb split · feedback · flash · invert · stutter'}
          </div>
        )}
        {openIds.has('fx') && (
          <>
            {FX_PARAMS.map((def) => (
              <Slider
                key={def.key}
                label={def.label}
                min={def.min}
                max={def.max}
                step={(def.max - def.min) / 200}
                value={p.fxBase[def.key] ?? def.base}
                onChange={(v) => p.setFxBase(def.key, v)}
              />
            ))}
            <h4>driven by</h4>
            <MappingList target="fx" />
          </>
        )}
      </div>
    </div>
  )
}
