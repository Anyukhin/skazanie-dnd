import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { encodeSpeechWav } from '../src/speech-wav.mjs'
import { validateSpeechWav, readSpeechWav } from '../server/speech-input.mjs'

test('голосовой ввод: PCM разных частот превращается в ограниченный WAV 16 кГц', () => {
  for (const rate of [16000, 44100, 48000]) {
    const samples = new Float32Array(rate).fill(0.5)
    const wav = Buffer.from(encodeSpeechWav([samples.subarray(0, 1000), samples.subarray(1000)], rate))
    assert.equal(validateSpeechWav(wav), wav)
    assert.equal(wav.length, 32044)
    assert.equal(wav.readInt16LE(44), 16384)
  }
})
test('голосовой ввод: пустая запись отклоняется, длительность ограничена минутой', () => {
  assert.throws(() => encodeSpeechWav([], 16000), /пуста/)
  const wav = Buffer.from(encodeSpeechWav([new Float32Array(16000 * 61)], 16000))
  assert.equal(wav.length, 44 + 32000 * 60)
  validateSpeechWav(wav)
})
test('голосовой ввод: выход за диапазон PCM не переполняет сигнал', () => {
  const wav = Buffer.from(encodeSpeechWav([new Float32Array([-2, 2, NaN])], 16000))
  assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)], [-32768, 32767, 0])
})
test('сервер отклоняет повреждённые и слишком большие записи до запуска Whisper', async () => {
  const wav = Buffer.from(encodeSpeechWav([new Float32Array(160)], 16000))
  for (const offset of [0, 4, 8, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
    const bad = Buffer.from(wav); bad[offset] ^= 1
    assert.throws(() => validateSpeechWav(bad))
  }
  assert.throws(() => validateSpeechWav(Buffer.alloc(10)))
  assert.equal((await readSpeechWav(Readable.from([wav.subarray(0, 20), wav.subarray(20)]))).length, wav.length)
  await assert.rejects(readSpeechWav(Readable.from([Buffer.alloc(2000000)])), /60 секунд/)
})
