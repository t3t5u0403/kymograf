import { useEffect, useRef } from 'react'
import { useProject } from '../core/store'
import { transport } from '../core/transport'

function Thumb({ bitmap }: { bitmap: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current!
    const s = 52 / Math.max(bitmap.width, bitmap.height)
    c.width = Math.max(1, Math.round(bitmap.width * s))
    c.height = Math.max(1, Math.round(bitmap.height * s))
    c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height)
  }, [bitmap])
  return <canvas ref={ref} className="thumb" />
}

function fmt(t: number): string {
  const m = Math.floor(t / 60)
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`
}

export function TrackList() {
  const p = useProject()
  return (
    <div className="panel">
      <h3>Tracks</h3>
      {p.tracks.map((track) => (
        <div className="track" key={track.id}>
          <div className="row">
            <span className="name" title={track.name}>{track.name}</span>
            <button
              className={`mini ${track.solo ? 'solo-on' : ''}`}
              title="solo"
              onClick={() => { p.toggleSolo(track.id); transport.refresh() }}
            >S</button>
            <button
              className={`mini ${track.muted ? 'on' : ''}`}
              title="mute"
              onClick={() => { p.toggleMute(track.id); transport.refresh() }}
            >M</button>
            <button className="mini" title="remove track" onClick={() => p.removeTrack(track.id)}>✕</button>
          </div>
          <div className="hint">
            {track.audio ? `stem ${track.audio.buffer.duration.toFixed(1)}s` : 'no stem'}
          </div>
          {track.midi ? (
            <div className="hint">
              {track.midi.notes.length} notes · first at {fmt(track.midi.notes[0]?.time ?? 0)}
              {track.midi.bpm
                ? ` · file tempo ${track.midi.bpm.toFixed(1)}`
                : ' · no tempo in file → using project bpm'}
            </div>
          ) : (
            <div className="hint">no MIDI</div>
          )}
        </div>
      ))}
      {p.tracks.length === 0 && (
        <div className="hint">
          Drop stems (.wav / .mp3) and MIDI (.mid) anywhere.
          Files pair into tracks by matching file name.
        </div>
      )}

      <h3>Photos</h3>
      <div className="photo-grid">
        {p.photos.map((photo) => (
          <div className="photo" key={photo.id} title={photo.name}>
            <Thumb bitmap={photo.bitmap} />
            <button className="mini" onClick={() => p.removePhoto(photo.id)}>✕</button>
          </div>
        ))}
        {p.photos.length === 0 && <div className="hint">drop your photography here</div>}
      </div>
    </div>
  )
}
