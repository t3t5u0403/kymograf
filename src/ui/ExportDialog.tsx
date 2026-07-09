import { useRef, useState } from 'react'
import { native } from '../core/native'
import { useProject } from '../core/store'
import { transport } from '../core/transport'
import { exportVideo } from '../export/encoder'
import type { MappingEngine } from '../mapping/engine'
import type { Stage } from '../render/stage'

const QUALITIES = [
  { label: 'standard · 12 Mbps', bitrate: 12_000_000 },
  { label: 'high · 24 Mbps', bitrate: 24_000_000 },
  { label: 'very high · 40 Mbps', bitrate: 40_000_000 },
]

export function ExportDialog({ stage, engine, onClose }: {
  stage: Stage
  engine: MappingEngine
  onClose: () => void
}) {
  const p = useProject()
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(() => Math.round(p.duration * 100) / 100)
  const [quality, setQuality] = useState(1) // default: high
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<{ url: string; sizeMb: string; note: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const cancelRef = useRef(false)

  const saveNative = async () => {
    if (!result || !native) return
    const path = await native.saveVideoBegin('export.mp4')
    if (!path) return
    setSaving(true)
    try {
      const buf = await (await fetch(result.url)).arrayBuffer()
      const CHUNK = 32 << 20
      for (let off = 0; off < buf.byteLength; off += CHUNK) {
        await native.saveVideoChunk(buf.slice(off, off + CHUNK))
      }
      const r = await native.saveVideoEnd()
      setSavedNote(r.aac
        ? `saved ${path} — AAC audio, plays everywhere (incl. phones)`
        : `saved ${path} — Opus audio kept (install ffmpeg for automatic AAC conversion)`)
    } catch (e) {
      setSavedNote(`save failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    setSaving(false)
  }

  const run = async () => {
    cancelRef.current = false
    setError(null)
    setResult(null)
    setProgress(0)
    transport.pause()
    try {
      const res = await exportVideo(stage, engine, {
        start,
        end,
        fps: 60,
        bitrate: QUALITIES[quality].bitrate,
        onProgress: (f, t) => setProgress(f / t),
        isCancelled: () => cancelRef.current,
      })
      if (res) {
        setResult({
          url: URL.createObjectURL(res.blob),
          sizeMb: (res.blob.size / 1e6).toFixed(1),
          note: res.note,
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setProgress(null)
  }

  const busy = progress !== null
  return (
    <div className="modal-back" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Export video · 1920×1080 @ 60fps</h3>
        <div className="row">
          <label>start s
            <input className="num" type="number" min={0} step={0.1} value={start}
              onChange={(e) => setStart(Number(e.target.value))} disabled={busy} />
          </label>
          <label>end s
            <input className="num" type="number" min={0} step={0.1} value={end}
              onChange={(e) => setEnd(Number(e.target.value))} disabled={busy} />
          </label>
        </div>
        <label>quality
          <select value={quality} onChange={(e) => setQuality(Number(e.target.value))} disabled={busy}>
            {QUALITIES.map((q, i) => <option key={q.label} value={i}>{q.label}</option>)}
          </select>
        </label>
        {!busy && !result && (
          <button className="primary" onClick={run} disabled={end <= start}>
            Render {Math.max(0, Math.round((end - start) * 60))} frames
          </button>
        )}
        {busy && (
          <>
            <div className="progress"><div style={{ width: `${(progress! * 100).toFixed(1)}%` }} /></div>
            <button onClick={() => { cancelRef.current = true }}>cancel</button>
          </>
        )}
        {error && <div className="error">{error}</div>}
        {result && (
          <>
            {native ? (
              <button className="primary" onClick={saveNative} disabled={saving}>
                {saving ? 'saving…' : `save video (${result.sizeMb} MB) — AAC for phones`}
              </button>
            ) : (
              <a className="primary button" href={result.url} download="export.mp4">
                download export.mp4 ({result.sizeMb} MB)
              </a>
            )}
            {savedNote && <div className="hint">{savedNote}</div>}
            {result.note && !savedNote && <pre className="hint">{result.note}</pre>}
          </>
        )}
        {!busy && <button onClick={onClose}>close</button>}
      </div>
    </div>
  )
}
