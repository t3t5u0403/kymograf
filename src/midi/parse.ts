import { Midi } from '@tonejs/midi'
import type { MidiTrackData } from '../core/types'

export async function parseMidiFile(file: File): Promise<MidiTrackData> {
  const midi = new Midi(await file.arrayBuffer())
  const notes = midi.tracks
    .flatMap((t) =>
      t.notes.map((n) => ({
        time: n.time,
        duration: n.duration,
        midi: n.midi,
        velocity: n.velocity,
        ticks: n.ticks,
        durationTicks: n.durationTicks,
      })),
    )
    .sort((a, b) => a.time - b.time)
  return {
    fileName: file.name,
    notes,
    bpm: midi.header.tempos[0]?.bpm ?? null,
    ppq: midi.header.ppq,
  }
}
