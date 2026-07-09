/**
 * Bridge to the Electron shell (exposed by electron/preload.cjs).
 * `native` is null in a plain browser — every caller must handle both.
 */
export interface NativeFile {
  name: string
  path: string
  data: ArrayBuffer
}

export interface KymografNative {
  pathFor(file: File): string | null
  readFile(path: string): Promise<NativeFile>
  openFiles(): Promise<NativeFile[]>
  saveProject(json: string, suggested?: string): Promise<string | null>
  openProject(): Promise<{ path: string; json: string } | null>
  watchFiles(paths: string[]): Promise<void>
  onFileChanged(cb: (path: string) => void): void
  updateAvailable(): Promise<boolean>
  updateApp(): Promise<{ code: number; out: string }>
  relaunch(): Promise<void>
  saveVideoBegin(suggested?: string): Promise<string | null>
  saveVideoChunk(buf: ArrayBuffer): Promise<void>
  saveVideoEnd(): Promise<{ aac: boolean }>
  autosaveWrite(json: string): Promise<void>
  autosaveRead(): Promise<string | null>
  readDemoFile(name: string): Promise<NativeFile>
}

export const native: KymografNative | null =
  (window as unknown as { kymografNative?: KymografNative }).kymografNative ?? null
