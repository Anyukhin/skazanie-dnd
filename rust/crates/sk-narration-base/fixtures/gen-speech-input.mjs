// Эталон для `speech_input.rs`: какие записи `validateSpeechWav` принимает.
//
//   node rust/crates/sk-narration-base/fixtures/gen-speech-input.mjs
//
// Запись хранится заголовком (hex) и длиной; остаток — байт `fill`. Порча —
// каждый байт заголовка с разными масками, длины на границах и чужие форматы.
import { writeFileSync } from 'node:fs'

import { encodeSpeechWav } from '../../../../src/speech-wav.mjs'
import { validateSpeechWav } from '../../../../server/speech-input.mjs'

const MAX_AUDIO = 44 + 16000 * 2 * 60
const cases = []

function record(label, buffer, fill = 0) {
  let valid = true
  let message = null
  try { validateSpeechWav(buffer) } catch (error) { valid = false; message = error.message }
  cases.push({ label, header: buffer.subarray(0, 44).toString('hex'), length: buffer.length, fill, valid, message })
}

/** Запись длиной `length` с заголовком `header` и заполнением `fill`. */
function build(header, length, fill = 0) {
  const buffer = Buffer.alloc(length, fill)
  header.copy(buffer, 0, 0, Math.min(header.length, length))
  return buffer
}

const base = Buffer.from(encodeSpeechWav([new Float32Array(160).fill(0)], 16000))
record('ровная запись', base)
for (const samples of [1, 2, 3, 1000, 16000]) record(`отсчётов ${samples}`, Buffer.from(encodeSpeechWav([new Float32Array(samples)], 16000)))
record('ровно минута', Buffer.from(encodeSpeechWav([new Float32Array(16000 * 61)], 16000)))
for (let offset = 0; offset < 44; offset += 1) {
  for (const mask of [0x01, 0x80, 0xff, 0x20]) {
    const bad = Buffer.from(base)
    bad[offset] ^= mask
    record(`байт ${offset} ^ ${mask}`, bad)
  }
}
for (const length of [0, 10, 43, 44, 45, 46, 47, 48]) {
  const header = Buffer.from(base)
  header.writeUInt32LE(Math.max(0, length - 8), 4)
  header.writeUInt32LE(Math.max(0, length - 44), 40)
  record(`длина ${length}`, build(header, length))
}
for (const length of [MAX_AUDIO - 2, MAX_AUDIO, MAX_AUDIO + 2, MAX_AUDIO + 1]) {
  const header = Buffer.from(base)
  header.writeUInt32LE(length - 8, 4)
  header.writeUInt32LE(length - 44, 40)
  record(`длина ${length}`, build(header, length))
}
{
  // Нечётная длина данных при согласованных полях.
  const header = Buffer.from(base)
  header.writeUInt32LE(47 - 8, 4)
  header.writeUInt32LE(3, 40)
  record('нечётные данные', build(header, 47))
}
for (const [label, rate, channels, bits] of [['44.1 кГц', 44100, 1, 16], ['стерео', 16000, 2, 16], ['8 бит', 16000, 1, 8]]) {
  const header = Buffer.from(base)
  header.writeUInt32LE(rate, 24)
  header.writeUInt16LE(channels, 22)
  header.writeUInt16LE(bits, 34)
  header.writeUInt32LE(rate * channels * bits / 8, 28)
  header.writeUInt16LE(channels * bits / 8, 32)
  record(label, header)
}
record('заполнение 0xff', build(base, base.length, 0xff), 0xff)

writeFileSync(new URL('./speech-input.json', import.meta.url), `[\n${cases.map((item) => JSON.stringify(item)).join(',\n')}\n]\n`)
console.log(`записей ${cases.length}, принято ${cases.filter((item) => item.valid).length}`)
