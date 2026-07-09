// Generates test assets in fixtures/: a 200 BPM drum MIDI + matching synthesized
// stem, and a held-bass stem + MIDI. Lets you verify visual sync precisely
// before using real song exports.  Usage: npm run fixtures
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(import.meta.dirname, '..', 'fixtures')
mkdirSync(OUT, { recursive: true })

const BPM = 200
const BEAT = 60 / BPM
const BARS = 16 // ~19.2 s
const SR = 44100
const PPQ = 480

// --- pattern (times in beats) ------------------------------------------------
const KICK = 36, SNARE = 38, HAT = 42
const pattern = []
for (let bar = 0; bar < BARS; bar++) {
  const b = bar * 4
  for (const k of [0, 0.5, 2.5]) pattern.push({ beat: b + k, note: KICK, vel: 110 })
  for (const s of [1, 3]) pattern.push({ beat: b + s, note: SNARE, vel: 105 })
  for (let h = 0; h < 4; h += 0.5) pattern.push({ beat: b + h, note: HAT, vel: h % 1 ? 60 : 85 })
  if (bar % 4 === 3) { // fill: snare 16ths on last beat
    for (let f = 0; f < 1; f += 0.25) pattern.push({ beat: b + 3 + f, note: SNARE, vel: 90 })
  }
}
pattern.sort((a, b) => a.beat - b.beat)

// --- minimal MIDI writer (format 0) -------------------------------------------
function vlq(n) {
  const bytes = [n & 0x7f]
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80)
  return bytes
}

function writeMidi(path, events, tempoUs) {
  const track = [0, 0xff, 0x51, 0x03, (tempoUs >> 16) & 0xff, (tempoUs >> 8) & 0xff, tempoUs & 0xff]
  let lastTick = 0
  for (const e of events.sort((a, b) => a.tick - b.tick || a.data[0] - b.data[0])) {
    track.push(...vlq(e.tick - lastTick), ...e.data)
    lastTick = e.tick
  }
  track.push(0, 0xff, 0x2f, 0)
  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >> 24) & 0xff, (track.length >> 16) & 0xff, (track.length >> 8) & 0xff, track.length & 0xff,
  ]
  writeFileSync(path, Buffer.from([...header, ...track]))
}

const drumEvents = []
for (const p of pattern) {
  const tick = Math.round(p.beat * PPQ)
  drumEvents.push({ tick, data: [0x99, p.note, p.vel] })
  drumEvents.push({ tick: tick + PPQ / 8, data: [0x89, p.note, 0] })
}
writeMidi(join(OUT, 'drums.mid'), drumEvents, Math.round(60e6 / BPM))

// held bass note per 2 bars
const bassEvents = []
for (let bar = 0; bar < BARS; bar += 2) {
  bassEvents.push({ tick: bar * 4 * PPQ, data: [0x90, 33, 100] })
  bassEvents.push({ tick: (bar + 2) * 4 * PPQ - 10, data: [0x80, 33, 0] })
}
writeMidi(join(OUT, 'bass.mid'), bassEvents, Math.round(60e6 / BPM))

// --- WAV writer ---------------------------------------------------------------
function writeWav(path, samples) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}

const durSec = BARS * 4 * BEAT + 1
const N = Math.round(durSec * SR)

// drums stem: synthesized hits at exactly the MIDI times
const drums = new Float32Array(N)
let noiseState = 1
const noise = () => {
  noiseState = (noiseState * 1103515245 + 12345) & 0x7fffffff
  return noiseState / 0x3fffffff - 1
}
for (const p of pattern) {
  const start = Math.round(p.beat * BEAT * SR)
  const vel = p.vel / 127
  if (p.note === KICK) {
    for (let i = 0; i < SR * 0.15; i++) {
      const t = i / SR
      drums[start + i] += Math.sin(2 * Math.PI * (55 + 160 * Math.exp(-t * 35)) * t) * Math.exp(-t * 22) * vel * 0.9
    }
  } else if (p.note === SNARE) {
    for (let i = 0; i < SR * 0.09; i++) {
      const t = i / SR
      drums[start + i] += (noise() * 0.7 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 40) * vel * 0.7
    }
  } else {
    let hp = 0
    for (let i = 0; i < SR * 0.04; i++) {
      const t = i / SR
      const n = noise()
      const out = n - hp
      hp = hp + 0.25 * (n - hp)
      drums[start + i] += out * Math.exp(-t * 90) * vel * 0.35
    }
  }
}
writeWav(join(OUT, 'drums.wav'), drums)

// bass stem: held 55 Hz saw-ish tone gated to the bass MIDI, slow wobble
const bass = new Float32Array(N)
for (let bar = 0; bar < BARS; bar += 2) {
  const start = Math.round(bar * 4 * BEAT * SR)
  const end = Math.round((bar + 2) * 4 * BEAT * SR)
  for (let i = start; i < end && i < N; i++) {
    const t = (i - start) / SR
    const wobble = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.7 * t)
    const ph = 55 * t
    const saw = 2 * (ph - Math.floor(ph + 0.5))
    const env = Math.min(1, t * 20) * Math.min(1, (end - i) / SR * 20)
    bass[i] = saw * wobble * env * 0.5
  }
}
writeWav(join(OUT, 'bass.wav'), bass)

console.log(`wrote fixtures to ${OUT}: drums.mid drums.wav bass.mid bass.wav (${durSec.toFixed(1)}s @ ${BPM}bpm)`)
