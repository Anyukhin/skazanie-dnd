import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const MAX_AUDIO = 44 + 16000 * 2 * 60
let busy = false
function configuration() {
  return { executable: process.env.DND_WHISPER_EXECUTABLE, model: process.env.DND_WHISPER_MODEL }
}
export async function speechInputAvailable() {
  const { executable, model } = configuration()
  if (!executable || !model) return false
  try { await Promise.all([access(executable), access(model)]); return true } catch { return false }
}
export function validateSpeechWav(audio) {
  if (!Buffer.isBuffer(audio) || audio.length < 46 || audio.length > MAX_AUDIO
    || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.readUInt32LE(4) !== audio.length - 8
    || audio.toString('ascii', 8, 16) !== 'WAVEfmt ' || audio.readUInt32LE(16) !== 16
    || audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1
    || audio.readUInt32LE(24) !== 16000 || audio.readUInt32LE(28) !== 32000
    || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16
    || audio.toString('ascii', 36, 40) !== 'data' || audio.readUInt32LE(40) !== audio.length - 44
    || (audio.length - 44) % 2 !== 0) throw new Error('Нужна запись WAV: один канал, 16 кГц, до 60 секунд.')
  return audio
}
export async function readSpeechWav(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_AUDIO) throw new Error('Запись превышает 60 секунд.')
    chunks.push(chunk)
  }
  return validateSpeechWav(Buffer.concat(chunks))
}
export async function transcribeSpeech(audio) {
  validateSpeechWav(audio)
  if (busy) throw Object.assign(new Error('Сервис занят, повторите через несколько секунд.'), { status: 429 })
  if (!await speechInputAvailable()) throw Object.assign(new Error('Локальное распознавание ещё не настроено на сервере.'), { status: 503 })
  // Проверяем повторно после асинхронной проверки файлов: второй запрос не должен обойти блокировку.
  if (busy) throw Object.assign(new Error('Сервис занят, повторите через несколько секунд.'), { status: 429 })
  busy = true
  let directory
  try {
    directory = await mkdtemp(join(tmpdir(), 'skazanie-speech-'))
    const input = join(directory, 'recording.wav')
    const output = join(directory, 'transcript')
    await writeFile(input, audio)
    const { executable, model } = configuration()
    await run(executable, ['-m', model, '-f', input, '-l', 'ru', '-otxt', '-of', output, '-nt', '-np', '-t', '4'], { windowsHide: true, timeout: 120000, maxBuffer: 1000000 })
    const text = (await readFile(output + '.txt', 'utf8')).trim().replace(/\s+/gu, ' ').slice(0, 12000)
    return text
  } catch (error) {
    if (error.status) throw error
    throw Object.assign(new Error('Не удалось распознать запись. Попробуйте более короткую фразу.'), { status: 502 })
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }) } finally { busy = false }
  }
}
