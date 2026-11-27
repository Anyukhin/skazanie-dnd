// Эталон «Г» структурированных команд стола (С18.1):
// `node rust/crates/sk-server/fixtures/gen-c18-1.mjs` пишет
// `fixtures/c18-1.json`; сверка — `tests/c18_1_golden.rs`.
//
// Сценарий: права и форма запроса (401, 404, 403, 400), запреты серверных
// команд (`AdvanceScene`, `CreateEncounter`, жизненный цикл торговца),
// подделанный бросок, чужой герой, смешанный пакет атаки; бой — начало
// (инициатива сервера), атака, повтор ключа и конфликт под тем же ключом,
// конец хода с ходом врага; реакция заклинанием в открытом окне реакции
// (пауза боя) и её повтор; ручной бросок в две фазы (карточка проверки →
// `/api/roll` → `roll_id`), повтор второй фазы и тот же бросок под чужим
// ключом. В конце — комната кампании боя (летопись хода).
//
// Правила сверх общего формата `skazanie.golden/1`:
// * псевдообмен `ASSIGN` — назначить игроку героев (`body` — список id)
//   через `GET /api/admin/users` + `PATCH /api/admin/users/:id`: id
//   пользователя случаен, поэтому путь в эталон не пишется;
// * псевдообмен `ROLL` — `POST /api/roll` по `check_id` из ответа обмена
//   `body.from` (номер), полученный `roll_id` подставляется вместо
//   `"<roll:N>"` в телах следующих запросов;
// * время строк летописи `ЧЧ:ММ` — `<clock>`; id бросков — `<uuid>`;
// * большие ветви тела — `<sha256:хеш:длина>` от JSON с ключами по алфавиту;
// * кости сервера — правила `DICE` (тот же JSON читает Rust-набор).
import '../../../fixtures-env.mjs'

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { normalize, recorder, startGoldenServer, writeGolden } from './golden.mjs'

export const DICE = {
  format: 'skazanie.test-dice/1',
  rules: [
    { actor: '^hero$', purpose: '^initiative$', sides: 20, value: 18 },
    { actor: '^hero$', sides: 20, value: 15 },
    { actor: '^hero$', value: 'max' },
    { sides: 20, value: 6 },
    { value: 'min' },
  ],
}

const ADMIN = { email: 'gm@mail.ru', password: 'длинный-пароль', name: 'Ведущий' }
const PLAYER = { email: 'anya@mail.ru', password: 'длинный-пароль', name: 'Аня' }
const OUTSIDER = { email: 'vera@mail.ru', password: 'длинный-пароль', name: 'Вера' }
const BIG_BODY = 4_000
const CLOCK = /^\d{2}:\d{2}$/u

/** @param {number} width @param {number} height */
function cells(width, height) {
  const grid = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) grid.push({ x, y, type: 'floor', passable: true, revealed: true })
  }
  return grid
}

function economy() {
  return { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
}

/** Бой: герой против стража, вне боя. */
export function combatState() {
  return {
    sessionCode: 'CMD-1',
    campaign: 'Команды стола',
    partyName: 'Отряд',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'hero', name: 'Аня', character: 'Астер', hp: 60, maxHp: 60, armor: 18, speed: 30, proficiency: 2,
      abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 },
      inventory: [], online: true, x: 0, y: 1,
      attackBonus: 7, damageDice: 6, damageBonus: 2, damageType: 'slashing', attackRange: 5,
    }],
    enemies: [{
      id: 'sentinel', name: 'Каменный страж', hp: 60, maxHp: 60, armor: 11, speed: 30,
      attackBonus: 4, damageDice: 4, damageBonus: 1, damageType: 'bludgeoning', attackRange: 5,
      abilities: { str: 14, dex: 12, con: 14, int: 6, wis: 10, cha: 5 }, proficiency: 2, x: 1, y: 1, alive: true,
    }],
    scene: { title: 'Арена', location: 'Арена', mood: '', objective: 'Проверить команды', turn: 1, grid: { width: 8, height: 3 }, cells: cells(8, 3) },
    tacticalTurn: { sceneTurn: 1, actorId: 'hero', movementSpent: 0, actionUsed: false },
    adventure: { chapter: 1, history: [], visitedLocations: ['Арена'] },
    engine_mode: 'enforce',
  }
}

/** Открытое окно реакции: удар врага попал, у ведьмы — «Искусная острота». */
export function reactionState() {
  return {
    sessionCode: 'CMD-2',
    campaign: 'Реакция',
    partyName: 'Отряд',
    partyMemberIds: ['hero', 'ally'],
    activePlayerId: 'enemy',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [
      {
        id: 'hero', name: 'Аня', character: 'Ведьма', characterClass: 'wizard', level: 3,
        hp: 30, maxHp: 30, armor: 14, speed: 30, proficiency: 2,
        abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 10 },
        knownSpellIds: ['silvery-barbs'], preparedSpellIds: ['silvery-barbs'], inventory: [], x: 1, y: 1,
      },
      {
        id: 'ally', name: 'Союзник', character: 'Лира', characterClass: 'fighter', level: 3,
        hp: 30, maxHp: 30, armor: 16, speed: 30, proficiency: 2,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        inventory: [], x: 1, y: 2,
      },
    ],
    enemies: [{
      id: 'enemy', name: 'Враг', characterClass: 'fighter', level: 3,
      hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 2,
      abilities: { str: 14, dex: 12, con: 12, int: 8, wis: 8, cha: 8 },
      attackBonus: 4, damageDice: 4, damageBonus: 1, attackRange: 5,
      inventory: [], x: 3, y: 1, alive: true,
    }],
    scene: { turn: 1, title: 'Полигон реакций', location: 'reaction-http', cells: cells(8, 3) },
    mechanics: {
      resources: { hero: { spell_slots_1: { current: 4, max: 4 } } },
      conditions: { ally: [{ id: 'silvery-fortune', effect_id: 'older-silvery-barbs', source_actor: 'ally', duration: 'rounds:10' }] },
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'enemy', total: 20 }, { actor_id: 'hero', total: 12 }, { actor_id: 'ally', total: 10 }],
        active_index: 0,
        action_economy: { enemy: economy(), hero: economy(), ally: economy() },
        reaction_window: {
          id: 'reaction-http-silvery',
          trigger: 'attack-hit',
          actor_id: 'hero',
          source_actor_id: 'enemy',
          target_id: 'hero',
          action_ids: ['cast:silvery-barbs'],
          action_options: [{
            id: 'cast:silvery-barbs', name: 'Искусная острота', description: 'Перебросить попадание.',
            resource: 'spell_slots_1', slot_level: 1, cost: 1, requires_beneficiary: true,
          }],
          damage: { applied_amount: 3, damage_type: 'slashing', hp_before: 30, hp_after: 27 },
          trigger_roll: { kept: 18, modifier: 4, total: 22, armor_class: 12, hit: true, critical: false },
        },
      },
    },
    engine_mode: 'enforce',
  }
}

/** Переговоры в разгаре боя: проверка проходит при любом кубике. */
export function parleyState() {
  const bandit = (id, name, x, y, hp, alive) => ({
    id, name, hp, maxHp: 11, armor: 12, speed: 30, x, y, alive,
    creature_type: 'humanoid', stat_block_id: 'srd_5_2_1:bandit', provenance: { xp: 25 },
    attackBonus: 3, damageDice: 6, damageBonus: 1,
  })
  return {
    sessionCode: 'CMD-3',
    campaign: 'Переговоры',
    partyName: 'Отряд',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    engine_mode: 'enforce',
    isNarrating: false,
    pendingCheck: null,
    messages: [],
    scene: { title: 'Тракт', location: 'Разбитый тракт', location_id: 'road', mood: '', objective: '', turn: 2, grid: { width: 8, height: 8 }, cells: cells(8, 8) },
    players: [{
      id: 'hero', name: 'Аня', character: 'Ада', hp: 48, maxHp: 48, armor: 12, speed: 30, x: 1, y: 1, level: 9,
      abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 12, cha: 18 },
      proficiency: 4, backgroundSkillProficiencies: ['persuasion'], inventory: [], online: true,
    }],
    worldMap: { seed: 'cmd-3', locations: [{ id: 'road', name: 'Разбитый тракт', kind: 'wilds', x: 100, y: 300 }], routes: [] },
    enemies: [
      bandit('enemy-leader', 'Разбойник 1', 2, 1, 1, true),
      bandit('enemy-fallen-1', 'Разбойник 2', 5, 2, 0, false),
      bandit('enemy-fallen-2', 'Разбойник 3', 5, 3, 0, false),
      bandit('enemy-fallen-3', 'Разбойник 4', 5, 4, 0, false),
    ],
    social: { npcs: [] },
    mechanics: {
      world_time: { amount: 0, unit: 'minute', elapsed_minutes: 0 },
      combat: {
        active: true,
        round: 2,
        initiative: [{ actor_id: 'hero', total: 18 }, { actor_id: 'enemy-leader', total: 9 }],
        active_index: 0,
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement_spent: 0 } },
      },
    },
  }
}

/** `JSON.stringify` с ключами по алфавиту. @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(/** @type {any} */ (value)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Большие ветви — хешем канонического текста. @param {unknown} value @returns {unknown} */
export function shrink(value) {
  if (value === null || typeof value !== 'object') return value
  const text = canonical(value)
  if (text.length <= BIG_BODY) return value
  const parts = Array.isArray(value) ? value.map(shrink) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrink(item)]))
  if (canonical(parts).length <= BIG_BODY) return parts
  return `<sha256:${createHash('sha256').update(text).digest('hex')}:${text.length}>`
}

/** Время строк летописи — `<clock>`. @param {unknown} value @returns {unknown} */
function clock(value) {
  if (Array.isArray(value)) return value.map(clock)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'timestamp' && typeof item === 'string' && CLOCK.test(item) ? '<clock>' : clock(item)]))
  }
  // Формулировка шага выбирается по `event_id` события (`combat-phrases.mjs`,
  // `phraseSeed`), а id шага — случайный uuid: у JS и Rust (и у двух прогонов
  // JS) вариант разный. Сверяется расстояние, а не глагол.
  if (typeof value === 'string') return value.replace(MOVE_PHRASE, '<move:$1>')
  return value
}

const MOVE_PHRASE = /(?:перемещается на|проходит|смещается на) (\d+) фт\./gu

/**
 * Строки боя: формулировку («бьёт»/«рубит», «использует»/«отвечает
 * реакцией») выбирает `Phrasebook` по `event_id`, а id событий движка —
 * случайные uuid, поэтому текст строки «Системы боя» разный у двух прогонов
 * даже одного JS. Сверяются id, голос и `turnConsumed` строки, а её текст и
 * `narration` голосом системы — `<combat-line>`.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function combatLines(value) {
  if (Array.isArray(value)) return value.map(combatLines)
  if (value && typeof value === 'object') {
    const entry = /** @type {Record<string, unknown>} */ (value)
    return Object.fromEntries(Object.entries(entry).map(([key, item]) => {
      if (key === 'text' && entry.speaker === 'system' && typeof item === 'string') return [key, '<combat-line>']
      if (key === 'narration' && entry.narration_speaker === 'system' && typeof item === 'string') return [key, '<combat-line>']
      return [key, combatLines(item)]
    }))
  }
  return value
}

/** Тело ответа для эталона. @param {unknown} body */
export function bodyNorm(body) {
  const full = combatLines(clock(normalize(body)))
  dumped.push(full)
  return shrink(full)
}

/** Тела без `shrink` для `C18_1_DUMP=<файл>` (сверка расхождений по хешам). */
const dumped = []

/** @param {unknown} value @param {Map<number, string>} rolls @returns {unknown} */
function withRolls(value, rolls) {
  if (Array.isArray(value)) return value.map((item) => withRolls(item, rolls))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withRolls(item, rolls)]))
  if (typeof value === 'string') {
    const match = /^<roll:(\d+)>$/u.exec(value)
    if (match) return rolls.get(Number(match[1])) ?? value
  }
  return value
}

const { server, close } = await startGoldenServer({ dice: DICE })
try {
  const { send, exchanges } = recorder(server)
  /** @type {Map<number, string>} */
  const rolls = new Map()
  /** @type {Map<number, any>} */
  const raw = new Map()
  const commands = (code) => `/api/campaigns/${code}/commands`
  async function command(role, code, body, headers) {
    const response = await send(role, 'POST', commands(code), { body: withRolls(body, rolls), headers })
    const entry = /** @type {any} */ (exchanges[exchanges.length - 1])
    entry.body = body
    raw.set(exchanges.length - 1, response.body)
    entry.body_norm = bodyNorm(response.body)
    return response
  }
  async function assign(email, heroIds) {
    const admin = await send('admin', 'GET', '/api/admin/users')
    exchanges.pop()
    const user = admin.body.users.find((candidate) => candidate.email === email)
    const patched = await send('admin', 'PATCH', `/api/admin/users/${user.id}`, { body: { heroIds } })
    exchanges.pop()
    exchanges.push({ as: 'admin', method: 'ASSIGN', path: email, headers: {}, body: heroIds, status: patched.status, body_norm: null })
  }
  async function roll(role, from, code) {
    const check = raw.get(from)?.check
    const response = await send(role, 'POST', '/api/roll', { body: { campaignId: code, playerId: check?.actor_id ?? 'hero', checkId: check?.check_id } })
    exchanges.pop()
    rolls.set(exchanges.length, String(response.body?.roll_id ?? ''))
    exchanges.push({ as: role, method: 'ROLL', path: code, headers: {}, body: { from }, status: response.status, body_norm: bodyNorm(response.body) })
  }

  // Аккаунты и кампании.
  await send('admin', 'POST', '/api/auth/setup-admin', { body: { ...ADMIN, setupToken: 'setup-code' } })
  await send('player', 'POST', '/api/auth/register', { body: PLAYER })
  await send('outsider', 'POST', '/api/auth/register', { body: OUTSIDER })
  for (const [code, state] of [['CMD-1', combatState()], ['CMD-2', reactionState()], ['CMD-3', parleyState()]]) {
    await send('admin', 'POST', '/api/campaigns', { body: { code, name: state.campaign, state } })
    Object.assign(exchanges[exchanges.length - 1], { body_norm: '<c6>' })
  }
  await assign(PLAYER.email, ['hero', 'ally'])

  // Права и форма запроса.
  await command('anon', 'CMD-1', { command: { command_type: 'StartCombat', actor_id: 'hero' } })
  await command('player', 'NOPE-1', { command: { command_type: 'StartCombat', actor_id: 'hero' } })
  await command('outsider', 'CMD-1', { command: { command_type: 'StartCombat', actor_id: 'hero' } })
  await command('player', 'CMD-1', {})
  await command('player', 'CMD-1', { commands: [] })
  await command('player', 'CMD-1', { command: { command_type: 'AdvanceScene', actor_id: 'hero' } })
  await command('admin', 'CMD-1', { command: { command_type: 'AdvanceScene', actor_id: 'hero' } })
  await command('admin', 'CMD-1', { command: { command_type: 'CreateEncounter', actor_id: 'hero' } })
  await command('admin', 'CMD-1', { command: { command_type: 'CreateMerchant', actor_id: 'hero' } })
  await command('player', 'CMD-1', { idempotency_key: 'forged', roll: { total: 30 }, command: { command_type: 'StartCombat', actor_id: 'hero' } })
  await command('player', 'CMD-1', { idempotency_key: 'foreign', command: { command_type: 'StartCombat', actor_id: 'sentinel' } })
  await command('player', 'CMD-1', { idempotency_key: 'mixed', commands: [
    { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'sentinel' },
    { command_type: 'EndTurn', actor_id: 'hero' },
  ] })
  await command('player', 'CMD-1', { idempotency_key: 'rest-batch', commands: [
    { command_type: 'StartRest', actor_id: 'hero', kind: 'short' },
    { command_type: 'EndTurn', actor_id: 'hero' },
  ] })

  // Бой: начало, атака, повтор и конфликт ключа, конец хода.
  await command('player', 'CMD-1', { idempotency_key: 'start-1', command: { command_type: 'StartCombat', actor_id: 'hero' } })
  await command('player', 'CMD-1', { idempotency_key: 'start-1', command: { command_type: 'StartCombat', actor_id: 'hero' } })
  await command('player', 'CMD-1', { idempotency_key: 'attack-1', message: 'Рублю стража!', player_note: 'За отряд!', command: { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'sentinel' } })
  await command('player', 'CMD-1', { idempotency_key: 'attack-1', command: { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'sentinel' } })
  await command('player', 'CMD-1', { idempotency_key: 'attack-1', command: { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'ghost' } })
  await command('player', 'CMD-1', { idempotency_key: 'attack-1', command: { command_type: 'EndTurn', actor_id: 'hero' } })
  await command('player', 'CMD-1', { idempotency_key: 'end-1', command: { command_type: 'EndTurn', actor_id: 'hero' } })
  await command('player', 'CMD-1', { command: { command_type: 'MakeAttack', actor_id: 'hero', target_id: 'sentinel' } }, { 'x-idempotency-key': 'attack-2' })

  // Реакция в открытом окне (пауза боя) и её повтор.
  const reaction = { command_type: 'UseCombatAction', actor_id: 'hero', action_id: 'cast:silvery-barbs', target_id: 'enemy', beneficiary_id: 'ally' }
  await command('player', 'CMD-2', { idempotency_key: 'react-1', message: 'Передать преимущество союзнику', command: reaction })
  await command('player', 'CMD-2', { idempotency_key: 'react-1', message: 'Передать преимущество союзнику', command: reaction })

  // Ручной бросок в две фазы.
  const parley = { command_type: 'ProposeParley', actor_id: 'hero', skill: 'persuasion' }
  await command('player', 'CMD-3', { idempotency_key: 'parley-1', manual_roll: true, command: parley })
  const announced = exchanges.length - 1
  await roll('player', announced, 'CMD-3')
  const rolled = exchanges.length - 1
  await command('player', 'CMD-3', { idempotency_key: 'parley-2', roll: { roll_id: `<roll:${rolled}>` }, command: parley })
  await command('player', 'CMD-3', { idempotency_key: 'parley-2', roll: { roll_id: `<roll:${rolled}>` }, command: parley })
  await command('player', 'CMD-3', { idempotency_key: 'parley-3', roll: { roll_id: `<roll:${rolled}>` }, command: parley })

  // Комната кампании боя: летопись хода. Часы хода (`turn_clock`) ставит
  // координатор автохода боя — у Rust его ещё нет (С17), поле снято.
  const room = await send('player', 'GET', '/api/rooms/CMD-1')
  const { turn_clock: _turnClock, ...roomState } = room.body.state
  exchanges[exchanges.length - 1].body_norm = bodyNorm({ ...room.body, state: roomState })

  const file = writeGolden('c18-1', 'POST /api/campaigns/:id/commands: права, запреты, атомарность, бой, повтор и конфликт ключа, реакция, ручной бросок в две фазы, летопись', exchanges)
  console.log(`эталон: ${file} (${exchanges.length} обменов)`)
  if (process.env.C18_1_DUMP) writeFileSync(process.env.C18_1_DUMP, JSON.stringify(dumped, null, 2))
} finally {
  await close()
}
