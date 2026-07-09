import { useState } from 'react'
import { project } from '../core/store'

/** value box that tolerates mid-edit states like "0." without snapping */
function NumBox({ value, min, max, onChange }: {
  value: number; min: number; max: number
  onChange: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      className="valbox"
      type="number"
      step="any"
      value={draft ?? String(+value.toFixed(3))}
      onFocus={(e) => { setDraft(String(+value.toFixed(3))); e.target.select() }}
      onChange={(e) => {
        setDraft(e.target.value)
        const v = Number(e.target.value)
        if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)))
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
    />
  )
}

export function Slider({ label, min, max, step, value, onChange }: {
  label: string; min: number; max: number; step: number; value: number
  onChange: (v: number) => void
}) {
  return (
    <label className="param">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={() => project.beginGesture()}
        onPointerUp={() => project.endGesture()}
      />
      <NumBox value={value} min={min} max={max} onChange={onChange} />
    </label>
  )
}
