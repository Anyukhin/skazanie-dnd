import { narrationSpeechChunks, pickNarrationVoice, type NarrationVoiceMode } from './narration-tts.mjs'

/**
 * Браузерная часть озвучки: всё, что трогает `speechSynthesis`.
 *
 * Чистая логика — подготовка текста и выбор голоса — живёт в
 * `narration-tts.mjs` и покрыта `node:test`. Здесь остаётся ровно то, что без
 * браузера проверить нечем: очередь реплик, отмена и подписка на список
 * голосов, который в Chrome приезжает асинхронно.
 */

export type { NarrationVoiceMode }

function synthesis(): SpeechSynthesis | null {
  return typeof window === 'undefined' || !('speechSynthesis' in window) ? null : window.speechSynthesis
}

/** Есть ли в системе русский голос. Без него озвучка не предлагается вовсе. */
export function russianVoiceAvailable(voices: SpeechSynthesisVoice[]): boolean {
  return pickNarrationVoice(voices) != null
}

/**
 * Список голосов приезжает асинхронно: в Chrome первый `getVoices()` почти
 * всегда пуст, и список наполняется событием. Подписка возвращает функцию
 * отписки — без неё слушатель пережил бы размонтирование.
 */
export function observeVoices(onVoices: (voices: SpeechSynthesisVoice[]) => void): () => void {
  const speech = synthesis()
  if (!speech) {
    onVoices([])
    return () => {}
  }
  const publish = () => onVoices(speech.getVoices())
  publish()
  speech.addEventListener('voiceschanged', publish)
  return () => speech.removeEventListener('voiceschanged', publish)
}

/** Прервать всё, что сейчас произносится. Идемпотентно и безопасно без браузера. */
export function cancelNarration(): void {
  synthesis()?.cancel()
}

/**
 * Произнести текст. Новая реплика всегда отменяет предыдущую: рассказчик уже
 * сменил сцену, и договаривать прошлую — значит отставать от стола.
 *
 * Длинный текст уходит очередью коротких кусков: браузеры обрывают слишком
 * длинные реплики на середине.
 */
export function speakNarration(text: string, voice: SpeechSynthesisVoice | null): void {
  const speech = synthesis()
  if (!speech) return
  const chunks = narrationSpeechChunks(text)
  speech.cancel()
  if (!chunks.length) return
  for (const chunk of chunks) {
    const utterance = new SpeechSynthesisUtterance(chunk)
    if (voice) {
      utterance.voice = voice
      utterance.lang = voice.lang
    } else utterance.lang = 'ru-RU'
    speech.speak(utterance)
  }
}
