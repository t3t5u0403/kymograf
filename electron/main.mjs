import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, watch } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let win = null
const watchers = new Map()
// --smoke: hidden window, verify the app + native bridge boot, exit with status
const SMOKE = process.argv.includes('--smoke')

// Wayland compositors associate windows with icons via app_id
app.commandLine.appendSwitch('wayland-app-id', 'kymograf')

/** Buffers come from a shared pool — slice to a standalone ArrayBuffer for IPC */
const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

async function packFile(p) {
  return { name: path.basename(p), path: p, data: toArrayBuffer(await readFile(p)) }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    show: !SMOKE,
    backgroundColor: '#0e0e10',
    title: 'kymograf',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  win.removeMenu()
  if (app.isPackaged) {
    // shipped builds load their bundled UI only — never a dev server
    void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  } else {
    const devUrl = process.env.ELECTRON_START_URL ?? 'http://localhost:5173'
    win.loadURL(devUrl).catch(() => {
      void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
    })
  }

  if (SMOKE) {
    setTimeout(() => { console.log('SMOKE: TIMEOUT'); app.exit(2) }, 20000)
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log('SMOKE: LOAD-FAIL', code, desc)
      app.exit(1)
    })
    win.webContents.on('did-finish-load', async () => {
      const ok = await win.webContents.executeJavaScript(`new Promise((res) => {
        const t0 = Date.now()
        const iv = setInterval(() => {
          const ok = !!window.kymografNative && !!document.querySelector('.app')
          if (ok || Date.now() - t0 > 8000) { clearInterval(iv); res(ok) }
        }, 100)
      })`)
      let ipcOk = false
      if (ok) {
        // probe a file that exists in dev AND inside packaged asar
        const probe = path.join(__dirname, '..', 'package.json')
        try {
          const bytes = await win.webContents.executeJavaScript(
            `window.kymografNative.readFile(${JSON.stringify(probe)}).then((f) => f.data.byteLength)`,
          )
          ipcOk = bytes > 50
          console.log('SMOKE readFile bytes:', bytes)
        } catch (e) {
          console.log('SMOKE readFile failed:', e.message)
        }
      }
      console.log('SMOKE:', ok && ipcOk ? 'PASS' : 'FAIL')
      app.exit(ok && ipcOk ? 0 : 1)
    })
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())

const MEDIA_FILTERS = [
  { name: 'media', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aif', 'aiff', 'mid', 'midi', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'json'] },
  { name: 'all files', extensions: ['*'] },
]

ipcMain.handle('read-file', (_e, p) => packFile(p))

ipcMain.handle('open-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: MEDIA_FILTERS,
  })
  if (r.canceled) return []
  return Promise.all(r.filePaths.map(packFile))
})

ipcMain.handle('save-project', async (_e, json, suggested) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: suggested ?? 'project.kymograf.json',
    filters: [{ name: 'kymograf project', extensions: ['json'] }],
  })
  if (r.canceled || !r.filePath) return null
  await writeFile(r.filePath, json)
  return r.filePath
})

ipcMain.handle('open-project', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'kymograf project', extensions: ['json'] }],
  })
  if (r.canceled || !r.filePaths[0]) return null
  return { path: r.filePaths[0], json: await readFile(r.filePaths[0], 'utf8') }
})

// dev-only: pull latest app code from a dev machine (tar over ssh). Configured
// via KYMOGRAF_UPDATE_SRC=user@host:path/ or a gitignored .update-src file in
// the app root; when neither exists the update button doesn't appear at all.
let UPDATE_SRC = process.env.KYMOGRAF_UPDATE_SRC ?? null
if (!UPDATE_SRC) {
  try {
    UPDATE_SRC = (await readFile(path.join(__dirname, '..', '.update-src'), 'utf8')).trim() || null
  } catch { /* not configured */ }
}

ipcMain.handle('update-available', () => !!UPDATE_SRC)

ipcMain.handle('update-app', () => new Promise((resolve) => {
  if (!UPDATE_SRC) {
    resolve({ code: -1, out: 'no update source configured (.update-src or KYMOGRAF_UPDATE_SRC)' })
    return
  }
  const appRoot = path.join(__dirname, '..')
  const sep = UPDATE_SRC.indexOf(':')
  const host = UPDATE_SRC.slice(0, sep)
  const dir = UPDATE_SRC.slice(sep + 1) || '.'
  // download the snapshot fully BEFORE deleting anything — a dead ssh
  // connection must never leave a half-updated app
  const cmd = [
    `ssh -o BatchMode=yes "${host}" "cd '${dir}' && tar czf - --exclude node_modules --exclude dist --exclude .git --exclude fixtures ." > .update.tgz`,
    `&& rm -rf src electron scripts`,
    `&& tar xzf .update.tgz && rm -f .update.tgz`,
    `&& npm install --no-audit --no-fund`,
    `&& npm run build`, // the app serves dist/ — stale dist means stale UI
  ].join(' ')
  const child = spawn('bash', ['-lc', cmd], { cwd: appRoot })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  child.on('close', (code) => resolve({ code, out: out.slice(-2000) }))
  child.on('error', (e) => resolve({ code: -1, out: String(e) }))
}))

ipcMain.handle('relaunch', () => {
  app.relaunch()
  app.exit(0)
})

// packaged app loads over file:// where fetch() is blocked — serve the bundled
// demo pack through IPC instead (works from inside the asar)
ipcMain.handle('read-demo-file', (_e, name) =>
  packFile(path.join(__dirname, '..', 'dist', 'demo', path.basename(name))))

const autosavePath = () => path.join(app.getPath('userData'), 'autosave.kymograf.json')
ipcMain.handle('autosave-write', (_e, json) => writeFile(autosavePath(), json))
ipcMain.handle('autosave-read', async () => {
  try { return await readFile(autosavePath(), 'utf8') } catch { return null }
})

// --- save exported video, remuxing audio to AAC via ffmpeg when available ----
// (phones don't handle Opus-in-MP4; -c:v copy keeps the video untouched)
let videoSave = null

ipcMain.handle('save-video-begin', async (_e, suggested) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: suggested ?? 'export.mp4',
    filters: [{ name: 'mp4 video', extensions: ['mp4'] }],
  })
  if (r.canceled || !r.filePath) return null
  const tmp = r.filePath + '.opus-tmp.mp4'
  videoSave = { tmp, final: r.filePath, stream: createWriteStream(tmp) }
  return r.filePath
})

ipcMain.handle('save-video-chunk', (_e, buf) => new Promise((resolve, reject) => {
  videoSave.stream.write(Buffer.from(buf), (err) => (err ? reject(err) : resolve()))
}))

ipcMain.handle('save-video-end', async () => {
  const { tmp, final, stream } = videoSave
  videoSave = null
  await new Promise((resolve) => stream.end(resolve))
  const remuxed = await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-y', '-i', tmp, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', final])
    p.on('close', (code) => resolve(code === 0))
    p.on('error', () => resolve(false)) // ffmpeg not installed
  })
  if (remuxed) {
    await unlink(tmp)
    return { aac: true }
  }
  await rename(tmp, final)
  return { aac: false }
})

// watch the project's source files; debounced per path (DAW bounces write in bursts)
ipcMain.handle('watch-files', (_e, paths) => {
  for (const [p, w] of watchers) { w.close(); watchers.delete(p) }
  for (const p of paths) {
    try {
      let timer = null
      const w = watch(p, () => {
        clearTimeout(timer)
        timer = setTimeout(() => win?.webContents.send('file-changed', p), 400)
      })
      watchers.set(p, w)
    } catch { /* file may be gone; watcher just doesn't attach */ }
  }
})
