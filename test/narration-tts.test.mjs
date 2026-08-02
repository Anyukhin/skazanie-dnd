// Озвучка нарратива: чистая часть.
//
// Браузерных тестов в проекте нет, поэтому вся логика, которую вообще можно
// проверить без DOM, вынесена в `src/narration-tts.mjs` — подготовка текста и
// выбор голоса. Здесь она и проверяется; всё, что трогает `speechSynthesis`,
// осталось в `narration-tts.ts` и держится на tsc и ручном прогоне.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NARRATION_VOICE_MODES,
  narrationSpeechChunks,
  normalizeVoiceMode,
  pickNarrationVoice,
  shouldAutoSpeak,
  speakableNarration,
} from '../src/narration-tts.mjs'

const voice = (name, lang, extra = {}) => ({ name, lang, ...extra })

test('текст для озвучки очищается от разметки и служебных строк', () => {
  assert.equal(speakableNarration('**Тьма** сгущается'), 'Тьма сгущается')
  assert.equal(speakableNarration('## Заголовок\nВорота скрипят'), 'Заголовок Ворота скрипят')
  assert.equal(speakableNarration('Ворота скрипят\nХод передан следующему герою'), 'Ворота скрипят')
  assert.equal(speakableNarration('Ворота скрипят\nd20: 14 + 3'), 'Ворота скрипят')
  assert.equal(speakableNarration('Ворота   скрипят\n\n  и   стонут '), 'Ворота скрипят и стонут')

  // Нечего произносить — пустая строка, а не тишина вслух.
  assert.equal(speakableNarration(''), '')
  assert.equal(speakableNarration(null), '')
  assert.equal(speakableNarration('***'), '')
  assert.equal(speakableNarration('Ход передан следующему герою'), '')

  // Длина ограничена, чтобы одна реплика не заняла вечер.
  assert.equal(speakableNarration('а'.repeat(9_000)).length, 4_000)
})

test('длинный текст режется по предложениям, а слишком длинное предложение — по пробелу', () => {
  assert.deepEqual(narrationSpeechChunks(''), [])
  assert.deepEqual(narrationSpeechChunks('Ворота скрипят.'), ['Ворота скрипят.'])

  // Короткие предложения склеиваются, пока помещаются в предел.
  assert.deepEqual(narrationSpeechChunks('Раз. Два. Три.', 40), ['Раз. Два. Три.'])

  const many = narrationSpeechChunks('Первое предложение тянется. Второе предложение тянется. Третье предложение тянется.', 40)
  assert.ok(many.length >= 2, 'длинный текст обязан разбиться')
  assert.ok(many.every((chunk) => chunk.length <= 40), 'каждый кусок укладывается в предел')
  assert.equal(many.join(' '), 'Первое предложение тянется. Второе предложение тянется. Третье предложение тянется.')

  // Предложение длиннее предела рвётся по пробелу, а не посреди слова.
  const long = narrationSpeechChunks(`${'слово '.repeat(30)}конец.`, 50)
  assert.ok(long.every((chunk) => chunk.length <= 50))
  assert.ok(long.every((chunk) => !chunk.startsWith(' ') && !chunk.endsWith(' ')))
  assert.equal(long.join(' ').replace(/\s+/gu, ' '), `${'слово '.repeat(30)}конец.`.replace(/\s+/gu, ' '))
})

test('выбор голоса предпочитает ru-RU, локальный и стабилен при равенстве', () => {
  // Русского голоса нет — фича обязана честно молчать.
  assert.equal(pickNarrationVoice([]), null)
  assert.equal(pickNarrationVoice([voice('Daniel', 'en-GB'), voice('Alice', 'it-IT')]), null)

  // Точный ru-RU важнее любого другого русского.
  assert.equal(pickNarrationVoice([voice('Ru Other', 'ru'), voice('Milena', 'ru-RU')]).name, 'Milena')
  // Подчёркивание в теге языка — тоже русский.
  assert.equal(pickNarrationVoice([voice('Yuri', 'ru_RU')]).name, 'Yuri')

  // Локальный голос важнее облачного: он не зависит от сети.
  assert.equal(pickNarrationVoice([
    voice('Cloud', 'ru-RU', { localService: false }),
    voice('Local', 'ru-RU', { localService: true }),
  ]).name, 'Local')

  // При полном равенстве решает имя, иначе список менялся бы от запуска.
  const equal = [voice('Борис', 'ru-RU'), voice('Алла', 'ru-RU')]
  assert.equal(pickNarrationVoice(equal).name, 'Алла')
  assert.equal(pickNarrationVoice([...equal].reverse()).name, 'Алла')

  // Выбор игрока уважается, пока такой голос есть в системе.
  assert.equal(pickNarrationVoice(equal, 'Борис').name, 'Борис')
  assert.equal(pickNarrationVoice(equal, 'Кого-то нет').name, 'Алла')
})

test('режим озвучки не принимает выдуманных значений', () => {
  assert.deepEqual([...NARRATION_VOICE_MODES], ['off', 'button', 'auto'])
  for (const mode of NARRATION_VOICE_MODES) assert.equal(normalizeVoiceMode(mode), mode)
  for (const junk of ['', null, undefined, 'on', 'AUTO', 42, {}]) assert.equal(normalizeVoiceMode(junk), 'off')
})

test('автоозвучка читает только завершённый текст рассказчика', () => {
  const narration = { speaker: 'narrator', text: 'Ворота скрипят.' }
  assert.equal(shouldAutoSpeak(narration, 'auto'), true)
  assert.equal(shouldAutoSpeak(narration, 'button'), false, 'в режиме кнопки сама ничего не читает')
  assert.equal(shouldAutoSpeak(narration, 'off'), false)

  // Стриминговый кусок не озвучивается: голос заикался бы на каждом токене.
  assert.equal(shouldAutoSpeak({ ...narration, streaming: true }, 'auto'), false)
  // Чужие реплики за столом звучат живыми голосами.
  assert.equal(shouldAutoSpeak({ speaker: 'player', text: 'Иду вперёд.' }, 'auto'), false)
  assert.equal(shouldAutoSpeak({ speaker: 'system', text: 'Бой начался.' }, 'auto'), false)
  // Произносить нечего — молчим.
  assert.equal(shouldAutoSpeak({ speaker: 'narrator', text: 'Ход передан следующему герою' }, 'auto'), false)
})
