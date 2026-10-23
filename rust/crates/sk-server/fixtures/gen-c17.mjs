// Эталон «Г» системного такта, мировых часов и автопропуска хода (С17):
// `node rust/crates/sk-server/fixtures/gen-c17.mjs` пишет `fixtures/c17.json`;
// сверка — `tests/c17_golden.rs`.
//
// Сценарий:
// * часы молвы сами (без такта) рождают слух и реакцию мира после создания
//   кампании — комната после схождения часов;
// * системный такт: права (401, 403 постороннему), нет кампании (404 ведущему),
//   метод вне POST (404), id в нижнем регистре и строка запроса; ведущий и игрок
//   получают комнату со счётчиками часов (после схождения — нули); пауза
//   кампании — 400 с текстом отказа;
// * бой: после «Начать бой» в комнате появляются часы хода героя (`turn_clock`),
//   а по сроку (`DND_COMBAT_TURN_TIMEOUT_MS` = 1500) координатор сам пропускает
//   ход, враг ходит, и часы встают на новый ход героя.
//
// Правила сверх общего формата `skazanie.golden/1`:
// * поле обмена `wait` — перед этим запросом опрашивать тот же путь (опросы не
//   записываются), пока не выполнится условие:
//   - `rumor` — у мира есть слух и репутация гильдии ненулевая;
//   - `turn_clock` — в комнате есть `turn_clock`;
//   - `auto_turn` — строк «Система боя» в летописи стало хотя бы на две больше,
//     чем в предыдущем записанном ответе этого пути (пропуск и ход врага), и
//     `turn_clock` снова у героя с другим `turn_id`;
// * в ответах с `wait` время строк летописи (`timestamp`, местные часы) —
//   `<clock>`; у строк, которых не было в предыдущем записанном ответе пути (у первого
//   ответа пути таких нет), `id`
//   — `<auto-turn>` (якорь — `event_id` с uuid хода), текст строки хода врага —
//   `<npc-turn>` (вариант фразы выбирается от того же uuid; JS сам от прогона к
//   прогону даёт разные), текст пропуска хода сверяется;
// * тела создания кампании, приглашения, входа и команд — `<skip>` (их сверяют
//   эталоны С6, С8 и С18.1), статус сверяется.
// Кости — `DICE` (каждая грань 10, как `dice::fixed(10)` набора Rust).
import '../../../fixtures-env.mjs'

import { recorder, startGoldenServer, writeGolden } from './golden.mjs'

export const DICE = { format: 'skazanie.test-dice/1', rules: [{ value: 10 }] }
export const TURN_TIMEOUT_MS = '1500'

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const PLAYER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }
const VILLAGE = 'Тихий Брод'

/** Кампания с готовым поступком: срок местной молвы уже прошёл. */
function tickState() {
  return {
    sessionCode: 'TICK-1',
    campaign: 'Часы молвы',
    partyName: 'Отряд героев',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    messages: [],
    scene: { title: 'Площадь', location: VILLAGE, location_id: 'village', mood: '', objective: '', turn: 0, cells: [] },
    players: [{ id: 'hero', name: 'Player', character: 'Ада', hp: 10, maxHp: 10, armor: 12, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, inventory: [], online: true }],
    worldMap: { seed: 'rumor-clock', locations: [{ id: 'village', name: VILLAGE, kind: 'village', x: 100, y: 300 }], routes: [] },
    social: { npcs: [{ id: 'baker', name: 'Пекарь Мила', role: 'пекарь', location: VILLAGE, visibility: 'party', public_summary: 'Печёт хлеб на площади.', tags: ['faction:brod-guild'] }] },
    mechanics: { world_time: { amount: 1_000, unit: 'minute', elapsed_minutes: 1_000 } },
    world_deeds: {
      schema_version: 1,
      deeds: [{
        id: 'deed:seeded-murder', kind: 'murder', alignment: 'dark', severity: 'grave',
        actor_ids: ['hero'], actor_names: ['Ада'], subject: 'Страж Бран',
        location_id: 'village', location_name: VILLAGE, at_minutes: 0, witness_ids: ['baker'],
        summary: 'Ада: убийство — Страж Бран (Тихий Брод)', source_event_ids: [], spread_at_minutes: 0, reputation_faction_ids: [],
      }],
    },
  }
}

/** Кампания боя: герой и волк на пустом поле. */
function combatState() {
  return {
    state_version: 0,
    sessionCode: 'FIGHT-1',
    campaign: 'Брод',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{ id: 'hero', character: 'Мирель', name: 'Мирель', className: 'fighter', hp: 30, maxHp: 30, armor: 16, proficiency: 2, x: 0, y: 0, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], online: true }],
    enemies: [{ id: 'wolf', name: 'Волк', hp: 11, maxHp: 11, armor: 13, alive: true, x: 2, y: 0 }],
    scene: { title: 'Брод', location: 'Брод', mood: 'Ночь', objective: 'Отбиться', turn: 0, cells: [] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
    social: { npcs: [], relationships: {}, conversations: [], promises: [] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce',
  }
}

/** Маска строк летописи ответа с `wait` (то же — `mask_journal` в `tests/c17_golden.rs`). */
function maskJournal(bodyNorm, previous) {
  // Первый записанный ответ пути: новых строк нет, маскируется только время.
  const known = previous ? (previous.state?.messages ?? []).length : Infinity
  for (const [index, message] of (bodyNorm?.state?.messages ?? []).entries()) {
    if ('timestamp' in message) message.timestamp = '<clock>'
    if (index < known) continue
    message.id = '<auto-turn>'
    if (!String(message.text ?? '').includes('время хода вышло')) message.text = '<npc-turn>'
  }
  return bodyNorm
}

const systemLines = (body) => (body?.state?.messages ?? []).filter((message) => message?.author === 'Система боя').length

/** Условия опроса `wait` (то же — в `tests/c17_golden.rs`). */
function satisfied(wait, body, previous) {
  const state = body?.state
  if (wait === 'rumor') {
    const rumors = (state?.worldMemory?.epistemic_claims ?? []).filter((claim) => claim.kind === 'rumor')
    return rumors.length > 0 && Number(state?.autonomy?.reputations?.['brod-guild'] ?? 0) !== 0
  }
  if (wait === 'turn_clock') return Boolean(state?.turn_clock)
  if (wait === 'auto_turn') {
    const clock = state?.turn_clock
    return systemLines(body) >= systemLines(previous) + 2
      && Array.isArray(clock?.actor_ids) && clock.actor_ids.join(',') === 'hero'
      && clock.turn_id !== previous?.state?.turn_clock?.turn_id
  }
  throw new Error(`неизвестное условие ${wait}`)
}

const { server, close } = await startGoldenServer({ dice: DICE, env: { DND_COMBAT_TURN_TIMEOUT_MS: TURN_TIMEOUT_MS } })
try {
  const { send, exchanges } = recorder(server)
  const last = () => /** @type {any} */ (exchanges[exchanges.length - 1])
  const skip = async (role, method, path, options) => {
    const response = await send(role, method, path, options)
    last().body_norm = '<skip>'
    return response
  }
  /** @type {Map<string, any>} */
  const previous = new Map()
  /** Опросить путь до условия, затем записать один обмен с полем `wait`. */
  const waitFor = async (role, path, wait) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await send(role, 'GET', path)
      exchanges.pop()
      if (satisfied(wait, response.body, previous.get(path))) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const response = await send(role, 'GET', path)
    if (!satisfied(wait, response.body, previous.get(path))) throw new Error(`условие ${wait} не выполнилось: ${path}`)
    last().wait = wait
    maskJournal(last().body_norm, previous.get(path))
    previous.set(path, response.body)
    return response
  }
  const tick = (code = 'TICK-1', query = '') => `/api/campaigns/${code}/system-tick${query}`

  await send('anon', 'POST', tick(), { body: {} })
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } })
  await send('player', 'POST', '/api/auth/register', { body: PLAYER })
  await send('outsider', 'POST', '/api/auth/register', { body: OUTSIDER })
  await skip('admin', 'POST', '/api/campaigns', { body: { code: 'TICK-1', name: 'Часы молвы', state: tickState() } })
  const invite = await skip('admin', 'POST', '/api/campaigns/TICK-1/invites', { body: { hero_ids: ['hero'] } })
  const inviteIndex = exchanges.length - 1
  await skip('player', 'POST', '/api/campaigns/TICK-1/join', { body: { invite_token: invite.body?.token } })
  last().body = { invite_token: `<invite:${inviteIndex}>` }

  // Часы молвы идут сами: комната после схождения.
  await waitFor('admin', '/api/rooms/TICK-1', 'rumor')

  // Системный такт.
  await send('admin', 'POST', tick(), { body: {} })
  await send('player', 'POST', tick(), { body: {} })
  await send('outsider', 'POST', tick(), { body: {} })
  await send('admin', 'POST', tick('NOPE-1'), { body: {} })
  await send('player', 'POST', tick('NOPE-1'), { body: {} })
  await send('admin', 'GET', tick())
  await send('admin', 'POST', tick('tick-1'), { body: {} })
  await send('admin', 'POST', tick('TICK-1', '?x=1'), { body: {} })
  await send('admin', 'POST', tick('TICK_1'), { body: {} })
  await skip('admin', 'POST', '/api/campaigns/TICK-1/lifecycle', { body: { action: 'pause', idempotency_key: 'pause-1' } })
  await send('player', 'POST', tick(), { body: {} })

  // Бой: часы хода и автопропуск по сроку.
  await skip('admin', 'POST', '/api/campaigns', { body: { code: 'FIGHT-1', name: 'Брод', state: combatState() } })
  await skip('admin', 'POST', '/api/campaigns/FIGHT-1/commands', { body: { idempotency_key: 'start-1', command: { command_type: 'StartCombat', actor_id: 'hero' } } })
  await waitFor('admin', '/api/rooms/FIGHT-1', 'turn_clock')
  await waitFor('admin', '/api/rooms/FIGHT-1', 'auto_turn')

  const file = writeGolden('c17', 'системный такт (права, счётчики часов, пауза), часы молвы без такта, часы хода боя и автопропуск по сроку', exchanges)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  await close()
}
