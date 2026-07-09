// Build the bundled demo pack: compress a project's stems to m4a, copy MIDI,
// rewrite the project JSON, output everything to public/demo/ (ships in dist).
// Usage: node scripts/make-demo.mjs <stems-dir> <project.json> [--exclude a,b]
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [srcDir, projPath] = process.argv.slice(2)
const exclude = new Set(
  (process.argv.find((a) => a.startsWith('--exclude'))?.split('=')[1]
    ?? process.argv[process.argv.indexOf('--exclude') + 1] ?? '')
    .split(',').filter(Boolean).map((s) => s.toLowerCase()),
)
if (!srcDir || !projPath) {
  console.error('usage: node scripts/make-demo.mjs <stems-dir> <project.json> [--exclude name,name]')
  process.exit(1)
}

const OUT = path.join(import.meta.dirname, '..', 'public', 'demo')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const proj = JSON.parse(readFileSync(projPath, 'utf8'))
const base = (f) => f.replace(/\.[^.]+$/, '').toLowerCase()

const dropped = proj.tracks.filter((t) => exclude.has(base(t.name)))
proj.tracks = proj.tracks.filter((t) => !exclude.has(base(t.name)))
const droppedIds = new Set(dropped.map((t) => t.id))
proj.mappings = proj.mappings.filter(
  (m) => !('trackId' in m.source && droppedIds.has(m.source.trackId)),
)
proj.assetPaths = {}

for (const t of proj.tracks) {
  if (t.audioFile) {
    const out = `${base(t.audioFile)}.m4a`
    execFileSync('ffmpeg', ['-y', '-v', 'error',
      '-i', path.join(srcDir, t.audioFile), '-c:a', 'aac', '-b:a', '144k',
      path.join(OUT, out)])
    console.log(`  ${t.audioFile} -> ${out}`)
    t.audioFile = out
  }
  if (t.midiFile) {
    copyFileSync(path.join(srcDir, t.midiFile), path.join(OUT, t.midiFile))
    console.log(`  ${t.midiFile} (copied)`)
  }
}
writeFileSync(path.join(OUT, 'demo.kymograf.json'), JSON.stringify(proj))
console.log(`demo pack written to public/demo (${proj.tracks.length} tracks, dropped: ${[...exclude].join(', ') || 'none'})`)
