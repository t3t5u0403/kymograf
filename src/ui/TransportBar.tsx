import { useEffect, useReducer } from 'react'
import { useProject } from '../core/store'
import { transport } from '../core/transport'

function fmt(t: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

export function TransportBar() {
  const p = useProject()
  const [, bump] = useReducer((c: number) => c + 1, 0)
  useEffect(() => {
    const iv = setInterval(bump, 100)
    return () => clearInterval(iv)
  }, [])

  const t = transport.time()
  const dur = p.duration
  const beat = Math.floor((t * p.bpm) / 60)

  return (
    <footer className="transport">
      <button
        className="play small"
        title="back to start"
        onClick={() => transport.seek(0)}
        disabled={dur === 0}
      >
        ⏮
      </button>
      <button
        className="play"
        onClick={() => (transport.playing ? transport.pause() : void transport.play())}
        disabled={dur === 0}
      >
        {transport.playing ? '❚❚' : '▶'}
      </button>
      <div className="time">
        <div>{fmt(t)} / {fmt(dur)}</div>
        <div className="hint">bar {Math.floor(beat / 4) + 1} · beat {(beat % 4) + 1}</div>
      </div>
      <button
        className={transport.loopEnabled ? 'on' : ''}
        disabled={!transport.loopValid && !transport.selectionValid}
        title={transport.selectionValid
          ? 'loop the highlighted selection (ctrl+L)'
          : transport.loopValid
            ? `loop ${fmt(transport.loopStart)} – ${fmt(transport.loopEnd)} (ctrl+L)`
            : 'drag across a track to highlight a region, then loop it'}
        onClick={() => transport.applyLoopOrToggle()}
      >⟲ loop</button>
      <button
        className={p.snapEnabled ? 'on' : ''}
        title="magnetize timeline edits to the beat grid (hold alt to bypass)"
        onClick={() => p.toggleSnap()}
      >🧲 snap</button>
      <div className="hint" style={{ marginLeft: 'auto', textAlign: 'right' }}>
        space play/pause · drag across audio to highlight → ctrl+L loops it · esc clears · ruler drag scrubs<br />
        layers: drag draws region, edges resize, dbl-click deletes · ctrl+wheel zoom · alt = no snap
      </div>
    </footer>
  )
}
