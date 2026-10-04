import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { validateSpeechWav } from '../../../../server/speech-input.mjs'

// Исполняется настоящий скомпилированный модуль, но все устройства подставные.
// Ни getUserMedia браузера, ни реальный микрофон, ни Whisper не вызываются.
const directory = mkdtempSync(join(tmpdir(), 'skazanie-speech-review-'))
const names = ['navigator', 'AudioContext', 'AudioWorkletNode']
const original = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))

try {
  const compiler = fileURLToPath(new URL('../../../../node_modules/typescript/bin/tsc', import.meta.url))
  const source = fileURLToPath(new URL('../../../../src/speech-recording.ts', import.meta.url))
  const compilation = spawnSync(process.execPath, [
    compiler, '--ignoreConfig', '--target', 'ES2022', '--module', 'ESNext',
    '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM', '--strict',
    '--skipLibCheck', '--outDir', directory, source,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(compilation.status, 0, compilation.stderr || compilation.stdout)
  writeFileSync(join(directory, 'speech-recording.mjs'), readFileSync(join(directory, 'speech-recording.js')))
  copyFileSync(fileURLToPath(new URL('../../../../src/speech-wav.mjs', import.meta.url)), join(directory, 'speech-wav.mjs'))
  const { startSpeechRecording } = await import(pathToFileURL(join(directory, 'speech-recording.mjs')).href)

  function environment(failure) {
    const calls = { acquired: 0, tracks_stopped: 0, contexts_closed: 0, nodes_disconnected: 0 }
    let worklet = null
    const stream = { getTracks: () => [{ stop: () => { calls.tracks_stopped += 1 } }] }
    const navigator = {
      mediaDevices: { getUserMedia: async () => { calls.acquired += 1; return stream } },
    }
    class AudioContext {
      sampleRate = 16000
      destination = {}
      audioWorklet = {
        addModule: async () => { if (failure === 'module') throw new Error('Проба: модуль не загрузился') },
      }
      constructor() {
        if (failure === 'context') throw new Error('Проба: AudioContext не создался')
      }
      createGain() { return { gain: { value: 1 }, connect() { return this } } }
      createMediaStreamSource() { return { connect(node) { return node } } }
      async resume() { if (failure === 'resume') throw new Error('Проба: контекст не запустился') }
      async close() { calls.contexts_closed += 1 }
    }
    class AudioWorkletNode {
      port = { onmessage: null }
      constructor() { worklet = this }
      disconnect() { calls.nodes_disconnected += 1 }
      connect(target) { return target }
    }
    for (const [name, value] of Object.entries({ navigator, AudioContext, AudioWorkletNode })) {
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
    }
    return { calls, samples: () => worklet.port.onmessage({ data: new Float32Array(160).fill(0.25) }) }
  }

  const results = {}
  for (const failure of ['context', 'module', 'resume']) {
    const fixture = environment(failure)
    await assert.rejects(startSpeechRecording(), /Проба:/)
    assert.equal(fixture.calls.acquired, 1)
    assert.equal(fixture.calls.tracks_stopped, failure === 'context' ? 0 : 1)
    assert.equal(fixture.calls.contexts_closed, failure === 'context' ? 0 : 1)
    results[failure] = fixture.calls
  }

  const success = environment(null)
  const capture = await startSpeechRecording()
  success.samples()
  const wav = Buffer.from(await capture.finish().arrayBuffer())
  validateSpeechWav(wav)
  capture.cancel()
  capture.cancel()
  assert.deepEqual(success.calls, { acquired: 1, tracks_stopped: 1, contexts_closed: 1, nodes_disconnected: 1 })
  results.finish_and_repeat_cancel = { ...success.calls, wav_bytes: wav.length }

  console.log(JSON.stringify({ scope: 'compiled-client-with-fake-browser-resources', results }, null, 2))
} finally {
  for (const name of names) {
    const descriptor = original.get(name)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
  rmSync(directory, { recursive: true, force: true })
}
