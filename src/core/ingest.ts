import { loadAudioFile } from '../audio/loader'
import { parseMidiFile } from '../midi/parse'
import { native, type NativeFile } from './native'
import { project } from './store'
import type { ProjectFile } from './types'

const AUDIO_EXT = /\.(wav|mp3|flac|ogg|m4a|aif|aiff|opus)$/i
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i

async function ingestOne(file: File): Promise<void> {
  const name = file.name
  if (/\.midi?$/i.test(name)) {
    project.addMidi(name, await parseMidiFile(file))
  } else if (/\.json$/i.test(name)) {
    await loadProjectJSON(JSON.parse(await file.text()) as ProjectFile)
  } else if (file.type.startsWith('image/') || IMAGE_EXT.test(name)) {
    project.addPhoto(name, await createImageBitmap(file))
  } else if (file.type.startsWith('audio/') || AUDIO_EXT.test(name)) {
    project.addAudio(name, await loadAudioFile(file))
  } else {
    throw new Error('unrecognized file type')
  }
}

export async function ingestFiles(files: Iterable<File>): Promise<string[]> {
  const errors: string[] = []
  for (const file of files) {
    try {
      // in Electron, dropped Files carry a resolvable absolute path — remember
      // it so the project can reload and watch its sources
      const path = native?.pathFor(file)
      await ingestOne(file)
      if (path) project.assetPaths.set(file.name, path)
    } catch (e) {
      errors.push(`${file.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (native) syncWatch()
  return errors
}

export async function ingestNativeFiles(nfiles: NativeFile[]): Promise<string[]> {
  const errors: string[] = []
  for (const nf of nfiles) {
    try {
      await ingestOne(new File([nf.data], nf.name))
      project.assetPaths.set(nf.name, nf.path)
    } catch (e) {
      errors.push(`${nf.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (native) syncWatch()
  return errors
}

/** load a project; under Electron, saved absolute paths reload automatically */
export async function loadProjectJSON(file: ProjectFile): Promise<void> {
  project.loadJSON(file)
  const n = native
  if (!n) return
  const missing = project.missingAssets()
  const loadable = missing.filter((name) => project.assetPaths.has(name))
  const results = await Promise.allSettled(
    loadable.map(async (name) => {
      const nf = await n.readFile(project.assetPaths.get(name)!)
      await ingestOne(new File([nf.data], name))
    }),
  )
  results.forEach((r, i) => {
    if (r.status === 'rejected') project.assetPaths.delete(loadable[i])
  })
  syncWatch()
}

export function saveProjectFile() {
  const json = JSON.stringify(project.toJSON(), null, 2)
  if (native) {
    void native.saveProject(json, 'project.kymograf.json')
    return
  }
  const blob = new Blob([json], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'project.kymograf.json'
  a.click()
  URL.revokeObjectURL(a.href)
}

// --- file watching (Electron): DAW re-bounces a stem -> hot reload it --------

let watchHooked = false

function syncWatch() {
  const n = native
  if (!n) return
  void n.watchFiles([...project.assetPaths.values()])
  if (watchHooked) return
  watchHooked = true
  n.onFileChanged(async (path) => {
    const name = [...project.assetPaths.entries()].find(([, p]) => p === path)?.[0]
    if (!name) return
    try {
      const nf = await n.readFile(path)
      await ingestOne(new File([nf.data], name))
    } catch { /* mid-write; the next change event retries */ }
  })
}
