import { FX_PARAMS, PARAM_DEFS } from '../core/params'
import type { MappingConfig } from '../core/types'
import type { project as ProjectStore } from '../core/store'
import { buildSignal, type Signal } from '../signals/signal'

type Project = typeof ProjectStore

export interface FrameParams {
  /** layerId -> resolved param values (event params carry cumulative counts) */
  layers: Map<string, Record<string, number>>
  fx: Record<string, number>
}

interface Resolved {
  mapping: MappingConfig
  signal: Signal
  event: boolean
  min: number
  max: number
}

/**
 * Resolves mapping configs into live signals (cached against project.version)
 * and evaluates every mapped parameter for a given song time.
 */
export class MappingEngine {
  private cacheVersion = -1
  private resolved: Resolved[] = []

  update(project: Project) {
    if (project.version === this.cacheVersion) return
    this.cacheVersion = project.version
    this.resolved = []
    for (const mapping of project.mappings) {
      const layer = project.layers.find((l) => l.id === mapping.targetLayer)
      const defs = mapping.targetLayer === 'fx' ? FX_PARAMS : layer ? PARAM_DEFS[layer.kind] : []
      const def = defs.find((d) => d.key === mapping.targetParam)
      if (!def) continue
      const signal = buildSignal(mapping.source, project.tracks, project.bpm)
      this.resolved.push({
        mapping,
        signal,
        event: !!def.event,
        min: def.min,
        max: def.max,
      })
    }
  }

  evaluate(t: number, project: Project): FrameParams {
    const layers = new Map<string, Record<string, number>>()
    for (const l of project.layers) layers.set(l.id, { ...l.params })
    // FX chain gates like a layer: outside its regions everything is neutral
    const fxActive = project.fxEnabled
      && (!project.fxRegions.length || project.fxRegions.some((r) => t >= r[0] && t < r[1]))
    const fx: Record<string, number> = {}
    for (const def of FX_PARAMS) {
      fx[def.key] = fxActive ? project.fxBase[def.key] ?? def.base : def.base
    }

    for (const r of this.resolved) {
      if (r.mapping.targetLayer === 'fx' && !fxActive) continue
      const target = r.mapping.targetLayer === 'fx' ? fx : layers.get(r.mapping.targetLayer)
      if (!target) continue
      const key = r.mapping.targetParam
      if (r.event) {
        // event params accumulate trigger counts — layers key visuals off them
        target[key] = (target[key] ?? 0) + (r.signal.count?.(t) ?? 0)
      } else {
        const v = Math.max(0, Math.min(1, r.signal.sample(t)))
        // amount is range-relative: 1.0 sweeps the param's full min..max span
        const span = r.max - r.min
        target[key] = Math.max(
          r.min,
          Math.min(r.max, (target[key] ?? 0) + r.mapping.scale * Math.pow(v, r.mapping.curve) * span),
        )
      }
    }
    return { layers, fx }
  }
}
