// Эталон «Г» кампаний, членства и рекапа (С6):
// `node rust/crates/sk-server/fixtures/gen-c6.mjs` пишет `fixtures/c6.json`;
// сверка — `tests/c6_golden.rs`.
//
// Отличия от общего формата `skazanie.golden/1` (сверку делает свой прогон
// в `tests/c6_golden.rs`, правила те же):
// * токен приглашения случаен: в теле запроса входа он записан ссылкой
//   `<invite:N>` — «токен из ответа обмена N»; прогон подставляет свой;
// * большие ветви тела (состояние кампании из мастера создания) — хешем, см.
//   `shrink` (как в `gen-c4.mjs`);
// * кости сервера — правила `DICE` (тот же JSON читает Rust-набор);
// * время строки летописи `timestamp: "ЧЧ:ММ"` (вступление мастера) — `<clock>`:
//   оно зависит от минуты прогона (см. `clock`).
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'

import { recorder, startGoldenServer, writeGolden } from './golden.mjs'

export const DICE = { format: 'skazanie.test-dice/1', rules: [{ value: 2 }] }

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const OWNER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const GUEST = { email: 'boris@mail.ru', password: 'длинный-пароль', name: 'Борис' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }
const BIG_BODY = 32_000
const CLOCK = /^\d{2}:\d{2}$/u

/**
 * Маска времени строк летописи: поле `timestamp` вида `ЧЧ:ММ` — `<clock>`.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function clock(value) {
  if (Array.isArray(value)) return value.map(clock)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'timestamp' && typeof item === 'string' && CLOCK.test(item) ? '<clock>' : clock(item)]))
  }
  return value
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function shrink(value) {
  const text = JSON.stringify(value)
  if (text === undefined || text.length <= BIG_BODY || value === null || typeof value !== 'object') return value
  const parts = Array.isArray(value) ? value.map(shrink) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item)]))
  if (JSON.stringify(parts).length <= BIG_BODY) return parts
  return `<sha256:${createHash('sha256').update(text).digest('hex')}:${text.length}>`
}

/** Готовое состояние для импорта администратором. */
function importedState(code, extra = {}) {
  return {
    sessionCode: code,
    campaign: `Импорт ${code}`,
    partyName: 'Двое из ларца',
    players: [
      { id: 'hero-ivan', character: 'Иван', name: 'Иван', hp: 10, maxHp: 10, x: 0, y: 0 },
      { id: 'hero-ada', character: 'Ada', name: 'Ada', hp: 8, maxHp: 8, x: 1, y: 0, characterSetupRequired: false },
    ],
    messages: [],
    campaignConcept: { era: 'Средневековье', genre: 'Фэнтези' },
    scene: { title: 'Начало', location: 'Таверна', mood: '', objective: '', turn: 0, cells: [] },
    ...extra,
  }
}

const { server, close } = await startGoldenServer({ dice: DICE })
try {
  const { send, exchanges } = recorder(server)
  /** Вход по приглашению: тело с токеном из ответа обмена `index`. */
  const join = async (role, code, index) => {
    const token = /** @type {any} */ (exchanges[index]).raw_token
    await send(role, 'POST', `/api/campaigns/${code}/join`, { body: { invite_token: token } })
    Object.assign(exchanges[exchanges.length - 1], { body: { invite_token: `<invite:${index}>` } })
  }
  /** Приглашение: запомнить сырой токен для последующего входа. */
  const invite = async (role, code, body = {}) => {
    const response = await send(role, 'POST', `/api/campaigns/${code}/invites`, { body })
    Object.assign(exchanges[exchanges.length - 1], { raw_token: response.body?.token ?? null })
    return exchanges.length - 1
  }

  // Без входа.
  await send('anon', 'GET', '/api/campaigns')
  await send('anon', 'GET', '/api/heroes')
  await send('anon', 'POST', '/api/campaigns', { body: { code: 'ANON-1' } })
  await send('anon', 'POST', '/api/campaigns/ANON-1/invites', { body: {} })
  await send('anon', 'POST', '/api/campaigns/ANON-1/join', { body: {} })
  await send('anon', 'GET', '/api/campaigns/ANON-1/recap')
  // Аккаунты.
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } })
  await send('owner', 'POST', '/api/auth/register', { body: OWNER })
  await send('guest', 'POST', '/api/auth/register', { body: GUEST })
  await send('outsider', 'POST', '/api/auth/register', { body: OUTSIDER })
  await send('owner', 'GET', '/api/campaigns')
  await send('owner', 'GET', '/api/heroes')
  await send('admin', 'GET', '/api/heroes')
  await send('admin', 'GET', '/api/campaigns?x=1')

  // Отказы создания до мастера.
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'ab' } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'bad code!' } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1' } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 0 } } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 6 } } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 'два' } } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 2 }, state: { players: [] } } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 2, ruleset_version: null } } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 2, enabledRulePacks: [] } } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 2, worldMap: {} } } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { players: [{}, {}, {}, {}, {}, {}] } } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 1, rulesetId: 'nope' } } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 1, campaignMode: 'sandbox' } } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 1, worldTemplateId: 'invented-world' } } })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 1, players: [{ id: 'bad id!' }] } } })
  await send('owner', 'POST', '/api/campaigns', { body: [] })

  // Мастер создания: игрок на двоих, авторский мир — на одного.
  await send('owner', 'POST', '/api/campaigns', {
    body: { code: 'tale-1', name: 'Сказ о мосте', bootstrap: { partyName: 'Двое', slotCount: 2, rulesetId: 'srd_5_2_1', world: { premise: 'Мост через реку сожгли', startingLocation: 'Переправа' } } },
  })
  await send('owner', 'POST', '/api/campaigns', { body: { code: 'TALE-1', bootstrap: { slotCount: 1 } } })
  await send('outsider', 'POST', '/api/campaigns', {
    body: { code: 'TIDE-1', name: '', bootstrap: { partyName: '', slotCount: 1, rulesetId: 'srd_5_2_1', worldTemplateId: 'league-nine-tides', world: {} } },
  })
  // Администратор: импорт состояния, его отказы, мастер с пустыми местами и с героями.
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'IMPORT-1', name: 'Импорт', state: importedState('IMPORT-1', { enabled_house_rules: ['flanking', 7] }) } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'IMPORT-2', state: importedState('IMPORT-2', { ruleset_version: '9.9' }) } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'IMPORT-2', state: importedState('IMPORT-2', { enabled_rule_packs: ['other'] }) } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'IMPORT-2', state: importedState('IMPORT-2', { ruleset_id: 'nope' }) } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'IMPORT-2', state: importedState('IMPORT-2', { campaignConcept: { campaign_mode: 'sandbox' } }) } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'IMPORT-3', state: importedState('IMPORT-3', { ruleset_id: 'dnd_5e_2014' }) } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'EMPTY-1', name: 'Пустая' } })
  await send('admin', 'POST', '/api/campaigns', { body: { code: 'SEATS-1', bootstrap: { partyName: 'Места', slotCount: 3, world: {} } } })

  // Приглашения: только владелец и администратор, свободные места.
  await send('guest', 'POST', '/api/campaigns/TALE-1/invites', { body: {} })
  await send('owner', 'POST', '/api/campaigns/NOPE-1/invites', { body: {} })
  await send('owner', 'POST', '/api/campaigns/TALE-1/invites', { body: { hero_ids: ['hero-slot-1'] } })
  await send('owner', 'POST', '/api/campaigns/TALE-1/invites', { body: { hero_ids: ['hero-nope'] } })
  const taleInvite = await invite('owner', 'tale-1', { expires_in_ms: 120_000 })
  const importInvite = await invite('admin', 'IMPORT-1')
  await send('admin', 'POST', '/api/campaigns/IMPORT-1/invites', { body: { hero_ids: ['hero-ada'] } })
  await send('admin', 'POST', '/api/campaigns/EMPTY-1/invites', { body: {} })

  // Вход: без токена, чужой токен, свой, повтор, место занято.
  await send('guest', 'POST', '/api/campaigns/TALE-1/join', { body: {} })
  await send('guest', 'POST', '/api/campaigns/TALE-1/join', { body: { inviteToken: 'не-тот-токен' } })
  await send('guest', 'POST', '/api/campaigns/NOPE-1/join', { body: { invite_token: 'x' } })
  await join('guest', 'TALE-1', importInvite)
  await join('guest', 'tale-1', taleInvite)
  await join('guest', 'TALE-1', taleInvite)
  await join('outsider', 'TALE-1', taleInvite)
  await join('outsider', 'IMPORT-1', importInvite)
  await send('owner', 'POST', '/api/campaigns/TALE-1/invites', { body: {} })

  // Списки после членства.
  await send('owner', 'GET', '/api/campaigns')
  await send('guest', 'GET', '/api/campaigns')
  await send('outsider', 'GET', '/api/campaigns')
  await send('admin', 'GET', '/api/campaigns')
  await send('admin', 'GET', '/api/heroes')

  // Рекап: без перерыва — `no_gap`; чужим — 403; нет кампании — 404.
  await send('owner', 'GET', '/api/campaigns/tale-1/recap')
  await send('guest', 'GET', '/api/campaigns/TALE-1/recap')
  await send('outsider', 'GET', '/api/campaigns/TALE-1/recap')
  await send('admin', 'GET', '/api/campaigns/IMPORT-1/recap')
  await send('owner', 'GET', '/api/campaigns/NOPE-1/recap')
  await send('owner', 'POST', '/api/campaigns/TALE-1/recap', { body: {} })

  for (const entry of /** @type {any[]} */ (exchanges)) {
    entry.body_norm = shrink(clock(entry.body_norm))
    delete entry.raw_token
  }
  const file = writeGolden('c6', 'кампании: список, герои, создание мастером и импортом, приглашения, вход, рекап', exchanges)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
} finally {
  await close()
}
