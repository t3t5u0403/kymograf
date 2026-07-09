/** Deterministic PRNG — seeded so preview and export render identically. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One deterministic random number keyed by (seed, k1, k2). */
export function randAt(seed: number, k1: number, k2 = 0): number {
  return mulberry32((seed ^ Math.imul(k1, 2654435761) ^ Math.imul(k2, 40503)) >>> 0)()
}

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
