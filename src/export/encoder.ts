import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import { project } from '../core/store'
import type { MappingEngine } from '../mapping/engine'
import { STAGE_H, STAGE_W, Stage } from '../render/stage'

export interface ExportOptions {
  start: number
  end: number
  fps: number
  /** video bitrate in bits/s — strobing content needs a lot */
  bitrate: number
  onProgress: (frame: number, total: number) => void
  isCancelled: () => boolean
}

export interface ExportResult {
  blob: Blob
  audioIncluded: boolean
  note: string | null
}

const AVC_CODECS = ['avc1.64002a', 'avc1.4d402a', 'avc1.42002a']

async function pickVideoCodec(fps: number, bitrate: number): Promise<string> {
  if (typeof VideoEncoder === 'undefined') {
    throw new Error(
      'This browser has no WebCodecs video encoder (Firefox does not support encoding yet). '
      + 'Open the app in Chrome/Chromium to export — preview works everywhere.',
    )
  }
  for (const codec of AVC_CODECS) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({
        codec, width: STAGE_W, height: STAGE_H, bitrate, framerate: fps,
      })
      if (supported) return codec
    } catch { /* try next */ }
  }
  throw new Error('No H.264 encoder available — export requires Chrome/Chromium with WebCodecs.')
}

async function pickAudioCodec(): Promise<{ mux: 'aac' | 'opus'; codec: string } | null> {
  if (typeof AudioEncoder === 'undefined') return null
  const base = { numberOfChannels: 2, sampleRate: 48000, bitrate: 192_000 }
  for (const c of [{ mux: 'aac' as const, codec: 'mp4a.40.2' }, { mux: 'opus' as const, codec: 'opus' }]) {
    try {
      const { supported } = await AudioEncoder.isConfigSupported({ codec: c.codec, ...base })
      if (supported) return c
    } catch { /* try next */ }
  }
  return null
}

/** offline-mix all unmuted stems to a stereo 48k buffer for the export range */
async function mixMaster(start: number, end: number): Promise<AudioBuffer | null> {
  const length = Math.ceil((end - start) * 48000)
  if (length <= 0) return null
  const ctx = new OfflineAudioContext(2, length, 48000)
  const master = ctx.createGain()
  master.gain.value = 0.9
  master.connect(ctx.destination)
  let any = false
  for (const track of project.tracks) {
    if (!track.audio || !project.isAudible(track)) continue
    if (start >= track.audio.buffer.duration) continue
    const src = ctx.createBufferSource()
    src.buffer = track.audio.buffer
    src.connect(master)
    src.start(0, start)
    any = true
  }
  if (!any) return null
  return ctx.startRendering()
}

const yieldTask = () => new Promise<void>((r) => setTimeout(r, 0))

export async function exportVideo(
  stage: Stage,
  engine: MappingEngine,
  opts: ExportOptions,
): Promise<ExportResult | null> {
  const { start, end, fps, bitrate } = opts
  const total = Math.max(1, Math.round((end - start) * fps))

  const videoCodec = await pickVideoCodec(fps, bitrate)
  const audio = await mixMaster(start, end)
  const audioCodec = audio ? await pickAudioCodec() : null

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: STAGE_W, height: STAGE_H, frameRate: fps },
    audio: audioCodec
      ? { codec: audioCodec.mux, numberOfChannels: 2, sampleRate: 48000 }
      : undefined,
    fastStart: 'in-memory',
  })

  let encoderError: Error | null = null
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e },
  })
  videoEncoder.configure({
    codec: videoCodec, width: STAGE_W, height: STAGE_H, bitrate, framerate: fps,
  })

  // audio first — it's fast, and mp4-muxer interleaves per-track internally
  if (audio && audioCodec) {
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { encoderError = e },
    })
    audioEncoder.configure({
      codec: audioCodec.codec, numberOfChannels: 2, sampleRate: 48000, bitrate: 192_000,
    })
    const chunkFrames = 48000
    for (let pos = 0; pos < audio.length; pos += chunkFrames) {
      const frames = Math.min(chunkFrames, audio.length - pos)
      const data = new Float32Array(frames * 2)
      data.set(audio.getChannelData(0).subarray(pos, pos + frames), 0)
      data.set(audio.getChannelData(1).subarray(pos, pos + frames), frames)
      audioEncoder.encode(new AudioData({
        format: 'f32-planar',
        sampleRate: 48000,
        numberOfFrames: frames,
        numberOfChannels: 2,
        timestamp: Math.round((pos / 48000) * 1e6),
        data,
      }))
    }
    await audioEncoder.flush()
    audioEncoder.close()
  }

  stage.resetTemporal()
  engine.update(project)
  const evaluate = (t: number) => engine.evaluate(t, project)

  for (let i = 0; i < total; i++) {
    if (opts.isCancelled()) { videoEncoder.close(); return null }
    if (encoderError) throw encoderError
    stage.render(start + i / fps, evaluate, project)
    const frame = new VideoFrame(stage.canvas, {
      timestamp: Math.round((i * 1e6) / fps),
      duration: Math.round(1e6 / fps),
    })
    videoEncoder.encode(frame, { keyFrame: i % (fps * 2) === 0 })
    frame.close()
    while (videoEncoder.encodeQueueSize > 4) await yieldTask()
    if (i % 4 === 0) { opts.onProgress(i, total); await yieldTask() }
  }
  await videoEncoder.flush()
  videoEncoder.close()
  if (encoderError) throw encoderError
  opts.onProgress(total, total)

  muxer.finalize()
  const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' })
  const note = !audio
    ? 'No audio tracks loaded — exported video only.'
    : !audioCodec
      ? 'This browser has no AAC/Opus encoder — exported video only. Mux audio with:\n' +
        'ffmpeg -i export.mp4 -i yoursong.wav -c:v copy -c:a aac -shortest out.mp4'
      : audioCodec.mux === 'opus'
        ? 'Audio encoded as Opus-in-MP4 (plays in mpv/VLC/ffmpeg; re-encode to AAC for max compatibility).'
        : null
  return { blob, audioIncluded: !!(audio && audioCodec), note }
}
