// Письма и курьеры: слово отряда доходит туда, где отряда нет.
//
// Проверяется ровно то, чем этот слой отличается от строки в чеке:
//   1. дальность считается по дорогам карты мира, а не по прямой;
//   2. отправка стоит монет из кошелька и получаса кампании — до первого события;
//   3. отказы честные: бой, пустое письмо, чужой адресат, сосед по столу, пустой кошелёк, очередь курьера;
//   4. курьер едет мировыми минутами — привал его не двигает, ночёвка двигает;
//   5. дошедшее письмо — социальное действие: отношение, обещание, память мира;
//   6. доброе слово не насос: прибавка не чаще раза в игровую неделю на адресата;
//   7. недоставка честная — мёртвый и уведённый адресат возвращают письмо;
//   8. ответ детерминирован по отношению, врагу сказать нечего;
//   9. полировка модели звучит только под тем тоном, для которого её писали;
//  10. отвечает живой: убитый после доставки шлёт весть, а не приглашение в гости;
//  11. дальность честна на обоих концах — сосед по карте стоит нуля переходов;
//  12. проход по адресатам считает мир один раз, а не на каждого из них;
//  13. всё это переживает replay журнала и повторяется дважды одинаково.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  COURIER_LETTERS_POLICY_ID,
  COURIER_LETTER_BASE_FEE_CP,
  COURIER_LETTER_EVENT_TYPES,
  COURIER_LETTER_FEE_PER_LEAGUE_CP,
  COURIER_LETTER_GOODWILL_COOLDOWN_MINUTES,
  COURIER_LETTER_MAX_LEAGUES,
  COURIER_LETTER_MINIMUM_MINUTES,
  COURIER_LETTER_MINUTES_PER_LEAGUE,
  COURIER_LETTER_OPEN_LIMIT,
  COURIER_LETTER_RELATIONSHIP_DELTA,
  COURIER_LETTER_STATUS_LABELS,
  COURIER_LETTER_UNKNOWN_LEAGUES,
  COURIER_LETTER_WRITING_MINUTES,
  courierAddresseeFor,
  courierFeeFor,
  courierLetterAddressees,
  courierLetterPromiseFrom,
  courierLetterReplyBase,
  courierLetterReplyFor,
  courierToneFor,
  courierTravelMinutes,
  planCourierLetterTicks,
  worldLeaguesBetween,
} from '../server/courier-letters.mjs'
import { applyGameEvent, assertSendLetterAllowed, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

const INN = 'Трактир «У моста»'
const MILL = 'Мельница'

const dice = () => new DiceService({ rng: new SequenceDiceRng([]) })
const options = (isAdmin = false) => ({ diceService: dice(), context: { isAdmin, serverAuthoritativeCombat: true } })
const applyAll = (state, events) => events.reduce((next, event) => applyGameEvent(next, event), state)
const typesOf = (events) => events.map((event) => event.event_type)
const lettersOf = (state) => state.courier_letters.letters

/**
 * Отказ движка проверяется **кодом**, а не русской фразой: код — контракт,
 * по которому клиент выбирает подсказку, и переписанная формулировка не должна
 * ронять тест, а подменённый код — обязана.
 */
function refuses(code, run) {
  assert.throws(run, (error) => {
    assert.equal(error.code, code, `ожидался отказ ${code}, а пришёл ${error.code}: ${error.message}`)
    return true
  })
}

/**
 * Отряд в трактире и трое знакомых: союзник за две дороги отсюда, сосед по
 * столу и тайный NPC ведущего. Рядом — party-видимая фракция: у неё нет
 * адреса на карте, и она проверяет вторую ветку дальности.
 *
 * Отношения расставлены так, чтобы каждая ступень тона была представлена:
 * союзник (`warm`), незнакомец (`plain`) и враг (`silent`). Без этого одна
 * таблица тона проверялась бы одним значением.
 */
function campaign({ relationship = 60, purse = { copper: 0, silver: 0, gold: 5, platinum: 0 } } = {}) {
  return normalizeCampaignState({
    sessionCode: 'COURIER-LETTERS',
    campaign: 'Почта отряда',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [], currency: purse }],
    scene: { title: INN, location: INN, location_id: 'inn', cells: [] },
    social: {
      npcs: [
        { id: 'ally', name: 'Мельник Гость', role: 'мельник', location: MILL, visibility: 'party', public_summary: 'Мелет зерно.' },
        { id: 'stranger', name: 'Возчик Сновид', role: 'возчик', location: MILL, visibility: 'party', public_summary: 'Возит зерно.' },
        { id: 'foe', name: 'Ростовщик Злоба', role: 'ростовщик', location: MILL, visibility: 'party', public_summary: 'Считает долги.' },
        { id: 'barkeep', name: 'Трактирщик Бажен', role: 'трактирщик', location: INN, visibility: 'party', public_summary: 'Хозяин зала.' },
        { id: 'secret', name: 'Тень у очага', role: 'никто', location: MILL, visibility: 'gm_only', public_summary: 'Ведущему.' },
      ],
      relationships: { ally: { hero: relationship }, foe: { hero: -70 } },
    },
    worldMemory: {
      entities: [
        { id: 'faction-wolves', kind: 'faction', name: 'Волчья ватага', summary: 'Ватага на трактах.', visibility: 'party', tags: [] },
        { id: 'faction-secret', kind: 'faction', name: 'Тайный круг', summary: 'Только ведущему.', visibility: 'gm_only', tags: [] },
      ],
    },
    mechanics: { world_time: { elapsed_minutes: 0 } },
  })
}

/**
 * Тот же отряд, но карта мира у него есть.
 *
 * Отряд стоит в погребе трактира: узел карты — тот же `inn`, а название сцены
 * другое, поэтому трактирщик наверху отряду **не сосед по столу** и письмо ему
 * писать можно. Это и есть случай «адресат живёт там же, где стоит отряд»:
 * дорога — ноль переходов, и никакой «адрес неизвестен» тут не при чём.
 */
function mappedCampaign() {
  return normalizeCampaignState({
    ...campaign(),
    scene: { title: 'Погреб трактира', location: 'Погреб трактира', location_id: 'inn', cells: [] },
    worldMap: {
      seed: 'courier-letters-map',
      locations: [
        { id: 'inn', name: INN, x: 120, y: 120, known: true, visited: true },
        { id: 'mill', name: MILL, x: 420, y: 120, known: true, visited: true },
      ],
      routes: [{ id: 'route-inn-mill', from: 'inn', to: 'mill', kind: 'road', distance: 1, discovered: true }],
      currentLocationId: 'inn',
    },
  })
}

/** Письмо в дороге: состояние отряда через миг после того, как курьер уехал. */
function afterSend(state, { addresseeId = 'ally', kind = 'npc', body = 'Здравствуй. Помощь нужна у брода.' } = {}) {
  const resolved = resolveCommand({
    command_type: 'SendLetter',
    actor_id: 'hero',
    addressee_kind: kind,
    addressee_id: addresseeId,
    body,
    server_authoritative: true,
  }, state, options())
  return { events: resolved.events, state: applyAll(state, resolved.events) }
}

const advance = (state, minutes) => resolveCommand(
  { command_type: 'AdvanceTime', amount: minutes, unit: 'minute', server_authoritative: true },
  state,
  options(true),
)

// ---------------------------------------------------------------------------
// Дальность, цена, срок
// ---------------------------------------------------------------------------

test('дальность считается по дорогам, а не по прямой', () => {
  // Дуга и хорда: напрямую между «a» и «c» пять клеток карты, а по дорогам —
  // два перехода через «b». Прямая дала бы другое число, и письмо через кряж
  // стоило бы как письмо вдоль тракта.
  const map = {
    locations: [{ id: 'a', name: 'А', x: 0, y: 0 }, { id: 'b', name: 'Б', x: 400, y: 0 }, { id: 'c', name: 'В', x: 800, y: 0 }],
    routes: [{ from: 'a', to: 'b', distance: 1 }, { from: 'b', to: 'c', distance: 1 }],
  }
  assert.equal(worldLeaguesBetween(map, 'a', 'c'), 2)
  assert.equal(worldLeaguesBetween(map, 'a', 'b'), 1)
  assert.equal(worldLeaguesBetween(map, 'a', 'a'), 0)
  // Длинная дорога проигрывает короткой: Дейкстра, а не число рёбер.
  const detour = {
    locations: map.locations,
    routes: [{ from: 'a', to: 'b', distance: 1 }, { from: 'b', to: 'c', distance: 1 }, { from: 'a', to: 'c', distance: 9 }],
  }
  assert.equal(worldLeaguesBetween(detour, 'a', 'c'), 2)
})

test('неразведанная дорога курьеру не считается, а без дорог остаётся прямая', () => {
  const hidden = {
    locations: [{ id: 'a', name: 'А', x: 0, y: 0 }, { id: 'c', name: 'В', x: 480, y: 0 }],
    routes: [{ from: 'a', to: 'c', distance: 1, discovered: false }],
  }
  // Маршрута отряд не знает, поэтому остаётся прямая: 480 / 48 = 10.
  assert.equal(worldLeaguesBetween(hidden, 'a', 'c'), 10)
  assert.equal(worldLeaguesBetween(hidden, 'a', 'нет-такого'), null)
})

test('цена и срок растут с дальностью и упираются в потолок', () => {
  assert.equal(courierFeeFor(0), COURIER_LETTER_BASE_FEE_CP)
  assert.equal(courierFeeFor(3), COURIER_LETTER_BASE_FEE_CP + 3 * COURIER_LETTER_FEE_PER_LEAGUE_CP)
  assert.equal(courierFeeFor(999), COURIER_LETTER_BASE_FEE_CP + COURIER_LETTER_MAX_LEAGUES * COURIER_LETTER_FEE_PER_LEAGUE_CP)
  // Ближняя дорога всё равно занимает ночь: у срока есть пол, иначе письмо
  // приходило бы тем же привалом, что и ушло.
  assert.equal(courierTravelMinutes(1), COURIER_LETTER_MINIMUM_MINUTES)
  assert.equal(courierTravelMinutes(6), COURIER_LETTER_MINUTES_PER_LEAGUE * 6)
  assert.equal(courierTravelMinutes(999), COURIER_LETTER_MINUTES_PER_LEAGUE * COURIER_LETTER_MAX_LEAGUES)
})

test('писать можно знакомым и открытым фракциям, но не соседу по столу', () => {
  const state = campaign()
  const rows = courierLetterAddressees(state)
  const ids = rows.map((row) => row.id)
  assert.ok(ids.includes('ally'), 'знакомый NPC — адресат')
  assert.ok(ids.includes('faction-wolves'), 'открытая фракция — адресат')
  assert.ok(!ids.includes('secret'), 'тайный NPC ведущего в список не попадает')
  assert.ok(!ids.includes('faction-secret'), 'тайная фракция ведущего в список не попадает')
  // Сосед по столу в списке остаётся, но помечен: это разговор, а не почта, и
  // панель обязана погасить строку до клика, а не поймать отказ движка после.
  assert.equal(rows.find((row) => row.id === 'barkeep')?.unreachable, true)
  assert.equal(rows.find((row) => row.id === 'ally')?.unreachable, false)
  // Место NPC карте неизвестно, поэтому дальность берётся ступенью — и цена с
  // ней. Своей второй арифметики у списка нет: цена та же, что у формулы.
  const ally = courierAddresseeFor(state, 'npc', 'ally')
  assert.equal(ally.leagues, COURIER_LETTER_UNKNOWN_LEAGUES)
  assert.equal(ally.fee_cp, courierFeeFor(ally.leagues))
  assert.equal(ally.travel_minutes, courierTravelMinutes(ally.leagues))
  assert.equal(courierAddresseeFor(state, 'npc', 'нет-такого'), null)
  assert.equal(courierAddresseeFor(state, 'letter', 'ally'), null)
})

test('адресат в том же узле карты стоит нуля переходов, а не «адрес неизвестен»', () => {
  // Регресс ревью: `worldLeaguesBetween` честно отдавала 0 для одного и того же
  // узла, но у места вызова стояло `integer(...) || СТУПЕНЬ`, и ноль подменялся
  // шестью переходами. Трактирщик наверху получался дороже мельника за дорогой:
  // письмо через комнату — 110 мм и сутки, письмо через тракт — 60 мм и восемь
  // часов. Ноль обязан доезжать до цены целым.
  const state = mappedCampaign()
  const near = courierAddresseeFor(state, 'npc', 'barkeep')
  const far = courierAddresseeFor(state, 'npc', 'ally')

  assert.equal(near.leagues, 0, 'один узел — ноль переходов')
  assert.notEqual(near.leagues, COURIER_LETTER_UNKNOWN_LEAGUES, 'ступень «адрес неизвестен» тут ни при чём')
  assert.equal(near.fee_cp, COURIER_LETTER_BASE_FEE_CP, 'ближняя дорога стоит одной базы')
  assert.equal(near.travel_minutes, COURIER_LETTER_MINIMUM_MINUTES, 'но занимает всё равно не меньше ночи')
  assert.equal(far.leagues, 1)
  assert.equal(far.fee_cp, COURIER_LETTER_BASE_FEE_CP + COURIER_LETTER_FEE_PER_LEAGUE_CP)
  assert.ok(near.fee_cp < far.fee_cp, 'письмо через комнату не может стоить дороже письма через тракт')
  // Отряд стоит в погребе, трактирщик — наверху: узел карты один, а сцена
  // разная, поэтому это всё ещё почта, а не разговор.
  assert.equal(near.unreachable, false)

  // Ноль доезжает и до самой записи письма: цену и дорогу читают из неё.
  const { state: after } = afterSend(state, { addresseeId: 'barkeep', body: 'Бажен, придержи комнату.' })
  const [letter] = lettersOf(after)
  assert.equal(letter.leagues, 0)
  assert.equal(letter.fee_cp, COURIER_LETTER_BASE_FEE_CP)
})

test('соц.состояние, живые NPC и карта считаются раз на проход, а не на каждого адресата', () => {
  // Регресс ревью: `courierLetterAddressees` звала `courierAddresseeFor` в
  // цикле, а та внутри каждого вызова заново поднимала `ensureNpcSocialState`,
  // `normalizeNpcWorldState`, `presentSceneNpcs` и свою Дейкстру. Проекция
  // строится в broadcast-цикле на каждое соединение, поэтому при полусотне
  // знакомых это десятки миллисекунд чистого CPU на кадр.
  //
  // Проба детерминированная, а не по часам: считаются **обращения к состоянию**.
  // Работа, зависящая от отряда, а не от адресата, обязана стоить одинаково при
  // четырёх знакомых и при сорока.
  const counted = (state) => {
    const counts = { social: 0, npc_world: 0, routes: 0 }
    const social = state.social
    const npcWorld = state.npc_world
    const routes = state.worldMap.routes
    const worldMap = { ...state.worldMap }
    Object.defineProperty(worldMap, 'routes', { get() { counts.routes += 1; return routes }, enumerable: true })
    const probe = { ...state, worldMap }
    Object.defineProperty(probe, 'social', { get() { counts.social += 1; return social }, enumerable: true })
    Object.defineProperty(probe, 'npc_world', { get() { counts.npc_world += 1; return npcWorld }, enumerable: true })
    return { probe, counts }
  }
  const crowd = (size) => normalizeCampaignState({
    ...mappedCampaign(),
    // Фракции здесь лишние: считается рост от числа **знакомых**, а у фракции
    // ни места на карте, ни строки в соц.состоянии нет.
    worldMemory: { entities: [] },
    social: {
      npcs: Array.from({ length: size }, (unused, index) => ({
        id: `npc-${index}`,
        name: `Знакомый ${index}`,
        role: 'знакомый',
        location: index % 2 === 0 ? MILL : INN,
        visibility: 'party',
        public_summary: 'Знакомый отряда.',
      })),
      relationships: {},
    },
  })

  const few = counted(crowd(4))
  const many = counted(crowd(40))
  assert.equal(courierLetterAddressees(few.probe).length, 4)
  assert.equal(courierLetterAddressees(many.probe).length, 40)
  assert.deepEqual(many.counts, few.counts, 'десятикратный список знакомых не должен стоить десятикратной работы')
  // И это именно «раз на проход», а не «раз на пару»: числа маленькие и точные.
  // Тройка у соц.состояния — не три обхода, а два чтения одного поля внутри
  // `presentSceneNpcs` (`Array.isArray(state.social?.npcs) ? state.social.npcs`).
  assert.ok(few.counts.social <= 3, `соц.состояние поднимается ${few.counts.social} раз(а)`)
  assert.ok(few.counts.npc_world <= 2, `живые NPC поднимаются ${few.counts.npc_world} раз(а)`)
  // Дейкстра на проход одна: два чтения — это `Array.isArray(map?.routes) ?
  // map.routes` внутри неё, а не второй обход карты.
  assert.ok(few.counts.routes <= 2, `дороги карты читаются ${few.counts.routes} раз(а)`)
})

// ---------------------------------------------------------------------------
// Отправка
// ---------------------------------------------------------------------------

test('отправка снимает плату курьеру, заводит письмо и тратит полчаса кампании', () => {
  const state = campaign()
  const fee = courierAddresseeFor(state, 'npc', 'ally').fee_cp
  const { events, state: after } = afterSend(state)

  assert.deepEqual(typesOf(events), [COURIER_LETTER_EVENT_TYPES.sent, 'TimeAdvanced'])
  const sent = events[0]
  assert.equal(sent.payload.fee_cp, fee)
  assert.equal(sent.payload.policy_id, COURIER_LETTERS_POLICY_ID)
  assert.equal(sent.payload.balance_before_cp - sent.payload.balance_after_cp, fee)
  assert.equal(events[1].payload.minutes ?? events[1].payload.elapsed_minutes, COURIER_LETTER_WRITING_MINUTES)

  const [letter] = lettersOf(after)
  assert.equal(letter.status, 'in_transit')
  assert.equal(letter.addressee_id, 'ally')
  assert.equal(letter.delivery_due_minutes, letter.sent_at_minutes + courierTravelMinutes(letter.leagues))
  assert.ok(letter.reply_due_minutes > letter.delivery_due_minutes, 'ответ не приходит той же минутой, что и доставка')
  // Кошелёк уменьшился ровно на плату курьеру и ни на медяк больше.
  const purseCp = (actor) => actor.currency.copper + actor.currency.silver * 10 + actor.currency.gold * 100 + actor.currency.platinum * 1_000
  assert.equal(purseCp(state.players[0]) - purseCp(after.players[0]), fee)
})

test('письмо фракции уходит без адреса на карте: у канцелярии нет столицы', () => {
  const { events, state: after } = afterSend(campaign(), { addresseeId: 'faction-wolves', kind: 'faction' })
  assert.equal(typesOf(events)[0], COURIER_LETTER_EVENT_TYPES.sent)
  assert.equal(lettersOf(after)[0].addressee_kind, 'faction')
  assert.equal(lettersOf(after)[0].place_name, '')
})

test('письмо фракции доходит без адресата: слава растёт, канцелярия отвечает', () => {
  // Вторая ветка адресата целиком: у фракции нет ни ОЗ, ни доступности, ни
  // отношения к герою — тон читается по славе отряда, обещания не заводится, а
  // прибавка идёт `FactionReputationAdjusted`, а не отношением NPC. Без этой
  // пробы половина модуля держалась бы на одной отправке.
  const sent = afterSend(campaign(), {
    addresseeId: 'faction-wolves',
    kind: 'faction',
    body: 'Обещаю выкупить обоз к осени.',
  }).state
  const [letter] = lettersOf(sent)
  const run = advance(sent, letter.reply_due_minutes)
  const types = typesOf(run.events)
  assert.ok(types.includes(COURIER_LETTER_EVENT_TYPES.delivered), 'канцелярию не убивают и не уводят — письмо доходит всегда')
  assert.ok(types.includes('FactionReputationAdjusted'), 'слава отряда растёт вместо отношения NPC')
  assert.ok(!types.includes('NpcRelationshipAdjusted'), 'у фракции нет отношения к конкретному герою')
  assert.ok(!types.includes('NpcPromiseRecorded'), 'обещание даётся человеку, а не канцелярии')

  const after = applyAll(sent, run.events)
  assert.equal(after.autonomy.reputations['faction-wolves'], COURIER_LETTER_RELATIONSHIP_DELTA + 1)
  assert.equal(lettersOf(after)[0].status, 'answered')
  assert.match(lettersOf(after)[0].reply_text, /Волчья ватага/u)
})

test('движок отказывает честно: бой, пустое письмо, чужой адрес и сосед по столу', () => {
  const base = campaign()
  const send = (patch, state = base) => resolveCommand({
    command_type: 'SendLetter',
    actor_id: 'hero',
    addressee_kind: 'npc',
    addressee_id: 'ally',
    body: 'Здравствуй.',
    server_authoritative: true,
    ...patch,
  }, state, options())

  refuses('COURIER_LETTER_EMPTY', () => send({ body: '   ' }))
  refuses('COURIER_ADDRESSEE_NOT_FOUND', () => send({ addressee_id: 'нет-такого' }))
  refuses('COURIER_ADDRESSEE_NOT_FOUND', () => send({ addressee_id: 'secret' }))
  refuses('COURIER_ADDRESSEE_PRESENT', () => send({ addressee_id: 'barkeep' }))
  refuses('ACTOR_FORBIDDEN', () => send({ actor_id: 'ally' }))

  const fighting = normalizeCampaignState({ ...campaign(), mechanics: { ...base.mechanics, combat: { active: true, round: 1, order: [], turnIndex: 0 } } })
  refuses('COURIER_DURING_COMBAT', () => send({}, fighting))

  const broke = campaign({ purse: { copper: 3, silver: 0, gold: 0, platinum: 0 } })
  refuses('INSUFFICIENT_FUNDS', () => send({}, broke))
})

test('те же отказы движок отдаёт отдельным сторожем — до всякой модели', () => {
  // Регресс ревью: HTTP-слой звал модель за полировкой ответа **до** любой
  // проверки движка, и каждый отказ был оплачен одним completion. Сторож
  // вынесен отдельной функцией и обязан отвечать теми же кодами, что и
  // `resolveCommand`: второй копии правил в проекте быть не должно.
  const base = campaign()
  const letter = (patch = {}) => ({
    command_type: 'SendLetter',
    actor_id: 'hero',
    addressee_kind: 'npc',
    addressee_id: 'ally',
    body: 'Здравствуй.',
    ...patch,
  })
  const guarded = (state, patch) => () => assertSendLetterAllowed(state, letter(patch))

  assert.ok(assertSendLetterAllowed(base, letter()), 'разрешённое письмо возвращает посчитанного адресата')
  refuses('COURIER_LETTER_EMPTY', guarded(base, { body: '   ' }))
  refuses('COURIER_ADDRESSEE_NOT_FOUND', guarded(base, { addressee_id: 'нет-такого' }))
  refuses('COURIER_ADDRESSEE_PRESENT', guarded(base, { addressee_id: 'barkeep' }))
  refuses('ACTOR_FORBIDDEN', guarded(base, { actor_id: 'ally' }))
  refuses('INSUFFICIENT_FUNDS', guarded(campaign({ purse: { copper: 3, silver: 0, gold: 0, platinum: 0 } }), {}))

  const fighting = normalizeCampaignState({ ...campaign(), mechanics: { ...base.mechanics, combat: { active: true, round: 1, order: [], turnIndex: 0 } } })
  refuses('COURIER_DURING_COMBAT', guarded(fighting, {}))

  const unconscious = normalizeCampaignState({ ...campaign(), players: [{ ...base.players[0], hp: 0 }] })
  refuses('ACTOR_DEFEATED', guarded(unconscious, {}))

  let queued = campaign()
  for (const addressee of ['ally', 'stranger', 'foe']) {
    queued = afterSend(queued, { addresseeId: addressee, body: `Здравствуй, ${addressee}.` }).state
  }
  refuses('COURIER_TOO_MANY_LETTERS', guarded(queued, { addressee_id: 'faction-wolves', addressee_kind: 'faction' }))
})

test('очередь курьера ограничена: четвёртое письмо героя он не берёт', () => {
  let state = campaign()
  for (const addressee of ['ally', 'stranger', 'foe']) {
    state = afterSend(state, { addresseeId: addressee, body: `Здравствуй, ${addressee}.` }).state
  }
  assert.equal(lettersOf(state).length, COURIER_LETTER_OPEN_LIMIT)
  refuses('COURIER_TOO_MANY_LETTERS', () => afterSend(state, { addresseeId: 'faction-wolves', kind: 'faction' }))
})

// ---------------------------------------------------------------------------
// Дорога, доставка и ответ
// ---------------------------------------------------------------------------

test('курьер едет мировыми минутами: привал его не двигает, ночёвка двигает', () => {
  const sent = afterSend(campaign()).state
  const travel = lettersOf(sent)[0].delivery_due_minutes

  const shortRest = advance(sent, 60)
  assert.ok(!typesOf(shortRest.events).includes(COURIER_LETTER_EVENT_TYPES.delivered), 'час привала письма не доводит')
  assert.equal(lettersOf(applyAll(sent, shortRest.events))[0].status, 'in_transit')

  const night = advance(sent, travel)
  assert.ok(typesOf(night.events).includes(COURIER_LETTER_EVENT_TYPES.delivered), 'к сроку письмо обязано дойти')
  const delivered = lettersOf(applyAll(sent, night.events))[0]
  assert.equal(delivered.status, 'delivered')
  assert.equal(delivered.delivered_at_minutes, travel)
})

test('доставка — социальное действие: отношение, обещание и память мира', () => {
  const state = campaign()
  const before = state.social.relationships.ally.hero
  const sent = afterSend(state, { body: 'Обещаю привезти зерно к завтрашнему утру.' }).state
  const arrival = advance(sent, lettersOf(sent)[0].delivery_due_minutes)
  const after = applyAll(sent, arrival.events)

  const types = typesOf(arrival.events)
  assert.ok(types.includes(COURIER_LETTER_EVENT_TYPES.delivered))
  assert.ok(types.includes('NpcRelationshipAdjusted'), 'дошедшее письмо греет отношение')
  assert.ok(types.includes('NpcPromiseRecorded'), 'обещание в письме — обещание')
  assert.ok(types.includes('WorldFactRecorded'), 'переписка ложится в память мира')
  assert.ok(types.includes('WorldEntityUpserted'), 'адресат заводится сущностью, иначе факт о нём пропадёт')

  // Прибавка не своя: её считает социальный движок теми же ступенями, что и
  // разговор. Обещание добавляет сверху.
  assert.ok(after.social.relationships.ally.hero > before + COURIER_LETTER_RELATIONSHIP_DELTA - 1)
  const promise = after.social.promises.find((entry) => entry.npc_id === 'ally')
  assert.ok(promise, 'обещание завелось штатной записью социального движка')
  assert.equal(promise.direction, 'party_to_npc')
  assert.match(promise.text, /Обещаю привезти зерно/u)
  // Факт памяти получил минуту записи: без неё он тихо встал бы в нулевую и
  // выпал за горизонт выдачи.
  const fact = after.worldMemory.facts.find((entry) => entry.predicate === 'courier_letter_delivered')
  assert.ok(fact)
  assert.equal(fact.recorded_at_minutes, lettersOf(after)[0].delivered_at_minutes)
})

test('доброе слово не насос: второе письмо за игровую неделю отношения не греет', () => {
  const state = campaign()
  const first = afterSend(state).state
  const arrival = advance(first, lettersOf(first)[0].delivery_due_minutes)
  const delivered = applyAll(first, arrival.events)
  const warmed = delivered.social.relationships.ally.hero

  const second = afterSend(delivered, { body: 'Ещё раз здравствуй.' }).state
  const soon = advance(second, courierTravelMinutes(COURIER_LETTER_UNKNOWN_LEAGUES))
  const afterSecond = applyAll(second, soon.events)
  assert.ok(typesOf(soon.events).includes(COURIER_LETTER_EVENT_TYPES.delivered), 'второе письмо всё равно доходит')
  assert.equal(afterSecond.social.relationships.ally.hero, warmed, 'а отношение оно уже не двигает')

  // Через игровую неделю адресат снова рад весточке.
  const later = advance(afterSecond, COURIER_LETTER_GOODWILL_COOLDOWN_MINUTES)
  const third = afterSend(applyAll(afterSecond, later.events), { body: 'Как ты там?' }).state
  const thirdArrival = advance(third, courierTravelMinutes(COURIER_LETTER_UNKNOWN_LEAGUES))
  assert.ok(typesOf(thirdArrival.events).includes('NpcRelationshipAdjusted'), 'через неделю письмо снова греет')
})

test('недоставка честная: мёртвый и уведённый адресат возвращают письмо', () => {
  const sent = afterSend(campaign()).state
  const travel = lettersOf(sent)[0].delivery_due_minutes

  const dead = { ...sent, npc_world: { ...sent.npc_world, vitals: { ...sent.npc_world.vitals, ally: { ...(sent.npc_world.vitals.ally ?? {}), alive: false } } } }
  const deadRun = advance(dead, travel)
  const returned = deadRun.events.find((event) => event.event_type === COURIER_LETTER_EVENT_TYPES.returned)
  assert.ok(returned, 'к мёртвому письмо не доходит')
  assert.equal(returned.payload.reason, 'dead')
  assert.ok(!typesOf(deadRun.events).includes(COURIER_LETTER_EVENT_TYPES.delivered))
  const deadAfter = applyAll(dead, deadRun.events)
  assert.equal(lettersOf(deadAfter)[0].status, 'returned')
  assert.equal(lettersOf(deadAfter)[0].return_reason, 'dead')

  const gone = { ...sent, social: { ...sent.social, npcs: sent.social.npcs.map((npc) => (npc.id === 'ally' ? { ...npc, available: false } : npc)) } }
  const goneRun = advance(gone, travel)
  assert.equal(goneRun.events.find((event) => event.event_type === COURIER_LETTER_EVENT_TYPES.returned)?.payload.reason, 'gone')

  // Вернувшееся письмо ответа не ждёт: дорога кончилась, и дальше его никто не
  // читает — даже если отряд простоит под замком месяц.
  const month = advance(deadAfter, 43_200)
  assert.ok(!typesOf(month.events).includes(COURIER_LETTER_EVENT_TYPES.answered))
  // Плату курьеру не возвращают: дорогу он проехал.
  assert.deepEqual(deadAfter.players[0].currency, sent.players[0].currency)
})

test('ответ приходит игровыми часами позже и ложится в письмо', () => {
  const sent = afterSend(campaign()).state
  const [letter] = lettersOf(sent)
  const run = advance(sent, letter.reply_due_minutes)
  const types = typesOf(run.events)
  assert.ok(types.includes(COURIER_LETTER_EVENT_TYPES.delivered))
  assert.ok(types.includes(COURIER_LETTER_EVENT_TYPES.answered), 'долгий скачок доводит письмо до ответа целиком')

  const after = applyAll(sent, run.events)
  const answered = lettersOf(after)[0]
  assert.equal(answered.status, 'answered')
  assert.equal(COURIER_LETTER_STATUS_LABELS[answered.status], 'Получен ответ')
  assert.ok(answered.reply_text.length > 0, 'без модели ответ всё равно есть')
  assert.equal(answered.reply_provider, 'deterministic-courier-reply')
  assert.equal(answered.answered_at_minutes, letter.reply_due_minutes)
  // Ответ ложится в память мира: переписку отряд потом вспомнит.
  assert.ok(after.worldMemory.facts.some((fact) => fact.predicate === 'courier_letter_answered'))
})

test('убитый после доставки не отвечает: приходит весть, а не приглашение в гости', () => {
  // Регресс ревью: `deliveryFailureFor` спрашивалась только в ветке доставки, а
  // ветка ответа сверяла один тон. Отряд убивал мельника утром и вечером
  // получал от него «зови, приду» — да ещё и фактом в память мира, откуда это
  // прочёл бы Рассказчик.
  const sent = afterSend(campaign()).state
  const [letter] = lettersOf(sent)

  const arrival = advance(sent, letter.delivery_due_minutes)
  const delivered = applyAll(sent, arrival.events)
  assert.equal(lettersOf(delivered)[0].status, 'delivered')
  assert.equal(lettersOf(delivered)[0].tone, 'warm', 'на минуту доставки адресат ещё друг')

  // Мельника убивают уже после того, как он прочёл письмо.
  const dead = {
    ...delivered,
    npc_world: { ...delivered.npc_world, vitals: { ...delivered.npc_world.vitals, ally: { ...(delivered.npc_world.vitals.ally ?? {}), alive: false } } },
  }
  const reply = advance(dead, letter.reply_due_minutes - letter.delivery_due_minutes)
  const types = typesOf(reply.events)
  assert.ok(!types.includes(COURIER_LETTER_EVENT_TYPES.answered), 'мёртвый не отвечает')
  const silence = reply.events.find((event) => event.event_type === COURIER_LETTER_EVENT_TYPES.unanswered)
  assert.ok(silence, 'стол узнаёт об этом вестью, а не молчанием движка')
  assert.equal(silence.payload.reason, 'dead')
  assert.match(silence.payload.summary, /Ответа от Мельник Гость не будет/u)

  const after = applyAll(dead, reply.events)
  const closed = lettersOf(after)[0]
  assert.equal(closed.status, 'unanswered')
  assert.equal(COURIER_LETTER_STATUS_LABELS[closed.status], 'Ответа не будет')
  assert.equal(closed.reply_text, '', 'текста ответа у письма не появилось')
  // В память мира ложится молчание, а не переписка: Рассказчик прочтёт именно
  // то, что случилось.
  assert.ok(!after.worldMemory.facts.some((fact) => fact.predicate === 'courier_letter_answered'))
  assert.ok(after.worldMemory.facts.some((fact) => fact.predicate === 'courier_letter_unanswered'))
  // Дуга кончилась: месяц под замком ответа уже не принесёт.
  assert.deepEqual(planCourierLetterTicks(after, { elapsedMinutes: 43_200 }), [])
})

test('уведённый после доставки молчит по той же причине, что и убитый', () => {
  const sent = afterSend(campaign()).state
  const [letter] = lettersOf(sent)
  const delivered = applyAll(sent, advance(sent, letter.delivery_due_minutes).events)
  const gone = {
    ...delivered,
    social: { ...delivered.social, npcs: delivered.social.npcs.map((npc) => (npc.id === 'ally' ? { ...npc, available: false } : npc)) },
  }
  const reply = advance(gone, letter.reply_due_minutes - letter.delivery_due_minutes)
  const silence = reply.events.find((event) => event.event_type === COURIER_LETTER_EVENT_TYPES.unanswered)
  assert.ok(silence)
  assert.equal(silence.payload.reason, 'gone')
  assert.equal(lettersOf(applyAll(gone, reply.events))[0].status, 'unanswered')
})

test('доставка и ответ в одном скачке заводят сущность адресата один раз', () => {
  // Регресс ревью: `addresseeEntityDraft` вызывалась и на доставке, и на
  // ответе, и в журнал уходили два дословно одинаковых `WorldEntityUpserted`.
  // Апсерт идемпотентен, но журнал потом читают и реплеят.
  const sent = afterSend(campaign()).state
  const run = advance(sent, lettersOf(sent)[0].reply_due_minutes)
  const upserts = run.events.filter((event) => event.event_type === 'WorldEntityUpserted')
  assert.equal(upserts.length, 1, 'один адресат — одна запись сущности на скачок')
  // Факты при этом разные, и их два: доставка и ответ — разные события мира.
  assert.equal(run.events.filter((event) => event.event_type === 'WorldFactRecorded').length, 2)
})

test('врагу сказать нечего: доставка объявляет молчание, и ответа не будет никогда', () => {
  const sent = afterSend(campaign(), { addresseeId: 'foe', body: 'Долг верну позже.' }).state
  const run = advance(sent, lettersOf(sent)[0].reply_due_minutes)
  const delivered = run.events.find((event) => event.event_type === COURIER_LETTER_EVENT_TYPES.delivered)
  assert.ok(delivered)
  assert.equal(delivered.payload.tone, 'silent')
  assert.equal(delivered.payload.answer_expected, false)
  assert.ok(!typesOf(run.events).includes(COURIER_LETTER_EVENT_TYPES.answered))
  // Врага письмо не греет тоже: прибавка за него не идёт.
  assert.ok(!typesOf(run.events).includes('NpcRelationshipAdjusted'))
})

// ---------------------------------------------------------------------------
// Основа ответа и полировка модели
// ---------------------------------------------------------------------------

test('тон читается по отношению теми же ступенями, что у разговора', () => {
  assert.equal(courierToneFor(60), 'warm')
  assert.equal(courierToneFor(25), 'friendly')
  assert.equal(courierToneFor(0), 'plain')
  assert.equal(courierToneFor(-30), 'cold')
  assert.equal(courierToneFor(-70), 'silent')
})

test('основа ответа детерминирована и называет обоих по имени', () => {
  const letter = { id: 'letter:x', addressee_id: 'ally', addressee_name: 'Мельник Гость', hero_name: 'Ада' }
  const base = courierLetterReplyBase(letter, 'warm')
  assert.equal(base, courierLetterReplyBase(letter, 'warm'), 'дважды из одного письма — одна и та же строка')
  assert.match(base, /Мельник Гость/u)
  assert.equal(courierLetterReplyBase(letter, 'silent'), '', 'у молчания текста нет')
  // Обещание помнят — кроме холодного тона: там его припоминать нечем.
  const promised = { ...letter, promise_text: 'Верну долг к осени.' }
  assert.match(courierLetterReplyBase(promised, 'warm'), /Верну долг к осени/u)
  assert.ok(!courierLetterReplyBase(promised, 'cold').includes('Верну долг к осени'))
})

test('полировка модели звучит только под тем тоном, для которого её писали', () => {
  const letter = {
    id: 'letter:x', addressee_id: 'ally', addressee_name: 'Мельник Гость', hero_name: 'Ада',
    reply_draft: 'Приходи, друг, у нас всегда найдётся место.', reply_draft_tone: 'warm', reply_provider: 'RouterLlmClient',
  }
  assert.deepEqual(courierLetterReplyFor(letter, 'warm'), { reply: letter.reply_draft, provider: 'RouterLlmClient' })
  // Черновик писали другу, а письмо застало врага: подсовывать столу тёплые
  // слова от того, кто их уже не сказал бы, нельзя.
  const cold = courierLetterReplyFor(letter, 'cold')
  assert.equal(cold.provider, 'deterministic-courier-reply')
  assert.ok(!cold.reply.includes('Приходи, друг'))
  assert.equal(courierLetterReplyFor(letter, 'silent'), null)
})

test('обещание опознаётся по слову, а срок читается тем же разбором, что и вслух', () => {
  assert.equal(courierLetterPromiseFrom('Просто весточка, ничего больше.'), null)
  const promise = courierLetterPromiseFrom('Здравствуй. Обещаю вернуть долг завтра. Береги себя.')
  assert.equal(promise.text, 'Обещаю вернуть долг завтра.')
  assert.equal(promise.due_hint, 'Обещаю вернуть долг завтра.')
  // Слово есть, срока нет — обещание остаётся, а срока у него не появляется.
  assert.equal(courierLetterPromiseFrom('Клянусь помочь.').due_hint, '')
})

// ---------------------------------------------------------------------------
// Детерминизм и replay
// ---------------------------------------------------------------------------

test('одинаковое состояние и одинаковый скачок дают одну и ту же почту', () => {
  const sent = afterSend(campaign()).state
  const jump = lettersOf(sent)[0].reply_due_minutes
  assert.deepEqual(planCourierLetterTicks(sent, { elapsedMinutes: jump }), planCourierLetterTicks(sent, { elapsedMinutes: jump }))
  assert.deepEqual(planCourierLetterTicks(sent, { elapsedMinutes: 0 }), [], 'нулевой скачок почту не двигает')
})

test('почта переживает replay журнала', () => {
  const state = campaign()
  const sent = afterSend(state, { body: 'Обещаю привезти зерно завтра.' })
  const arrival = advance(sent.state, lettersOf(sent.state)[0].reply_due_minutes)
  const live = applyAll(sent.state, arrival.events)
  const replayed = replayEvents(state, [...sent.events, ...arrival.events])
  assert.deepEqual(replayed.courier_letters, live.courier_letters)
  assert.equal(lettersOf(replayed)[0].status, 'answered')
})
