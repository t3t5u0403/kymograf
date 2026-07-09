import type { LayerKind } from './types'

export interface ParamDef {
  key: string
  label: string
  base: number
  min: number
  max: number
  /** event params advance on MIDI note counts (cuts) instead of reading an envelope */
  event?: boolean
}

export const PARAM_DEFS: Record<LayerKind, ParamDef[]> = {
  photo: [
    { key: 'cut', label: 'photo cut', base: 0, min: 0, max: 1, event: true },
    { key: 'scale', label: 'scale', base: 1, min: 0.5, max: 3 },
    { key: 'brightness', label: 'brightness', base: 1, min: 0, max: 2 },
    { key: 'alpha', label: 'opacity', base: 1, min: 0, max: 1 },
  ],
  shards: [
    { key: 'cut', label: 'reshuffle', base: 0, min: 0, max: 1, event: true },
    { key: 'displace', label: 'displace', base: 0, min: 0, max: 1 },
    { key: 'grid', label: 'grid size', base: 5, min: 2, max: 12 },
    { key: 'scale', label: 'scale', base: 1, min: 0.5, max: 3 },
    { key: 'alpha', label: 'opacity', base: 1, min: 0, max: 1 },
  ],
  shapes: [
    { key: 'cut', label: 'rearrange', base: 0, min: 0, max: 1, event: true },
    { key: 'pulse', label: 'pulse', base: 0, min: 0, max: 1 },
    { key: 'count', label: 'count', base: 8, min: 1, max: 32 },
    { key: 'mode', label: 'mode', base: 0, min: 0, max: 15 },
    { key: 'rotate', label: 'rotate', base: 0, min: 0, max: 1 },
    { key: 'spin', label: 'spin speed', base: 0, min: -1, max: 1 },
    { key: 'hue', label: 'hue', base: 0, min: 0, max: 360 },
    { key: 'sat', label: 'saturation', base: 0, min: 0, max: 1 },
    { key: 'alpha', label: 'opacity', base: 1, min: 0, max: 1 },
  ],
  scope: [
    { key: 'mode', label: 'mode', base: 0, min: 0, max: 4 },
    { key: 'amp', label: 'amplitude', base: 1, min: 0, max: 3 },
    { key: 'fuzz', label: 'fuzz', base: 0.4, min: 0, max: 1 },
    { key: 'thickness', label: 'thickness', base: 3, min: 1, max: 12 },
    { key: 'trigger', label: 'trigger lock', base: 1, min: 0, max: 1 },
    { key: 'hue', label: 'hue', base: 130, min: 0, max: 360 },
    { key: 'sat', label: 'saturation', base: 0.9, min: 0, max: 1 },
    { key: 'ypos', label: 'y position / radius', base: 0.5, min: 0, max: 1 },
    { key: 'alpha', label: 'opacity', base: 1, min: 0, max: 1 },
  ],
  bg: [
    { key: 'cut', label: 'color jump', base: 0, min: 0, max: 1, event: true },
    { key: 'hue', label: 'hue', base: 0, min: 0, max: 360 },
    { key: 'sat', label: 'saturation', base: 0.7, min: 0, max: 1 },
    { key: 'light', label: 'lightness', base: 0.15, min: 0, max: 1 },
    { key: 'alpha', label: 'opacity', base: 1, min: 0, max: 1 },
  ],
}

export const SHAPE_MODES = [
  'bars', 'rings', 'grid', 'triangles', 'burst', 'dots', 'tunnel', 'polygons', 'scatter lines',
  'crosses', 'diamonds', 'spiral', 'checker', 'arcs', 'stars', 'blocks',
]

export const SCOPE_MODES = ['line', 'mirrored', 'circle', 'lissajous (XY)', 'waterfall']

export const FX_PARAMS: ParamDef[] = [
  { key: 'punch', label: 'zoom punch', base: 0, min: 0, max: 1 },
  { key: 'shake', label: 'shake', base: 0, min: 0, max: 1 },
  { key: 'rgbSplit', label: 'RGB split px', base: 0, min: 0, max: 40 },
  { key: 'glitch', label: 'slice glitch', base: 0, min: 0, max: 1 },
  { key: 'pixelate', label: 'pixelate', base: 0, min: 0, max: 1 },
  { key: 'zoomBlur', label: 'zoom blur', base: 0, min: 0, max: 1 },
  { key: 'feedback', label: 'feedback', base: 0, min: 0, max: 0.95 },
  { key: 'fbZoom', label: 'feedback zoom', base: 1.03, min: 0.9, max: 1.25 },
  { key: 'fbRotate', label: 'feedback rotate', base: 0, min: -0.15, max: 0.15 },
  { key: 'flash', label: 'white flash', base: 0, min: 0, max: 1 },
  { key: 'invert', label: 'invert', base: 0, min: 0, max: 1 },
  { key: 'stutter', label: 'time stutter', base: 0, min: 0, max: 1 },
  { key: 'hueShift', label: 'hue rotate', base: 0, min: 0, max: 360 },
  { key: 'saturate', label: 'saturation', base: 0, min: -1, max: 1 },
  { key: 'contrast', label: 'contrast', base: 0, min: -1, max: 1 },
  { key: 'grain', label: 'grain', base: 0, min: 0, max: 1 },
  { key: 'crt', label: 'CRT / scanlines', base: 0, min: 0, max: 1 },
  { key: 'twist', label: 'twist', base: 0, min: -1, max: 1 },
  { key: 'bulge', label: 'bulge', base: 0, min: -1, max: 1 },
]

export function paramDefsFor(targetLayer: string, kind?: LayerKind): ParamDef[] {
  if (targetLayer === 'fx') return FX_PARAMS
  return kind ? PARAM_DEFS[kind] : []
}
