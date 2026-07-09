import { useEffect, useRef } from 'react'
import type { NoteEvent } from '../core/types'

export function Waveform({ peaks, height, progress, onSeek, color = '#6ea8ff' }: {
  peaks: Float32Array | null
  height: number
  progress?: number
  onSeek?: (frac: number) => void
  color?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const width = canvas.clientWidth || 600
    canvas.width = width
    canvas.height = height
    const g = canvas.getContext('2d')!
    g.clearRect(0, 0, width, height)
    if (peaks) {
      const bins = peaks.length / 2
      g.fillStyle = color
      for (let x = 0; x < width; x++) {
        const b = Math.min(bins - 1, Math.floor((x / width) * bins))
        const min = peaks[b * 2]
        const max = peaks[b * 2 + 1]
        const y = ((1 - max) * height) / 2
        const h = Math.max(1, ((max - min) * height) / 2)
        g.fillRect(x, y, 1, h)
      }
    }
    if (progress !== undefined) {
      g.fillStyle = '#ffffff'
      g.fillRect(Math.floor(progress * width), 0, 2, height)
    }
  }, [peaks, height, progress, color])

  return (
    <canvas
      ref={ref}
      className="waveform"
      style={{ height, cursor: onSeek ? 'pointer' : 'default' }}
      onPointerDown={(e) => {
        if (!onSeek) return
        const r = e.currentTarget.getBoundingClientRect()
        onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)))
      }}
    />
  )
}

export function NoteLane({ notes, duration, height }: {
  notes: NoteEvent[]
  duration: number
  height: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const width = canvas.clientWidth || 600
    canvas.width = width
    canvas.height = height
    const g = canvas.getContext('2d')!
    g.clearRect(0, 0, width, height)
    if (!notes.length || duration <= 0) return
    let lo = 127
    let hi = 0
    for (const n of notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi) }
    const span = Math.max(1, hi - lo)
    g.fillStyle = '#e8b34b'
    for (const n of notes) {
      const x = (n.time / duration) * width
      const y = height - 2 - ((n.midi - lo) / span) * (height - 4)
      g.fillRect(x, y, Math.max(1.5, (n.duration / duration) * width), 2)
    }
  }, [notes, duration, height])

  return <canvas ref={ref} className="waveform" style={{ height }} />
}
