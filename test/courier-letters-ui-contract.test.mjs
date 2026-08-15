// Что стол и ведущий действительно видят от почты отряда.
//
// Контракт здесь тройной. Тайна: запечатанный ответ — черновик модели, тон
// адресата и провайдер — не принадлежит игроку до тех пор, пока письмо не
// пришло; иначе он прочёл бы ответ в тот же миг, когда отдал письмо курьеру.
// Данные: панель ничего не досчитывает — цена, срок и подпись состояния
// приезжают с сервера готовыми. Разметка: письмо в летописи обязано быть
// конвертом, а не приглушённой служебной строкой, и действие «написать письмо»
// обязано существовать кнопкой, а не только подсказкой.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { suggestedActionsFor } from '../server/action-hints.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  COURIER_LETTERS_POLICY_ID,
  COURIER_LETTER_BASE_FEE_CP,
  COURIER_LETTER_BODY_LIMIT,
  COURIER_LETTER_CARD_TITLE,
  COURIER_LETTER_EVENT_TYPES,
  COURIER_LETTER_OPEN_LIMIT,
  COURIER_LETTER_STATUS_LABELS,
  courierLetterChronicleEntry,
} from '../server/courier-letters.mjs'
import { applyGameEvent, eventSummary, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { PROJECTED_STATE_KEYS, campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const views = source('src/AppViews.tsx')
const board = source('src/DungeonMap.tsx')
const app = source('src/App.tsx')
const session = source('src/useGameSession.ts')
const styles = source('src/styles.css')
const server = source('server/index.mjs')

const INN = 'Трактир «У моста»'
const PLAYER = { id: 'user-1', role: 'player', heroIds: ['hero'] }
const GM = { id: 'user-gm', role: 'admin', heroIds: [] }

const options = (isAdmin = false) => ({ diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { isAdmin } })
const applyAll = (state, events) => events.reduce((next, event) => applyGameEvent(next, event), state)

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'COURIER-UI',
    campaign: 'Почта отряда',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [], currency: { copper: 0, silver: 0, gold: 5, platinum: 0 } }],
    scene: { title: INN, location: INN, location_id: 'inn', cells: [] },
    social: {
      npcs: [
        { id: 'ally', name: 'Мельник Гость', role: 'мельник', location: 'Мельница', visibility: 'party', public_summary: 'Мелет зерно.' },
        { id: 'barkeep', name: 'Трактирщик Бажен', role: 'трактирщик', location: INN, visibility: 'party', public_summary: 'Хозяин зала.' },
      ],
      relationships: { ally: { hero: 60 } },
    },
    mechanics: { world_time: { elapsed_minutes: 0 } },
  })
}

/**
 * Письмо в пути и то же письмо после ответа. Обе точки нужны сразу: тайна
 * проверяется только парой «до и после» — до прихода ответа его нет ни у кого,
 * после прихода он принадлежит столу целиком.
 */
function post() {
  const state = campaign()
  const sent = resolveCommand({
    command_type: 'SendLetter',
    actor_id: 'hero',
    addressee_kind: 'npc',
    addressee_id: 'ally',
    body: 'Здравствуй. Обещаю привезти зерно завтра.',
    // Полировку модели ставит сервер после санитайзера: в этой пробе она
    // запечатана в письмо ровно так, как это делает `withCourierReplyDraft`.
    reply_draft: 'ТАЙНА-ЧЕРНОВИКА: приходи, друг, у нас всегда найдётся место.',
    reply_draft_tone: 'warm',
    reply_provider: 'RouterLlmClient',
    server_authoritative: true,
  }, state, options())
  const inTransit = applyAll(state, sent.events)
  const arrival = resolveCommand(
    { command_type: 'AdvanceTime', amount: inTransit.courier_letters.letters[0].reply_due_minutes, unit: 'minute', server_authoritative: true },
    inTransit,
    options(true),
  )
  return { sentEvents: sent.events, inTransit, arrivalEvents: arrival.events, answered: applyAll(inTransit, arrival.events) }
}

// ---------------------------------------------------------------------------
// Тайна запечатанного ответа
// ---------------------------------------------------------------------------

test('сырая почта наружу не идёт — только публичная форма', () => {
  assert.ok(PROJECTED_STATE_KEYS.includes('courier_letters'), 'ключ обязан быть в белом списке проекции')
  const { inTransit } = post()
  const player = campaignStateForViewer(inTransit, PLAYER, 'hero')
  const raw = JSON.stringify(player)
  assert.ok(!raw.includes('ТАЙНА-ЧЕРНОВИКА'), 'черновик модели столу не принадлежит, пока письмо в пути')
  assert.ok(!raw.includes('reply_draft'), 'самого поля черновика в проекции быть не должно')
  const [letter] = player.courier_letters.letters
  assert.equal(letter.status, 'in_transit')
  assert.equal(letter.status_label, COURIER_LETTER_STATUS_LABELS.in_transit)
  assert.equal(letter.reply, undefined, 'ответа ещё нет ни у кого')
  assert.equal(letter.tone, undefined, 'тон — это отношение числом, и игроку его не показывают')
})

test('ведущий видит тон, по которому соберётся ответ, но не сам ответ', () => {
  const { inTransit } = post()
  const gm = campaignStateForViewer(inTransit, GM, '')
  const [letter] = gm.courier_letters.letters
  assert.equal(letter.tone, 'warm')
  assert.equal(letter.reply, undefined, 'текста ответа до прихода нет и у ведущего')
  assert.ok(!JSON.stringify(gm.courier_letters).includes('ТАЙНА-ЧЕРНОВИКА'))
})

test('пришедший ответ принадлежит столу целиком', () => {
  const { answered } = post()
  const [letter] = campaignStateForViewer(answered, PLAYER, 'hero').courier_letters.letters
  assert.equal(letter.status, 'answered')
  assert.equal(letter.status_label, COURIER_LETTER_STATUS_LABELS.answered)
  assert.equal(letter.reply, 'ТАЙНА-ЧЕРНОВИКА: приходи, друг, у нас всегда найдётся место.')
  assert.equal(letter.tone, 'warm', 'вместе с ответом приезжает и тон: скрывать больше нечего')
})

test('канал событий режет письмо той же функцией, что и проекция состояния', () => {
  const { sentEvents, arrivalEvents } = post()
  const state = post().inTransit
  const [sent] = mechanicsForViewer(sentEvents, PLAYER, 'hero', state)
  assert.equal(sent.event_type, COURIER_LETTER_EVENT_TYPES.sent)
  assert.equal(sent.payload.letter.reply_draft, undefined)
  assert.equal(sent.payload.letter.tone, undefined)
  assert.equal(sent.payload.letter.body, 'Здравствуй. Обещаю привезти зерно завтра.', 'своё письмо отряд читает целиком')
  assert.ok(!JSON.stringify(sent).includes('ТАЙНА-ЧЕРНОВИКА'))

  const delivered = mechanicsForViewer(arrivalEvents, PLAYER, 'hero', state)
    .find((event) => event.event_type === COURIER_LETTER_EVENT_TYPES.delivered)
  assert.ok(delivered)
  assert.equal(delivered.payload.tone, undefined, 'доставка не называет отношение числом-ступенью')
  assert.equal(delivered.payload.answer_expected, true, 'а вот «ответ будет» столу знать можно')
})

// ---------------------------------------------------------------------------
// Карточка панели
// ---------------------------------------------------------------------------

test('панель почты приезжает готовой: адресаты, цены, пороги', () => {
  const player = campaignStateForViewer(campaign(), PLAYER, 'hero').courier_letters
  assert.equal(player.base_fee_cp, COURIER_LETTER_BASE_FEE_CP)
  assert.equal(player.body_limit, COURIER_LETTER_BODY_LIMIT)
  assert.equal(player.open_limit, COURIER_LETTER_OPEN_LIMIT)
  for (const addressee of player.addressees) {
    assert.ok(addressee.fee_cp > 0, 'цена курьера приходит числом, а не формулой')
    assert.ok(addressee.leagues >= 1)
    assert.ok(addressee.travel_minutes > 0)
  }
  // Сосед по столу помечен сервером, а не вычислен клиентом.
  assert.equal(player.addressees.find((row) => row.id === 'barkeep')?.unreachable, true)
})

// ---------------------------------------------------------------------------
// Летопись
// ---------------------------------------------------------------------------

test('карточка летописи собирается на сервере: конверт, от кого и кому', () => {
  const { sentEvents, arrivalEvents } = post()
  const outgoing = courierLetterChronicleEntry(sentEvents[0])
  assert.ok(outgoing.id.startsWith('chronicle:'), 'идентификатор записи обязан быть детерминированным')
  assert.equal(outgoing.speaker, 'system')
  assert.equal(outgoing.author, COURIER_LETTER_CARD_TITLE)
  assert.equal(outgoing.letter.kind, 'sent')
  assert.equal(outgoing.letter.from, 'Ада')
  assert.equal(outgoing.letter.to, 'Мельник Гость')
  assert.equal(outgoing.text, outgoing.letter.text)

  const reply = courierLetterChronicleEntry(arrivalEvents.find((event) => event.event_type === COURIER_LETTER_EVENT_TYPES.answered))
  assert.equal(reply.letter.kind, 'answered')
  // Ответ идёт в обратную сторону: конверт обязан поменять «от» и «кому»
  // местами, иначе стол прочитает ответ как собственное письмо.
  assert.equal(reply.letter.from, 'Мельник Гость')
  assert.equal(reply.letter.to, 'Ада')
  assert.equal(courierLetterChronicleEntry({ event_type: 'TimeAdvanced', payload: {} }), null)
})

test('у каждого события почты есть русская строка в сводке журнала', () => {
  const { sentEvents, arrivalEvents } = post()
  for (const event of [...sentEvents, ...arrivalEvents].filter((entry) => Object.values(COURIER_LETTER_EVENT_TYPES).includes(entry.event_type))) {
    const summary = eventSummary(event)
    assert.notEqual(summary, event.event_type, `событие ${event.event_type} осталось без русской сводки`)
    assert.match(summary, /[А-Яа-яЁё]/u)
  }
  assert.equal(sentEvents[0].payload.policy_id, COURIER_LETTERS_POLICY_ID, 'у механического решения обязан быть провенанс')
})

test('конверт переживает перезагрузку комнаты и собирается в одной точке коммита', () => {
  assert.match(server, /function journalLetter\(letter\)/u)
  assert.match(server, /\.\.\.\(storedLetter \? \{ letter: storedLetter \} : \{\}\)/u)
  assert.match(server, /eventsForChronicle\.map\(courierLetterChronicleEntry\)/u)
})

test('черновик ответа из браузера в команду не проходит', () => {
  // Пришедший от клиента `reply_draft` был бы ответом NPC, написанным игроком:
  // белый список полей санитайзера его не знает, а ставит его сервер сам и
  // только после санитайзера.
  const sanitizer = server.slice(server.indexOf('function sanitizePlayerLetterCommand'), server.indexOf('async function withCourierReplyDraft'))
  assert.ok(sanitizer.length > 0)
  assert.ok(!sanitizer.includes("'reply_draft'"), 'черновик ответа в белом списке полей команды быть не может')
  assert.match(sanitizer, /COURIER_COMMAND_UNKNOWN_FIELD/u)
  assert.match(server, /commands = \[await withCourierReplyDraft\(authoritativeBefore, commands\[0\]\)\]/u)
  assert.match(server, /Письмо идёт отдельной атомарной командой/u)
  // Модели нет — письмо всё равно уходит: механика от неё не зависит.
  assert.match(server, /!npcSocialController\.llmClient\) return command/u)
})

// ---------------------------------------------------------------------------
// Разметка
// ---------------------------------------------------------------------------

test('письмо в летописи — конверт, а не приглушённая служебная строка', () => {
  assert.match(views, /message\.letter \? \(/u)
  assert.match(views, /<LetterChronicleEntry key=\{message\.id\}/u)
  assert.match(views, /ПОЧТА ОТРЯДА/u)
  assert.match(views, /letter-route/u)
  // Фильтр «Рассказ» конверт показывает, «Бой» — нет.
  assert.match(views, /chronicleMatchesFilter\(message\.speaker, filter, Boolean\(message\.offscreen \|\| message\.letter\)\)/u)
  assert.match(styles, /\.message\.system\.letter-entry \{ margin-bottom: 14px; opacity: 1; \}/u)
  assert.match(styles, /\.letter-card \{/u)
  assert.match(styles, /\.letter-text \{/u)
})

test('написать письмо можно кнопкой на доске, а не только подсказкой', () => {
  assert.match(board, /className="letters-panel"/u)
  assert.match(board, /aria-label="Почта отряда"/u)
  assert.match(board, /state\.courier_letters\?\.addressees \?\? \[\]/u)
  assert.match(board, /onSendLetter\(chosenLetterAddressee\.kind, chosenLetterAddressee\.id, body\)/u)
  assert.match(app, /onSendLetter=\{\(kind, addresseeId, body\) => sendLetter\(activePlayer\.id, kind, addresseeId, body\)\}/u)
  assert.match(session, /command_type: 'SendLetter'/u)
  assert.match(styles, /\.letters-panel \{/u)
  assert.match(styles, /\.letters-compose textarea \{/u)
  // Цену, дальность и подпись состояния панель берёт у сервера: своей таблицы
  // и своей арифметики дальности у клиента нет.
  assert.doesNotMatch(board, /fee_cp \* /u)
  assert.doesNotMatch(board, /COURIER_LETTER_BASE_FEE_CP/u)
  assert.match(board, /letter\.status_label/u)
})

test('подсказка про почту приходит из проекции и не считает дальность заново', () => {
  const idle = suggestedActionsFor({
    scene: { objective: '', map: { props: [], doors: [] } },
    scene_npcs: [],
    mechanics: { combat: { active: false } },
    courier_letters: { letters: [], addressees: [{ kind: 'npc', id: 'ally', name: 'Мельник Гость', leagues: 6, fee_cp: 110 }] },
  })
  assert.ok(idle.some((hint) => hint.id === 'letter:write'), 'знакомому можно написать — панель об этом говорит')
  assert.ok(idle.find((hint) => hint.id === 'letter:write').text.includes('110'), 'цена в подсказке серверная')

  const travelling = suggestedActionsFor({
    scene: { objective: '', map: { props: [], doors: [] } },
    scene_npcs: [],
    mechanics: { combat: { active: false } },
    courier_letters: {
      letters: [{ id: 'letter:1', status: 'in_transit', addressee_name: 'Мельник Гость', place_name: 'Мельница' }],
      addressees: [{ kind: 'npc', id: 'ally', name: 'Мельник Гость', leagues: 6, fee_cp: 110 }],
    },
  })
  assert.ok(travelling.some((hint) => hint.id === 'letter:in-transit'))
  assert.ok(!travelling.some((hint) => hint.id === 'letter:write'), 'пока курьер в пути, писать ещё одно письмо панель не зовёт')

  // Почты нет — строки нет: подсказка не сочиняет ни адресатов, ни цен.
  assert.deepEqual(suggestedActionsFor({
    scene: { objective: '', map: { props: [], doors: [] } },
    scene_npcs: [],
    mechanics: { combat: { active: false } },
  }).filter((hint) => hint.id.startsWith('letter:')), [])
})
