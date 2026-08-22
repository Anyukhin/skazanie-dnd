// Что стол и ведущий действительно видят от хода мира.
//
// Контракт здесь двойной. Данные: карточка ничего не досчитывает, поэтому
// пустая или неподписанная лента падает на проекции, а не «просто выглядит
// иначе». Разметка: врезка «Пока вас не было…» обязана быть отдельной
// карточкой в летописи, а не приглушённой служебной строкой — иначе главное
// событие ночи прочитают как отказ движка.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  OFFSCREEN_CARD_TITLE,
  OFFSCREEN_CARD_TITLE_PREFIX,
  OFFSCREEN_ENTRY_LABELS,
  OFFSCREEN_WORLD_EVENT_TYPE,
  offscreenChronicleEntry,
} from '../server/offscreen-world.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { worldClockFor } from '../server/weather.mjs'

const views = readFileSync(new URL('../src/AppViews.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const server = readFileSync(new URL('../server/index.mjs', import.meta.url), 'utf8')

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'OFFSCREEN-UI',
    campaign: 'Ход мира',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [] }],
    scene: { title: 'Двор', location: 'Тихий Брод', location_id: 'village', cells: [] },
    social: { npcs: [{ id: 'miller', name: 'Мельник Гость', role: 'мельник', location: 'Мельница', visibility: 'party', public_summary: 'Мелет зерно.' }] },
    worldMemory: {
      entities: [{ id: 'faction-wolves', kind: 'faction', name: 'Волчья ватага', summary: 'Ватага на трактах.', visibility: 'party', tags: [] }],
      quests: [{ id: 'quest-caravan', title: 'Караван у брода', summary: 'Караван ждёт помощи.', status: 'active', visibility: 'party', clock: { current: 0, max: 5, label: 'Караван ждёт' } }],
    },
    autonomy: { reputations: { 'faction-wolves': -25 } },
    mechanics: { world_time: { elapsed_minutes: 0 } },
  })
}

function nightPassed() {
  const state = campaign()
  const resolved = resolveCommand(
    { command_type: 'AdvanceTime', amount: 720, unit: 'minute', server_authoritative: true },
    state,
    { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { isAdmin: true } },
  )
  return { events: resolved.events, state: resolved.events.reduce((next, event) => applyGameEvent(next, event), state) }
}

test('у каждого вида записи есть русская подпись в серверном каталоге', () => {
  for (const [kind, label] of Object.entries(OFFSCREEN_ENTRY_LABELS)) {
    assert.match(label, /^[А-ЯЁ][а-яё ]+$/u, `вид записи ${kind} остался без русской подписи`)
  }
})

test('лента ходов мира приходит готовой и одинаковой столу и ведущему', () => {
  const { state } = nightPassed()
  const admin = campaignStateForViewer(state, { id: 'user-gm', role: 'admin', heroIds: [] }, '')
  const player = campaignStateForViewer(state, { id: 'user-1', role: 'player', heroIds: ['hero'] }, 'hero')

  assert.equal(admin.offscreen_world.steps.length, 1)
  assert.deepEqual(
    admin.offscreen_world.steps.map((step) => step.id),
    player.offscreen_world.steps.map((step) => step.id),
  )
  const [step] = admin.offscreen_world.steps
  assert.ok(step.day >= 1)
  assert.ok(step.lines.length >= 1 && step.lines.length <= 3)
  for (const entry of step.entries) {
    assert.equal(entry.label, OFFSCREEN_ENTRY_LABELS[entry.kind], 'подпись вида обязана приходить с сервера')
  }
  // Ход мира не заводит ни существ, ни встреч: у стола после ночи те же фигуры.
  assert.deepEqual(player.enemies ?? [], [])
})

test('карточка летописи собирается на сервере вместе со строками и днём', () => {
  const { events } = nightPassed()
  const entry = offscreenChronicleEntry(events.find((event) => event.event_type === OFFSCREEN_WORLD_EVENT_TYPE))
  assert.ok(entry.id.startsWith('chronicle:'), 'идентификатор записи обязан быть детерминированным')
  assert.ok(entry.author.startsWith(OFFSCREEN_CARD_TITLE_PREFIX))
  // Стол читает не `author`, а `card.title`: именно он стоит в `<strong>`
  // врезки (`OffscreenChronicleEntry`, `src/AppViews.tsx`). Заголовок в
  // карточке и в сводке памяти мира — одна и та же строка.
  assert.equal(entry.offscreen.title, OFFSCREEN_CARD_TITLE)
  assert.equal(entry.offscreen.elapsed_minutes, 720)
  // День в карточке считается тем же счётом, что «День N» в подсказке погоды:
  // две разные цифры в одном интерфейсе расходились бы у игрока на глазах.
  assert.equal(entry.offscreen.day, worldClockFor({ mechanics: { world_time: { elapsed_minutes: 720 } } }).day)
  assert.ok(entry.offscreen.lines.length >= 1 && entry.offscreen.lines.length <= 3)
  assert.equal(entry.text, entry.offscreen.lines.join(' '))
  // Событие, не относящееся к ходу мира, карточки не рождает.
  assert.equal(offscreenChronicleEntry({ event_type: 'TimeAdvanced', payload: {} }), null)
})

test('врезка в летописи — отдельная карточка, а не приглушённая служебная строка', () => {
  assert.match(views, /message\.offscreen \? \(/u)
  assert.match(views, /<OffscreenChronicleEntry key=\{message\.id\}/u)
  assert.match(views, /Ход мира · день \{card\.day\}/u)
  // Фильтр «Рассказ» врезку показывает, «Бой» — нет. Признак «это рассказ»
  // с тех пор делят все системные карточки летописи (к ходу мира добавился
  // конверт почты), поэтому сторож держит именно участие врезки в признаке, а
  // не полный список его слагаемых: иначе каждая новая карточка ломала бы
  // чужой тест, ничего не сломав по существу.
  assert.match(views, /chronicleMatchesFilter\(message\.speaker, filter, Boolean\(message\.offscreen/u)
  assert.match(styles, /\.message\.system\.offscreen-step \{ margin-bottom: 14px; opacity: 1; \}/u)
  assert.match(styles, /\.offscreen-card \{/u)
  assert.match(styles, /\.offscreen-card li \{/u)
})

test('лента ходов мира живёт в админке рядом с розыском и подписана по-русски', () => {
  assert.match(views, /<OffscreenWorldCard state=\{state\} \/>/u)
  assert.match(views, /admin-card admin-offscreen/u)
  assert.match(views, /Пока вас не было/u)
  assert.match(styles, /\.offscreen-feed article \{/u)
  assert.match(styles, /\.offscreen-feed li\.lost \{/u)
  assert.match(styles, /\.offscreen-feed li \{ grid-template-columns: 1fr; \}/u)
  // Подписи и порядок — серверные: своей таблицы у карточки быть не должно.
  assert.doesNotMatch(views, /OFFSCREEN_ENTRY_LABELS/u)
  assert.doesNotMatch(views, /offscreen_world\?\.steps[^\n]*\.sort\(/u)
})

test('карточка летописи переживает перезагрузку комнаты', () => {
  // Врезка хранится вместе с репликой, как бросок и ставки: иначе после
  // перезагрузки от ночи остался бы серый текст без карточки.
  assert.match(server, /function journalOffscreen\(offscreen\)/u)
  assert.match(server, /\.\.\.\(storedOffscreen \? \{ offscreen: storedOffscreen \} : \{\}\)/u)
  // Собирается она в одной точке коммита, а не на каждом маршруте: минуты
  // двигают и привал, и сутки под замком, и Режиссёр.
  assert.match(server, /events.*\.map\(offscreenChronicleEntry\)/u)
})
