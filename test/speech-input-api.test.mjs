import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createClient, setupAdmin, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

// Голосовой ввод через HTTP (`server/index.mjs:3960–3969`, `server/speech-input.mjs`):
// статус и распознавание только для вошедших, сырое тело WAV проверяется до
// распознавания, окно попыток — общее со входом (двадцать за десять минут с адреса).

const MAX_AUDIO = 44 + 16000 * 2 * 60

/** WAV PCM: один канал, 16 кГц, 16 бит, `samples` нулевых отсчётов. */
function wav(samples) {
  const data = samples * 2
  const audio = Buffer.alloc(44 + data)
  audio.write('RIFF', 0, 'ascii')
  audio.writeUInt32LE(36 + data, 4)
  audio.write('WAVEfmt ', 8, 'ascii')
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(16000, 24)
  audio.writeUInt32LE(32000, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36, 'ascii')
  audio.writeUInt32LE(data, 40)
  return audio
}

/**
 * @param {ReturnType<typeof createClient>} client
 * @param {Buffer} body
 */
async function transcribe(client, body) {
  const response = await client.fetch('/api/speech/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body })
  return { status: response.status, body: await response.json() }
}

test('голосовой ввод: права, форма записи, отказ без распознавателя и окно попыток', { timeout: runnerTimeout(30_000) }, async (t) => {
  const tools = mkdtempSync(join(tmpdir(), 'skazanie-speech-tools-'))
  t.after(() => rmSync(tools, { recursive: true, force: true }))
  const server = await startTestServer(t, {
    storagePrefix: 'skazanie-speech-api-',
    env: { DND_WHISPER_EXECUTABLE: undefined, DND_WHISPER_MODEL: undefined },
  })
  const anonymous = createClient(server)
  const denied = await anonymous.get('/api/speech/status')
  assert.equal(denied.status, 401)
  assert.deepEqual(denied.body, { error: 'Нужно войти в аккаунт' })
  assert.deepEqual(await transcribe(anonymous, wav(16)), { status: 401, body: { error: 'Нужно войти в аккаунт' } })

  const { client } = await setupAdmin(server) // первая попытка окна
  const status = await client.get('/api/speech/status')
  assert.equal(status.status, 200)
  assert.deepEqual(status.body, { available: false, maxSeconds: 60 })
  // Оба маршрута сравнивают сырой адрес: строка запроса — уже другой путь.
  assert.equal((await client.get('/api/speech/status?x=1')).status, 404)
  assert.deepEqual((await client.get('/api/speech/transcribe')).body, { error: 'API endpoint не найден' })

  const malformed = { status: 400, body: { error: 'Нужна запись WAV: один канал, 16 кГц, до 60 секунд.' } }
  assert.deepEqual(await transcribe(client, Buffer.from('не запись')), malformed)
  const stereo = wav(16)
  stereo.writeUInt16LE(2, 22)
  assert.deepEqual(await transcribe(client, stereo), malformed)
  assert.deepEqual(await transcribe(client, Buffer.alloc(MAX_AUDIO + 1)), { status: 400, body: { error: 'Запись превышает 60 секунд.' } })
  assert.deepEqual(await transcribe(client, wav(16000)), { status: 503, body: { error: 'Локальное распознавание ещё не настроено на сервере.' } })

  // Программа и модель на месте, но программа не запускается: сбой распознавания — 502.
  const executable = join(tools, 'whisper.txt')
  const model = join(tools, 'model.bin')
  writeFileSync(executable, 'не программа')
  writeFileSync(model, 'не модель')
  await server.restart({ env: { DND_WHISPER_EXECUTABLE: executable, DND_WHISPER_MODEL: model } })
  assert.deepEqual((await client.get('/api/speech/status')).body, { available: true, maxSeconds: 60 })
  // После перезапуска окно попыток пустое: это первая.
  assert.deepEqual(await transcribe(client, wav(1600)), { status: 502, body: { error: 'Не удалось распознать запись. Попробуйте более короткую фразу.' } })
  for (let attempt = 2; attempt <= 20; attempt += 1) {
    assert.deepEqual(await transcribe(client, Buffer.from('x')), malformed, `попытка ${attempt}`)
  }
  assert.deepEqual(await transcribe(client, wav(16)), { status: 429, body: { error: 'Слишком много запросов. Попробуйте позже.' } })
  // Статус окном попыток не ограничен.
  assert.equal((await client.get('/api/speech/status')).status, 200)
})
