import { useEffect, useRef, useState } from 'react'
import { ingestFiles, ingestNativeFiles, loadProjectJSON, saveProjectFile } from './core/ingest'
import { native } from './core/native'
import { project, useProject } from './core/store'
import { transport } from './core/transport'
import { MappingEngine } from './mapping/engine'
import { Stage } from './render/stage'
import { ExportDialog } from './ui/ExportDialog'
import { LayersPanel } from './ui/LayersPanel'
import { Timeline } from './ui/Timeline'
import { TrackList } from './ui/TrackList'
import { TransportBar } from './ui/TransportBar'

// dev-only handle for capture/debug scripts (absent from production builds)
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__kymo = { transport, project }
}

export default function App() {
  const p = useProject()
  const [stage] = useState(() => new Stage())
  const engineRef = useRef(new MappingEngine())
  const canvasHost = useRef<HTMLDivElement>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [autosaveFound, setAutosaveFound] = useState<{ json: string; when: string } | null>(null)
  const [updateAvail, setUpdateAvail] = useState(false)

  useEffect(() => {
    void native?.updateAvailable().then(setUpdateAvail).catch(() => {})
  }, [])

  useEffect(() => {
    let disposed = false
    void stage.init().then((canvas) => {
      if (disposed) return
      canvas.className = 'preview-canvas'
      canvasHost.current?.appendChild(canvas)
    })
    return () => { disposed = true }
  }, [stage])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void canvasHost.current?.requestFullscreen()
  }

  useEffect(() => {
    // global hotkeys — space/f skip text fields so typing stays safe
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        transport.applyLoopOrToggle()
        return
      }
      if (e.key === 'Escape') {
        transport.clearSelection()
        return
      }
      const t = e.target as HTMLElement
      if (t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'number')) return
      if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) project.redo()
        else project.undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        project.redo()
        return
      }
      if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        toggleFullscreen()
        return
      }
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()
      if (transport.playing) transport.pause()
      else void transport.play()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let raf = 0
    let lastT = 0
    const loop = () => {
      const t = transport.time()
      if (transport.playing && project.duration > 0 && t >= project.duration) transport.pause()
      if (t < lastT - 0.05) stage.resetTemporal() // seeked backwards
      lastT = t
      engineRef.current.update(project)
      stage.render(t, (tt) => engineRef.current.evaluate(tt, project), project)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [stage])

  useEffect(() => {
    // autosave: 3s after the last change, to disk (Electron) or localStorage
    const save = () => {
      const json = JSON.stringify({ ...project.toJSON(), savedAt: Date.now() })
      if (native) void native.autosaveWrite(json)
      else try { localStorage.setItem('kymograf-autosave', json) } catch { /* full */ }
    }
    let timer: ReturnType<typeof setTimeout>
    const unsub = project.subscribe(() => {
      clearTimeout(timer)
      timer = setTimeout(save, 3000)
    })
    // offer to restore a previous session, but only into an empty project
    void (async () => {
      const json = native ? await native.autosaveRead() : localStorage.getItem('kymograf-autosave')
      if (!json || project.tracks.length || project.layers.length) return
      try {
        const when = new Date(JSON.parse(json).savedAt ?? 0).toLocaleString()
        setAutosaveFound({ json, when })
      } catch { /* corrupt autosave — ignore */ }
    })()
    return () => { unsub(); clearTimeout(timer) }
  }, [])

  const handleFiles = async (files: Iterable<File>) => {
    setBusy(true)
    const errs = await ingestFiles(files)
    setErrors(errs)
    setBusy(false)
  }

  // the bundled demo: the real project behind the launch video
  const loadDemo = async () => {
    setBusy(true)
    try {
      const fetchDemo = async (name: string): Promise<File> => {
        if (location.protocol.startsWith('http')) {
          const r = await fetch(`demo/${encodeURIComponent(name)}`)
          if (!r.ok) throw new Error(`demo asset missing: ${name}`)
          return new File([await r.blob()], name)
        }
        const nf = await native!.readDemoFile(name) // packaged app: fetch() can't do file://
        return new File([nf.data], name)
      }
      const projText = await (await fetchDemo('demo.kymograf.json')).text()
      const proj = JSON.parse(projText)
      await loadProjectJSON(proj)
      const names: string[] = proj.tracks
        .flatMap((t: { audioFile?: string; midiFile?: string }) => [t.audioFile, t.midiFile])
        .filter(Boolean)
      setErrors(await ingestFiles(await Promise.all(names.map(fetchDemo))))
    } catch (e) {
      setErrors([`demo failed to load: ${e instanceof Error ? e.message : String(e)}`])
    }
    setBusy(false)
  }

  const missing = p.missingAssets()

  return (
    <div
      className="app"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
        // dragover fires continuously during a drag — if events stop for any
        // reason (drop elsewhere, Esc, left the window) the overlay self-clears.
        // dragleave alone is unreliable with nested elements.
        clearTimeout(dragTimer.current)
        dragTimer.current = setTimeout(() => setDragging(false), 400)
      }}
      onDrop={(e) => {
        e.preventDefault()
        clearTimeout(dragTimer.current)
        setDragging(false)
        void handleFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <header>
        <h1>kymograf</h1>
        <label>bpm
          <input className="num" type="number" min={1} max={999} value={p.bpm}
            onChange={(e) => p.setBpm(Number(e.target.value))} />
        </label>
        {native ? (
          <>
            <button onClick={async () => {
              setBusy(true)
              setErrors(await ingestNativeFiles(await native!.openFiles()))
              setBusy(false)
            }}>add files</button>
            <button onClick={async () => {
              const r = await native!.openProject()
              if (!r) return
              setBusy(true)
              await loadProjectJSON(JSON.parse(r.json))
              setBusy(false)
            }}>open project</button>
            {updateAvail && (
              <button
                disabled={updating}
                title="pull latest app code from your dev machine, reinstall deps, restart (save your project first)"
                onClick={async () => {
                  setUpdating(true)
                  const r = await native!.updateApp()
                  if (r.code === 0) { await native!.relaunch(); return }
                  setErrors([`update failed (exit ${r.code}): …${r.out.slice(-400)}`])
                  setUpdating(false)
                }}
              >{updating ? 'updating…' : '⟳ update'}</button>
            )}
          </>
        ) : (
          <label className="button">
            add files
            <input
              type="file" multiple hidden
              accept=".wav,.mp3,.flac,.ogg,.m4a,.aif,.aiff,.mid,.midi,.json,image/*"
              onChange={(e) => { if (e.target.files) void handleFiles(Array.from(e.target.files)) }}
            />
          </label>
        )}
        <button onClick={() => p.undo()} disabled={!p.canUndo} title="undo (ctrl+Z)">↶</button>
        <button onClick={() => p.redo()} disabled={!p.canRedo} title="redo (ctrl+shift+Z)">↷</button>
        <button onClick={saveProjectFile}>save project</button>
        <button className="primary" onClick={() => setExportOpen(true)} disabled={p.duration === 0}>
          export
        </button>
        {busy && <span className="hint">analyzing…</span>}
      </header>

      {autosaveFound && (
        <div className="banner">
          autosaved session from {autosaveFound.when} found —{' '}
          <button className="mini" onClick={async () => {
            await loadProjectJSON(JSON.parse(autosaveFound.json))
            setAutosaveFound(null)
          }}>restore</button>{' '}
          <button className="mini" onClick={() => setAutosaveFound(null)}>dismiss</button>
        </div>
      )}
      {missing.length > 0 && (
        <div className="banner">
          project loaded — re-drop these files to relink: {missing.join(', ')}
        </div>
      )}
      {errors.length > 0 && (
        <div className="banner error" onClick={() => setErrors([])}>
          {errors.join(' · ')} (click to dismiss)
        </div>
      )}

      <main>
        <aside className="left"><TrackList /></aside>
        <section className="center">
          <div className="canvas-host" ref={canvasHost} />
          <button className="fs-btn" title="fullscreen (f)" onClick={toggleFullscreen}>⛶</button>
          {p.layers.length === 0 && p.tracks.length === 0 && (
            <div className="overlay-hint">
              1. drop stems + MIDI + photos<br />
              2. add a layer →<br />
              3. add mappings →<br />
              4. press play<br />
              <button className="primary" onClick={loadDemo} disabled={busy}>
                {busy ? 'loading…' : '▶ load demo project'}
              </button>
            </div>
          )}
        </section>
        <aside className="right">
          <LayersPanel />
        </aside>
      </main>

      <div className="timeline-wrap"><Timeline /></div>
      <TransportBar />

      {dragging && <div className="drop-overlay">drop stems · MIDI · photos · project.json</div>}
      {exportOpen && (
        <ExportDialog stage={stage} engine={engineRef.current} onClose={() => setExportOpen(false)} />
      )}
    </div>
  )
}
