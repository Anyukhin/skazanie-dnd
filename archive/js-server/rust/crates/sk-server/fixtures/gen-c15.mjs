// Эталон «Г» диалога и объяснения хода (С15):
// `node rust/crates/sk-server/fixtures/gen-c15.mjs` пишет `fixtures/c15.json`;
// сверка — `tests/c15_golden.rs`.
//
// Сценарий: диалог героя — права (401, 403 до сверки и после, чужой герой,
// пустой `actor_id`), нет кампании (404 ведущему), метод вне GET/DELETE;
// пустой диалог; план из шагов с ручным броском (`/api/narrate`) оставляет
// уточнение и карточку первого шага — диалог отдаёт обе и связывает карточку
// с уточнением; сброс: чужое уточнение — 400 `CLARIFICATION_NOT_FOUND`, своё —
// `cleared`, затем карточка без уточнения. Объяснение хода: нет трасс — 404,
// по id и `latest`, проекция команды врага игроку, права, кампании нет.
//
// Правила сверх общего формата `skazanie.golden/1`:
// * токен приглашения в теле входа — ссылкой `<invite:N>` (токен из ответа
//   обмена N), как в `gen-c6.mjs`;
// * id уточнения в теле сброса — ссылкой `<clarification:N>` (`clarification.id`
//   из ответа обмена N);
// * тела ответов `/api/narrate`, `/commands` и создания кампании — `<skip>`
//   (их сверяют эталоны С18.5, С18.1 и С6), статус сверяется.
import '../../../fixtures-env.mjs'

import { recorder, startGoldenServer, writeGolden } from './golden.mjs'

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const PLAYER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }
const HERO = 'hero-slot-1'
const PLAN = 'Мирель подходит к двери маяка, прислушивается, а потом осторожно поднимается по винтовой лестнице наверх, к фонарю — посмотреть, что там горит по ночам.'

function campaignState() {
  const hero = (id, name, x) => ({
    id, character: name, name, className: 'wizard', hp: 8, maxHp: 8, armor: 12, proficiency: 2, x, y: 0,
    abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 12, cha: 10 }, inventory: [], online: true,
  })
  return {
    state_version: 0,
    sessionCode: 'STEP-1',
    campaign: 'Маяк',
    activePlayerId: HERO,
    partyMemberIds: [HERO, 'hero-2'],
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [hero(HERO, 'Мирель', 0), hero('hero-2', 'Борин', 1)],
    enemies: [{ id: 'wolf', name: 'Волк', hp: 11, maxHp: 11, armor: 13, alive: true, x: 2, y: 0 }],
    scene: { title: 'Маяк', location: 'Маяк', mood: 'Ночь', objective: 'Узнать, что горит в фонаре', turn: 0, cells: [] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
    social: { npcs: [], relationships: {}, conversations: [], promises: [] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce',
  }
}

const { server, close } = await startGoldenServer()
try {
  const { send, exchanges } = recorder(server)
  const last = () => /** @type {any} */ (exchanges[exchanges.length - 1])
  const skip = async (role, method, path, options) => {
    const response = await send(role, method, path, options)
    last().body_norm = '<skip>'
    return response
  }
  const dialogue = (code = 'STEP-1', query = '') => `/api/campaigns/${code}/dialogue${query}`
  const why = (turn, code = 'STEP-1') => `/api/campaigns/${code}/turns/${turn}/explanation`

  // Без входа.
  await send('anon', 'GET', dialogue())
  await send('anon', 'DELETE', dialogue(), { body: {} })
  await send('anon', 'GET', why('latest'))

  // Аккаунты, кампания, приглашение на одного героя.
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } })
  await send('player', 'POST', '/api/auth/register', { body: PLAYER })
  await send('outsider', 'POST', '/api/auth/register', { body: OUTSIDER })
  await skip('admin', 'POST', '/api/campaigns', { body: { code: 'STEP-1', name: 'Маяк', state: campaignState() } })
  const invite = await send('admin', 'POST', '/api/campaigns/STEP-1/invites', { body: { hero_ids: [HERO] } })
  const inviteIndex = exchanges.length - 1
  await send('player', 'POST', '/api/campaigns/STEP-1/join', { body: { invite_token: invite.body?.token } })
  last().body = { invite_token: `<invite:${inviteIndex}>` }

  // Диалог: права и пустой диалог.
  await send('player', 'GET', dialogue())
  await send('player', 'GET', dialogue('step-1'))
  await send('player', 'GET', dialogue('STEP-1', `?actor_id=${HERO}`))
  await send('player', 'GET', dialogue('STEP-1', '?actor_id=hero-2'))
  await send('player', 'GET', dialogue('STEP-1', '?actor_id='))
  await send('outsider', 'GET', dialogue())
  await send('outsider', 'DELETE', dialogue(), { body: {} })
  await send('player', 'GET', dialogue('NOPE-1'))
  await send('admin', 'GET', dialogue('NOPE-1'))
  await send('admin', 'GET', dialogue())
  await send('admin', 'GET', dialogue('STEP-1', '?actor_id=hero-2'))
  await send('player', 'POST', dialogue(), { body: {} })
  await send('player', 'PUT', dialogue(), { body: {} })

  // План из шагов с ручным броском: уточнение и карточка первого шага.
  await skip('player', 'POST', '/api/narrate', {
    body: { campaignId: 'STEP-1', actor_id: HERO, action: PLAN, idempotency_key: 'plan', request_kind: 'action', manual_roll: true },
  })
  const restored = await send('player', 'GET', dialogue())
  const restoredIndex = exchanges.length - 1
  await send('player', 'GET', dialogue('STEP-1', '?actor_id=hero-2'))
  await send('admin', 'GET', dialogue('STEP-1', `?actor_id=${HERO}`))

  // Сброс: чужое уточнение, затем своё; карточка остаётся без уточнения.
  await send('player', 'DELETE', dialogue(), { body: { clarification_id: 'нет-такого' } })
  await send('admin', 'DELETE', dialogue('STEP-1', '?actor_id=hero-2'), { body: { clarification_id: restored.body?.clarification?.id } })
  last().body = { clarification_id: `<clarification:${restoredIndex}>` }
  await send('player', 'GET', dialogue())
  await send('player', 'DELETE', dialogue(), { body: { clarification_id: restored.body?.clarification?.id } })
  last().body = { clarification_id: `<clarification:${restoredIndex}>` }
  await send('player', 'GET', dialogue())
  await send('player', 'DELETE', dialogue(), { body: { clarification_id: restored.body?.clarification?.id } })
  last().body = { clarification_id: `<clarification:${restoredIndex}>` }
  await send('player', 'DELETE', dialogue(), { body: {} })
  await send('player', 'DELETE', dialogue(), { body: { clarification_id: '' } })

  // Объяснение хода.
  await send('player', 'GET', why('latest'))
  await skip('admin', 'POST', '/api/campaigns/STEP-1/commands', {
    body: { idempotency_key: 'why-1', message: 'Рублю волка', command: { command_type: 'ApplyDamage', actor_id: HERO, target_id: 'wolf', amount: 3, damage_type: 'slashing' } },
  })
  await skip('admin', 'POST', '/api/campaigns/STEP-1/commands', {
    body: { idempotency_key: 'why-2', command: { command_type: 'ApplyDamage', actor_id: 'wolf', target_id: HERO, amount: 2, damage_type: 'piercing' } },
  })
  await send('player', 'GET', why('latest'))
  await send('admin', 'GET', why('latest'))
  await send('outsider', 'GET', why('latest'))
  await send('player', 'GET', why('no-such-turn'))
  await send('admin', 'GET', why('latest', 'NOPE-1'))
  await send('player', 'GET', why('latest', 'NOPE-1'))
  await send('player', 'POST', why('latest'), { body: {} })
  // Дорожка трассы по id — из `latest` ведущего.
  const latest = /** @type {any} */ (await send('admin', 'GET', why('latest'))).body
  exchanges.pop()
  await send('player', 'GET', why(latest?.turn_id ?? 'missing'))
  await send('player', 'GET', `${why(latest?.turn_id ?? 'missing')}?x=1`)

  const file = writeGolden('c15', 'диалог героя (уточнение и карточка проверки, сброс) и объяснение хода: права, проекция, 404', exchanges)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  await close()
}
