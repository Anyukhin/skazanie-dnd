/** Кодирует моно PCM в WAV 16 кГц для локального распознавания. */
export function encodeSpeechWav(chunks, sampleRate) {
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || count === 0) throw new Error('Запись пуста.')
  const source = new Float32Array(count)
  let offset = 0
  for (const chunk of chunks) { source.set(chunk, offset); offset += chunk.length }
  const length = Math.min(16000 * 60, Math.floor(count * 16000 / sampleRate))
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const word = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)) }
  word(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); word(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  word(36, 'data'); view.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i++) {
    const position = i * sampleRate / 16000
    const left = Math.floor(position)
    const a = Number.isFinite(source[left]) ? source[left] : 0
    const next = source[Math.min(left + 1, count - 1)]
    const b = Number.isFinite(next) ? next : 0
    const sample = a + (b - a) * (position - left)
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0))
    view.setInt16(44 + i * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true)
  }
  return buffer
}
