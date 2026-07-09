// Headless end-to-end smoke test: loads the app, drops the fixture files,
// wires up layers + mappings, plays, and exports 2 seconds of video.
// Prereqs: `npm run fixtures`, dev server on :5199 (`npx vite --port 5199`),
// and chromium installed.  Usage: node scripts/smoke.mjs [out.mp4]
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const URL = 'http://localhost:5199'
const OUT = process.argv[2] ?? '/tmp/smoke-export.mp4'
const FIXTURES = '/@fs' + join(import.meta.dirname, '..', 'fixtures')

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
})
const page = await browser.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

const clickByText = async (text) => {
  const ok = await page.evaluate((t) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(t))
    if (btn) { btn.click(); return true }
    return false
  }, text)
  if (!ok) throw new Error(`button not found: ${text}`)
}

console.log('1. load app')
await page.goto(URL, { waitUntil: 'networkidle0' })
await page.waitForSelector('.preview-canvas', { timeout: 20000 })

console.log('2. drop fixtures (stems + midi + synthetic photos)')
await page.evaluate(async (base) => {
  const fileFrom = async (url, name, type) =>
    new File([await (await fetch(url)).blob()], name, { type })
  const files = [
    await fileFrom(`${base}/drums.wav`, 'drums.wav', 'audio/wav'),
    await fileFrom(`${base}/drums.mid`, 'drums.mid', 'audio/midi'),
    await fileFrom(`${base}/bass.wav`, 'bass.wav', 'audio/wav'),
    await fileFrom(`${base}/bass.mid`, 'bass.mid', 'audio/midi'),
  ]
  for (const [i, color] of [['#3366aa', '#ffcc33'], ['#a33', '#3fa'], ['#333', '#eee']].entries()) {
    const oc = new OffscreenCanvas(640, 360)
    const g = oc.getContext('2d')
    g.fillStyle = color[0]; g.fillRect(0, 0, 640, 360)
    g.fillStyle = color[1]; g.beginPath(); g.arc(320, 180, 60 + i * 40, 0, 7); g.fill()
    files.push(new File([await oc.convertToBlob({ type: 'image/png' })], `photo${i}.png`, { type: 'image/png' }))
  }
  const dt = new DataTransfer()
  for (const f of files) dt.items.add(f)
  document.querySelector('.app').dispatchEvent(
    new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
  )
}, FIXTURES)
await page.waitForFunction(
  () => document.querySelectorAll('.track').length >= 2
    && document.querySelectorAll('.photo').length >= 3,
  { timeout: 30000 },
)
console.log('   tracks:', await page.evaluate(() =>
  [...document.querySelectorAll('.track .name')].map((n) => n.textContent).join(', ')))

console.log('3. add layers + mappings')
await clickByText('+ photo')
await clickByText('+ shapes')
await clickByText('+ mapping') // default: first MIDI track hits -> photo cut
await clickByText('+ mapping')
await page.evaluate(() => {
  // point the 2nd mapping at bass audio low -> FX feedback
  const selects = [...document.querySelectorAll('.panel .layer select')]
  const row = selects.slice(-2)
  const set = (el, v) => {
    const s = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    s.call(el, v)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const srcOpt = [...row[0].options].find((o) => o.label.includes('bass · audio low'))
  const tgtOpt = [...row[1].options].find((o) => o.label.includes('FX · feedback'))
  if (!srcOpt || !tgtOpt) throw new Error('mapping options missing')
  set(row[0], srcOpt.value)
  set(row[1], tgtOpt.value)
})

console.log('4. play + verify frames change and time advances')
const frameAt = () => page.evaluate(() => document.querySelector('.preview-canvas').toDataURL().length)
const timeText = () => page.evaluate(() => document.querySelector('.transport .time div').textContent)
await page.click('.transport .play')
await new Promise((r) => setTimeout(r, 400))
const f1 = await frameAt()
const t1 = await timeText()
await new Promise((r) => setTimeout(r, 800))
const f2 = await frameAt()
const t2 = await timeText()
console.log(`   t=${t1} -> ${t2}, frame bytes ${f1} -> ${f2} (${f1 !== f2 ? 'changing' : 'STATIC!'})`)
if (t1 === t2) throw new Error('transport time not advancing')
await page.click('.transport .play') // pause

console.log('5. export 2 seconds')
await clickByText('export')
await page.waitForSelector('.modal')
await page.evaluate(() => {
  const end = document.querySelectorAll('.modal input.num')[1]
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  s.call(end, '2')
  end.dispatchEvent(new Event('input', { bubbles: true }))
})
await clickByText('Render')
await page.waitForSelector('.modal a[download]', { timeout: 180000 })
const info = await page.evaluate(() => ({
  link: document.querySelector('.modal a[download]').textContent,
  note: document.querySelector('.modal pre.hint')?.textContent ?? null,
}))
console.log('   ', info.link, info.note ? `| ${info.note.split('\n')[0]}` : '| audio: aac')

const b64 = await page.evaluate(async () => {
  const buf = await (await fetch(document.querySelector('.modal a[download]').href)).arrayBuffer()
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
})
writeFileSync(OUT, Buffer.from(b64, 'base64'))
console.log('   wrote', OUT, '- check with: ffprobe', OUT)

if (errors.length) {
  console.log('\nCONSOLE ERRORS:')
  for (const e of errors) console.log('  -', e)
  process.exitCode = 1
} else {
  console.log('\nno console errors ✓')
}
await browser.close()
