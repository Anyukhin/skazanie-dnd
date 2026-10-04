import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  chronicleFollowAfterScroll,
  chronicleMatchesFilter,
  chronicleMessageText,
  isChronicleNearBottom,
} from '../src/chat-chronicle.mjs'

test('хроника показывает маршрут без служебных меток и сохраняет обычную речь', () => {
  const route = 'Отряд предлагает отправиться из «Штормберг» в «Миттлайд».'
  assert.equal(chronicleMessageText(`[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id=astohan-mittlayd] ${route}`), route)
  assert.equal(chronicleMessageText('[РЕШЕНИЕ ГРУППЫ] Идём к озеру'), 'Идём к озеру')
  assert.equal(chronicleMessageText('Говорю: [улыбаюсь] идём к озеру'), 'Говорю: [улыбаюсь] идём к озеру')
  assert.equal(chronicleMessageText('[ДНЕВНИК] Мои заметки'), '[ДНЕВНИК] Мои заметки')
})

test('desktop chronicle filters the existing speaker contract without losing player narration', () => {
  assert.equal(chronicleMatchesFilter('narrator', 'story'), true)
  assert.equal(chronicleMatchesFilter('player', 'story'), true)
  assert.equal(chronicleMatchesFilter('system', 'story'), false)
  assert.equal(chronicleMatchesFilter('system', 'combat'), true)
  assert.equal(chronicleMatchesFilter('narrator', 'combat'), false)
  assert.equal(chronicleMatchesFilter('player', 'combat'), false)
  assert.equal(chronicleMatchesFilter('system', 'all'), true)
})

/**
 * Врезка «Пока вас не было…» приходит системной записью, но читается как
 * рассказ. Без третьего признака она пряталась бы под фильтром «Рассказ» и
 * всплывала под «Боем» — ровно наоборот тому, чем она является.
 */
test('системная врезка хода мира читается как рассказ, а не как боевая запись', () => {
  assert.equal(chronicleMatchesFilter('system', 'story', true), true)
  assert.equal(chronicleMatchesFilter('system', 'combat', true), false)
  assert.equal(chronicleMatchesFilter('system', 'all', true), true)
  // Обычная системная запись признака не получает и остаётся боевой.
  assert.equal(chronicleMatchesFilter('system', 'combat', false), true)
})

test('desktop chronicle follows new events only while the reader remains at the bottom', () => {
  assert.equal(isChronicleNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }), true)
  assert.equal(isChronicleNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 550 }), true)
  assert.equal(isChronicleNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 500 }), false)
})

test('плавная прокрутка к новой записи не выключает слежение за лентой', () => {
  // Живой прогон 2026-10-02: smooth scrollIntoView шлёт scroll на полпути, и
  // проверка «у низа ли мы» выключала слежение — ответы копились под «↓ N».
  const midway = { scrollHeight: 1400, clientHeight: 560, scrollTop: 500 }
  assert.equal(chronicleFollowAfterScroll(midway, 300, true), true, 'движение вниз слежение не снимает')
  assert.equal(chronicleFollowAfterScroll(midway, 700, true), false, 'игрок прокрутил вверх — лента его не дёргает')
  assert.equal(chronicleFollowAfterScroll(midway, 500, false), false, 'стоящая лента не включает слежение сама')
  assert.equal(chronicleFollowAfterScroll({ scrollHeight: 1400, clientHeight: 560, scrollTop: 840 }, 900, false), true, 'возврат к низу снова включает слежение')
})

test('the combat context does not render a second copy of the latest chronicle event', async () => {
  const appSource = (await Promise.all(['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
  .map((path) => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n')
  assert.doesNotMatch(appSource, /<BattleResultCard\b/)
  assert.doesNotMatch(appSource, /ПОСЛЕДНИЙ РЕЗУЛЬТАТ/)
})
