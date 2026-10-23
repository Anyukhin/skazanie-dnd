import '../../../fixtures-env.mjs'
// Эталон «Г» С16: санитайзеры и отпечатки команд `/commands`.
//
//   node rust/crates/sk-server/fixtures/gen-c16.mjs
//
// Пишет `fixtures/command-guard.json`; сверка — `tests/command_guard_golden.rs`.
//
// Функции не экспортированы из `server/index.mjs`, а импорт файла поднимает
// сервер. Поэтому генератор вырезает их исходники по диапазонам строк
// (`RANGES`) и собирает через `new Function` с заглушками зависимостей:
// членство (`campaignHasMemberships`), журнал (`eventStore`) и социальный
// движок (`npcSocialController`) — управляемые случаем. Остальные
// зависимости — настоящие модули `server/`. Хеш `index.mjs` (с LF) закреплён:
// при правке файла диапазоны надо проверить заново и обновить хеш.
//
// Входы: команды корпуса `Dnd-narrator-live/tmp/corpus-v1` (очищенные от
// серверных полей) и их мутации — чужой герой, недоверенные поля пути,
// дальности и цели, мусорные значения, ключи прототипа, camelCase; синтетика
// по каждому типу; события корпуса для отпечатков итога. Каждый случай
// исполняется на JSON-копии входа (как его увидит Rust). Состояние урезано до
// полей, которые читают санитайзеры; урезанное проверено тем же исходом.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../../../../', import.meta.url)
const FIXTURE = new URL('./command-guard.json', import.meta.url)
const CORPUS_DIR = 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
const SOURCE_SHA256 = '38a9beb4c29f2385b63e97a076affb4d4d3690c24d5f72e9033fce7422f51552'
const RANGES = [[510, 526], [528, 993], [1247, 2069]]

const sha = (text) => createHash('sha256').update(text).digest('hex')
const source = readFileSync(new URL('server/index.mjs', root), 'utf8').replace(/\r\n/gu, '\n')
if (sha(source) !== SOURCE_SHA256) {
  throw new Error(`server/index.mjs изменился (sha256 ${sha(source)}): проверьте диапазоны ${JSON.stringify(RANGES)} и обновите SOURCE_SHA256`)
}
const sourceLines = source.split('\n')
const body = RANGES.map(([from, to]) => sourceLines.slice(from - 1, to).join('\n')).join('\n')

const mod = async (name) => import(new URL(`server/${name}`, root).href)
const { isPartySummon } = await mod('combat-spells.mjs')
const { npcCombatRequestFingerprint } = await mod('rules-engine.mjs')
const { CAPTIVE_PLAYER_COMMAND_TYPES } = await mod('captives.mjs')
const { BEAST_PLAYER_COMMAND_TYPES } = await mod('beast-taming.mjs')
const { MAX_LOOT_LINES } = await mod('loot-containers.mjs')
const { TAVERN_COMMAND_TYPES, TAVERN_DICE_APPROACHES, TAVERN_STAKES_CP } = await mod('tavern-life.mjs')
const { BLESSING_COMMAND_TYPES } = await mod('blessings.mjs')
const { DIALOGUE_COMMAND_TYPE } = await mod('campaign-dialogues.mjs')
const courier = await mod('courier-letters.mjs')

// --- управляемые заглушки ---------------------------------------------------------------

const env = { memberships: false, calls: [], duplicate: null, model: false, reply: null, respond: [] }
function campaignHasMemberships(campaignId) {
  env.calls.push(String(campaignId))
  if (env.memberships === 'throw') throw Object.assign(new Error('Некорректный код кампании'), { code: 'INVALID_CAMPAIGN_ID' })
  return env.memberships === true
}
const eventStore = {
  async getByIdempotencyKey() {
    if (env.duplicate === 'throw') throw Object.assign(new Error('Журнал недоступен'), { code: 'STORE_UNAVAILABLE' })
    return env.duplicate == null ? null : structuredClone(env.duplicate)
  },
}
const npcSocialController = {
  get llmClient() { return env.model ? {} : null },
  async respond(input) {
    env.respond.push({ playerId: input.playerId ?? null, npcId: input.npcId ?? null, message: input.message, turnId: input.turnId, state: input.state === env.state })
    if (env.reply === 'throw') throw new Error('провайдер молчит')
    return env.reply == null ? null : structuredClone(env.reply)
  },
}

const DEPS = {
  createHash, campaignHasMemberships, eventStore, npcSocialController, isPartySummon, npcCombatRequestFingerprint,
  CAPTIVE_PLAYER_COMMAND_TYPES, BEAST_PLAYER_COMMAND_TYPES, MAX_LOOT_LINES, TAVERN_COMMAND_TYPES, TAVERN_DICE_APPROACHES, TAVERN_STAKES_CP,
  BLESSING_COMMAND_TYPES, DIALOGUE_COMMAND_TYPE,
  COURIER_LETTER_ADDRESSEE_KINDS: courier.COURIER_LETTER_ADDRESSEE_KINDS, COURIER_LETTER_BODY_LIMIT: courier.COURIER_LETTER_BODY_LIMIT,
  COURIER_LETTER_COMMAND_TYPES: courier.COURIER_LETTER_COMMAND_TYPES, courierAddresseeFor: courier.courierAddresseeFor,
  courierToneFor: courier.courierToneFor, courierLetterPromiseFrom: courier.courierLetterPromiseFrom,
}
const EXPORTS = [
  'canUseHero', 'commandType', 'lootTakenRecordFor', 'merchantCommandFingerprint', 'itemCommandFingerprint', 'makeAttackCommandFingerprint',
  'authoritativeCombatCommandBase', 'normalizeMakeAttackCommand', 'makeAttackEventFingerprints', 'assertMakeAttackIdempotency',
  'assertMakeAttackResultFingerprint', 'assertNpcCombatActorPermission', 'sanitizePlayerNpcCombatCommand', 'assertNpcCombatIdempotency',
  'assertNpcCombatResultFingerprint', 'restCommandFingerprint', 'assertRestIdempotency', 'assertRestResultFingerprint', 'assertItemIdempotency',
  'assertItemResultFingerprint', 'lootCommandFingerprint', 'assertLootIdempotency', 'assertLootResultFingerprint', 'characterBuildFingerprint',
  'assertCharacterBuildResultFingerprint', 'combatActorFor', 'assertPlayerCombatActorPermission', 'sanitizePlayerCombatCommand',
  'sanitizePlayerRestCommand', 'expandPlayerRestCommand', 'sanitizePlayerCharacterCommand', 'sanitizePlayerPickpocketCommand',
  'sanitizePlayerCaptiveCommand', 'sanitizePlayerLootCommand', 'sanitizePlayerBeastCommand', 'sanitizePlayerLawCommand',
  'sanitizePlayerTavernCommand', 'sanitizePlayerBlessingCommand', 'sanitizePlayerDialogueCommand', 'sanitizePlayerLetterCommand',
  'withCourierReplyDraft', 'sanitizePlayerItemCommand', 'sanitizeMerchantCommand',
]
const SET_NAMES = [
  'PUBLIC_DIE_SIDES', 'PLAYER_COMBAT_COMMANDS', 'PLAYER_NPC_COMBAT_COMMANDS', 'PLAYER_REST_COMMANDS', 'PLAYER_CHARACTER_COMMANDS',
  'PLAYER_CHARACTER_LIFECYCLE_COMMANDS', 'PLAYER_ITEM_COMMANDS', 'PLAYER_MERCHANT_COMMANDS', 'PLAYER_PICKPOCKET_COMMANDS',
  'PLAYER_CAPTIVE_COMMANDS', 'PLAYER_BEAST_COMMANDS', 'PLAYER_LAW_COMMANDS', 'PLAYER_LOOT_COMMANDS', 'LOOT_STALE_ERROR_CODES',
  'PLAYER_TAVERN_COMMANDS', 'PLAYER_LETTER_COMMANDS', 'PLAYER_BLESSING_COMMANDS', 'PLAYER_DIALOGUE_COMMANDS',
  'ADMIN_MERCHANT_LIFECYCLE_COMMANDS', 'SERVER_WORLD_COMMANDS', 'SERVER_ENCOUNTER_COMMANDS', 'NPC_COMBAT_PRIMARY_EVENT_TYPES',
  'REST_PRIMARY_EVENT_TYPES', 'ITEM_PRIMARY_EVENT_TYPES', 'LOOT_PRIMARY_EVENT_TYPES',
]
// eslint-disable-next-line no-new-func
const factory = new Function(...Object.keys(DEPS), `'use strict'\n${body}\nreturn { fns: { ${EXPORTS.join(', ')} }, sets: { ${SET_NAMES.join(', ')} } }`)
const { fns: F, sets: SETS } = factory(...Object.values(DEPS))

// --- случаи ------------------------------------------------------------------------------

const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const isPlain = (value) => value && typeof value === 'object' && !Array.isArray(value)
const states = new Map()
const stateIds = new Map()
const fullStates = new Map()
const cases = []
const seenCases = new Set()
let excludedLoneSurrogate = 0
let trimmedFallbacks = 0

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(2026_10_23)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p
/** Первый вариант (штатный путь) и ещё два случайных. */
const sample = (items) => [items[1] ?? items[0], ...[...items].sort(() => random() - 0.5).slice(0, 2)]

/** Состояние в таблицу: id по хешу содержимого. */
function stateRef(state) {
  const text = JSON.stringify(state)
  const key = sha(text)
  if (!stateIds.has(key)) {
    const id = `s${stateIds.size}`
    stateIds.set(key, id)
    states.set(id, JSON.parse(text))
  }
  return { $state: stateIds.get(key) }
}

const users = new Map()
/** Пользователь в таблицу: те же объекты повторяются тысячи раз. */
function userRef(user) {
  const text = JSON.stringify(user)
  if (!users.has(text)) users.set(text, `u${users.size}`)
  return { $user: users.get(text) }
}

const ACTOR_KEYS = ['id', 'actor_id', 'kind', 'faction', 'ownerId', 'owner_id', 'controllerId', 'controller_id', 'name', 'character']
const pickKeys = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)))
const trimActors = (list) => (Array.isArray(list) ? list.map((actor) => (isPlain(actor) ? pickKeys(actor, ACTOR_KEYS) : actor)) : list)
/** Поля, которые читают санитайзеры (без почты: ей — всё состояние). */
function trimState(state) {
  if (!isPlain(state)) return state
  const kept = pickKeys(state, ['sessionCode', 'players', 'actors', 'enemies', 'social', 'mechanics', 'battleLog'])
  if ('players' in kept) kept.players = trimActors(kept.players)
  if ('actors' in kept) kept.actors = trimActors(kept.actors)
  if (Array.isArray(kept.enemies)) kept.enemies = kept.enemies.map((enemy) => (isPlain(enemy) ? pickKeys(enemy, ['id']) : enemy))
  if (isPlain(kept.social)) {
    const social = pickKeys(kept.social, ['npcs', 'relationships'])
    if (Array.isArray(social.npcs)) social.npcs = social.npcs.map((npc) => (isPlain(npc) ? pickKeys(npc, ['id']) : npc))
    kept.social = social
  }
  if (isPlain(kept.mechanics)) kept.mechanics = pickKeys(kept.mechanics, ['resting'])
  if (Array.isArray(kept.battleLog)) kept.battleLog = kept.battleLog.filter((entry) => entry?.type === 'loot-taken').slice(-6)
  return kept
}

const ACTOR_RESULT_FNS = new Set(['combatActorFor', 'assertPlayerCombatActorPermission'])
/** Почте — всё состояние без карт и клеток (проверено тем же исходом). */
function trimCourierState(state) {
  if (!isPlain(state)) return state
  const { locationMaps: _maps, campaignConcept: _concept, merchants: _merchants, messages: _messages, economyLog: _economy, ...kept } = state
  if (isPlain(kept.scene)) {
    const { cells: _cells, map: _map, ...scene } = kept.scene
    kept.scene = scene
  }
  return kept
}
/** События коммита — только поля, которые читают сверки отпечатков. */
function trimEvent(event) {
  if (!isPlain(event)) return event
  const payload = isPlain(event.payload) ? pickKeys(event.payload, ['request_fingerprint', 'action_id', 'opening_action', 'rest_id']) : event.payload
  if (isPlain(payload?.opening_action)) payload.opening_action = pickKeys(payload.opening_action, ['status', 'command_type', 'request_fingerprint'])
  return { event_type: event.event_type, ...(payload === undefined ? {} : { payload }) }
}
const errorOf = (error) => {
  if (error instanceof ReferenceError || error instanceof SyntaxError) throw error
  return { code: error?.code ?? null, message: String(error?.message ?? error) }
}
const hasLoneSurrogate = (value) => typeof value === 'string' ? !value.isWellFormed() : Array.isArray(value) ? value.some(hasLoneSurrogate) : isPlain(value) ? Object.entries(value).some(([k, v]) => hasLoneSurrogate(k) || hasLoneSurrogate(v)) : false

/**
 * Один вызов: аргументы через JSON (Rust видит то же), окружение заглушек.
 * `stateArgs` — номера аргументов-состояний: в эталон идут ссылкой.
 */
async function call(fn, args, { stateArgs = [], memberships = false, duplicate = null, authorize = null, model = false, reply = null, full = false } = {}) {
  const run = async (useFull) => {
    const roundTrip = args.map((value, index) => {
      if (!stateArgs.includes(index)) return plain(value)
      return plain(useFull ? value : (full ? trimCourierState(value) : trimState(value)))
    })
    env.memberships = memberships; env.calls = []; env.duplicate = plain(duplicate); env.model = model; env.reply = plain(reply); env.respond = []
    let authorized = 0
    const callArgs = roundTrip.map((value) => (value === undefined ? undefined : structuredClone(value)))
    env.state = stateArgs.length ? callArgs[stateArgs[0]] : undefined
    if (fn === 'assertMakeAttackIdempotency') {
      callArgs[3] = authorize == null ? {} : {
        authorizeDuplicate: () => {
          authorized += 1
          if (authorize === 'throw') throw Object.assign(new Error('Команда доступна только владельцу героя или его призванного существа'), { code: 'ACTOR_FORBIDDEN' })
        },
      }
    }
    let out
    try {
      const value = await F[fn](...callArgs)
      out = { ok: value === undefined ? null : plain(value) }
    } catch (error) {
      out = { err: errorOf(error) }
    }
    const result = { out, calls: env.calls }
    if (fn === 'assertMakeAttackIdempotency') result.authorized = authorized
    if (fn === 'assertRestIdempotency') result.after = plain(callArgs[2])
    if (fn === 'withCourierReplyDraft') result.respond = env.respond
    return { result, roundTrip }
  }
  const trimmedRun = await run(false)
  let { result, roundTrip } = trimmedRun
  if (stateArgs.length) {
    const fullRun = await run(true)
    // Актёр из состояния возвращается целиком: урезанный и полный сверяются по id.
    const key = (value) => (ACTOR_RESULT_FNS.has(fn) && value.out.ok ? { ...value, out: { ok: pickKeys(value.out.ok, ['id', 'actor_id']) } } : value)
    if (JSON.stringify(key(fullRun.result)) !== JSON.stringify(key(result))) {
      trimmedFallbacks += 1
      ;({ result, roundTrip } = fullRun)
    }
  }
  // Одинокий суррогат (срез JS посреди пары) в Rust-строке непредставим: такой
  // случай и всё, что из него следует, в эталон не идёт.
  if (hasLoneSurrogate(result) || roundTrip.some(hasLoneSurrogate)) { excludedLoneSurrogate += 1; return result }
  const userArg = fn === 'canUseHero' || ALL_SANITIZERS.includes(fn) || fn.startsWith('assert') && fn.endsWith('Permission') ? 0 : -1
  const entry = { fn, args: roundTrip.map((value, index) => (stateArgs.includes(index) ? stateRef(value) : index === userArg ? userRef(value) : value ?? null)) }
  const undef = args.map((value, index) => (value === undefined ? index : -1)).filter((index) => index >= 0)
  if (undef.length) entry.undef = undef
  const envOut = {}
  if (memberships !== false) envOut.memberships = memberships
  if (duplicate != null) envOut.duplicate = plain(duplicate)
  if (authorize != null) envOut.authorize = authorize
  if (model) envOut.model = true
  if (reply != null) envOut.reply = plain(reply)
  if (Object.keys(envOut).length) entry.env = envOut
  Object.assign(entry, result)
  if (!entry.calls.length) delete entry.calls
  const key = JSON.stringify([entry.fn, entry.args, entry.undef, entry.env])
  if (!seenCases.has(key)) { seenCases.add(key); cases.push(entry) }
  return result
}

// --- пользователи ------------------------------------------------------------------------

function heroIdsOf(state) {
  return (Array.isArray(state?.players) ? state.players : []).map((player) => String(player?.id ?? '')).filter(Boolean)
}
function summonOwners(state) {
  return [...(state?.players ?? []), ...(state?.actors ?? [])]
    .filter((actor) => isPartySummon(actor)).map((actor) => String(actor.controllerId ?? actor.controller_id ?? actor.ownerId ?? actor.owner_id ?? ''))
}
function usersFor(state) {
  const code = String(state?.sessionCode ?? '')
  const heroes = heroIdsOf(state)
  const first = heroes[0] ?? 'hero'
  const other = heroes[1] ?? 'чужой-герой'
  const summoner = summonOwners(state)[0]
  return [
    { user: { id: 'u-admin', role: 'admin', heroIds: [] }, memberships: true },
    { user: { id: 'u-owner', role: 'player', heroIds: [first] }, memberships: false },
    { user: { id: 'u-member', role: 'player', heroIds: [], campaignMemberships: [{ campaignId: code.toUpperCase(), heroIds: [first] }] }, memberships: true },
    { user: { id: 'u-stranger', role: 'player', heroIds: [first] }, memberships: true },
    { user: { id: 'u-other', role: 'player', heroIds: [other] }, memberships: false },
    { user: { id: 'u-none', role: 'player', heroIds: [] }, memberships: false },
    ...(summoner ? [{ user: { id: 'u-summoner', role: 'player', heroIds: [summoner] }, memberships: false }] : []),
    { user: { id: 'u-throws', role: 'player', heroIds: [first] }, memberships: 'throw' },
  ]
}
// Владелец — чаще: иначе почти все случаи заканчиваются отказом прав.
const pickUser = (state) => {
  const users = usersFor(state)
  return chance(0.55) ? users[1] : pick(users)
}

// --- мутации -----------------------------------------------------------------------------

const WEIRD = [
  '', ' ', '  hero  ', 'a'.repeat(130), 'б'.repeat(200), '🙂'.repeat(70), `x${'🙂'.repeat(60)}`, ` ${'z'.repeat(119)} `, 0, -1, 1, 2, 3, 5, 9, 10, 50, 200, 201,
  1.5, 2 ** 53, 1e21, '7', '0x10', ' 3 ', 'Infinity', 'NaN', true, false, null, [], ['a'], ['a', 'a', ' b '], [1, '1', 1, true, null], [null], [{}], [[1, 2]],
  {}, { x: 1, y: 2 }, { x: '3', y: '4' }, { x: 1, y: 2, z: 3 }, { x: 1.5, y: 2 }, { x: null, y: 0 }, { x: [5], y: true }, [3, 4], 'constructor', '__proto__',
  'toString', 'hasOwnProperty', 'long', 'short', 'off_hand', 'intimidation', 'persuasion', 'athletics', 'stealth', 'melee', 'thrown', 'two-handed', 'STR', ' dex ', 'Melee ',
  'spill', 'fight', 'pay', 'flee', 'replace', 'create', 'convert', 'wolf', 'brown-bear', 'Wolf', 'cast:silvery-barbs', 'shove', 'npc', 'faction', 'cheat', 'watch', 'fair',
  'force', 'close', 'pray', 'topple', 'take', 'enemy:1', 'ally', 'спасибо. Обещаю вернуть долг завтра!', 'slot:1', 'ki_points', 'Bad Resource', 'a:b_c-1',
]
const FIELD_POOL = [
  'actor_id', 'actorId', 'target_id', 'targetId', 'target_ids', 'targetIds', 'item_id', 'itemId', 'npc_id', 'npcId', 'to', 'path', 'range', 'distance',
  'dc', 'damage', 'roll', 'result', 'request_fingerprint', 'server_authoritative', 'expected_state_version', 'expectedStateVersion', 'kind', 'rest_id',
  'equip_slot', 'equipped', 'attuned', 'activated', 'quantity', 'charges_to_spend', 'chargesToSpend', 'use_mode', 'useMode', 'weapon_id', 'weaponId',
  'recipient_id', 'recipientId', 'attack_mode', 'attackMode', 'attack_ability', 'attackAbility', 'sneak_attack', 'sneakAttack', 'knock_out', 'spell_id',
  'spellId', 'slot_level', 'slotLevel', 'spell_option', 'spellOption', 'casting_resource', 'action_id', 'actionId', 'beneficiary_id', 'beneficiaryId',
  'shove_mode', 'font_mode', 'amount', 'form_id', 'resolution', 'replacement_name', 'replacementName', 'intent', 'door_id', 'doorId', 'prop_id', 'propId',
  'skill', 'outcome', 'enabled', 'reaction_id', 'mode', 'subclass', 'class_skill_proficiencies', 'selected_feature_ids', 'ability_score_level',
  'ability_score_increases', 'ability_score_feat', 'abilityScoreFeat', 'known_spell_ids', 'prepared_spell_ids', 'expected_level', 'expectedLevel',
  'document', 'roll_index', 'character_class', 'container_id', 'containerId', 'lines', 'captive_id', 'captiveId', 'beast_id', 'beastId', 'stake_cp', 'stakeCp',
  'approach', 'option_id', 'optionId', 'addressee_kind', 'addresseeKind', 'addressee_id', 'addresseeId', 'body', 'reply_draft', 'merchant_id',
  'merchantId', 'stock_id', 'stockId', 'service_id', 'serviceId', 'command_id', 'campaign_id', '0', '10', '__proto__', 'constructor', 'commandType', 'type',
]
const CAMEL = {
  actor_id: 'actorId', target_id: 'targetId', target_ids: 'targetIds', item_id: 'itemId', npc_id: 'npcId', spell_id: 'spellId', slot_level: 'slotLevel',
  spell_option: 'spellOption', action_id: 'actionId', beneficiary_id: 'beneficiaryId', door_id: 'doorId', prop_id: 'propId', container_id: 'containerId',
  recipient_id: 'recipientId', captive_id: 'captiveId', beast_id: 'beastId', stake_cp: 'stakeCp', option_id: 'optionId', addressee_kind: 'addresseeKind',
  addressee_id: 'addresseeId', merchant_id: 'merchantId', stock_id: 'stockId', service_id: 'serviceId', expected_state_version: 'expectedStateVersion',
  charges_to_spend: 'chargesToSpend', use_mode: 'useMode', weapon_id: 'weaponId', attack_mode: 'attackMode', attack_ability: 'attackAbility',
  sneak_attack: 'sneakAttack', replacement_name: 'replacementName', class_skill_proficiencies: 'classSkillProficiencies',
  selected_feature_ids: 'selectedFeatureIds', ability_score_level: 'abilityScoreLevel', ability_score_increases: 'abilityScoreIncreases',
  ability_score_feat: 'abilityScoreFeat', known_spell_ids: 'knownSpellIds', prepared_spell_ids: 'preparedSpellIds', expected_level: 'expectedLevel',
  command_type: 'commandType',
}
/** Своё поле объекта — и для ключей прототипа (`__proto__` как обычный ключ). */
function setOwn(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })
}
function ids(state) {
  return {
    heroes: heroIdsOf(state),
    enemies: (state?.enemies ?? []).map((enemy) => String(enemy?.id ?? '')).filter(Boolean),
    npcs: (state?.social?.npcs ?? []).map((npc) => String(npc?.id ?? '')).filter(Boolean),
    actors: (state?.actors ?? []).map((actor) => String(actor?.id ?? actor?.actor_id ?? '')).filter(Boolean),
  }
}
function mutate(command, state) {
  const result = structuredClone(command)
  const known = ids(state)
  const steps = 1 + int(3)
  for (let step = 0; step < steps; step += 1) {
    const keys = Object.keys(result)
    switch (int(9)) {
      case 0: if (keys.length) setOwn(result, pick(keys), pick(WEIRD)); break
      case 1: setOwn(result, pick(FIELD_POOL), pick(WEIRD)); break
      case 2: if (keys.length) delete result[pick(keys)]; break
      case 3: result.actor_id = pick([...known.heroes, ...known.actors, 'нет-такого', '', ' hero ', 7, null, 'constructor', '__proto__']); break
      case 4: {
        const key = pick(keys.filter((name) => CAMEL[name]))
        if (key) { const value = result[key]; delete result[key]; setOwn(result, CAMEL[key], value) }
        break
      }
      case 5: setOwn(result, pick(['target_id', 'targetId', 'npc_id', 'beneficiary_id']), pick([...known.enemies, ...known.npcs, ...known.heroes, 'нет-цели', ''])); break
      case 6: setOwn(result, pick(['to', 'path', 'range', 'distance']), pick([{ x: 1, y: 2 }, { x: 99999, y: -5 }, [[0, 0], [1, 1]], 120, 'far', { x: '1', y: '2', z: 0 }, { x: 1.5, y: 2 }, null])); break
      case 7: setOwn(result, 'expected_state_version', pick([0, 3, -1, '4', null, 1.5, 'abc', 2 ** 53])); break
      default: setOwn(result, pick(['request_fingerprint', 'server_authoritative', 'dc', 'damage', 'reply_draft']), pick(['evil', true, 30, '10d10']))
    }
  }
  return result
}

/** Серверные поля корпусной команды — их клиент не шлёт. */
function clientShape(command) {
  const { server_authoritative: _a, request_fingerprint: _b, campaign_id: _c, command_id: _d, rest_id: _e, ...rest } = command
  return rest
}

// --- корпус ------------------------------------------------------------------------------

const ROUTED = new Set([
  ...SETS.PLAYER_COMBAT_COMMANDS, ...SETS.PLAYER_REST_COMMANDS, ...SETS.PLAYER_CHARACTER_COMMANDS, ...SETS.PLAYER_CHARACTER_LIFECYCLE_COMMANDS,
  ...SETS.PLAYER_ITEM_COMMANDS, ...SETS.PLAYER_MERCHANT_COMMANDS, ...SETS.PLAYER_PICKPOCKET_COMMANDS, ...SETS.PLAYER_CAPTIVE_COMMANDS,
  ...SETS.PLAYER_BEAST_COMMANDS, ...SETS.PLAYER_LAW_COMMANDS, ...SETS.PLAYER_LOOT_COMMANDS, ...SETS.PLAYER_TAVERN_COMMANDS,
  ...SETS.PLAYER_LETTER_COMMANDS, ...SETS.PLAYER_BLESSING_COMMANDS, ...SETS.PLAYER_DIALOGUE_COMMANDS,
])
const PER_TYPE = 16
const corpus = []
const perType = new Map()
const resultEvents = []
const loadState = (id) => {
  if (!fullStates.has(id)) fullStates.set(id, JSON.parse(readFileSync(join(CORPUS_DIR, 'states', `${id}.json`), 'utf8')))
  return fullStates.get(id)
}
if (existsSync(CORPUS_DIR)) {
  for (const file of readdirSync(CORPUS_DIR).filter((name) => name.startsWith('corpus-')).sort()) {
    for (const line of readFileSync(join(CORPUS_DIR, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const entry = JSON.parse(line)
      const type = String(entry.command?.command_type ?? '')
      const events = entry.outcome?.events ?? []
      if (events.some((event) => event?.payload?.request_fingerprint || event?.event_type === 'CombatStarted') && resultEvents.length < 220) {
        resultEvents.push({ command: entry.command, events: events.map(trimEvent) })
      }
      const count = perType.get(type) ?? 0
      if ((!ROUTED.has(type) && count >= 3) || count >= PER_TYPE) continue
      if (!existsSync(join(CORPUS_DIR, 'states', `${entry.state}.json`))) continue
      perType.set(type, count + 1)
      corpus.push({ command: entry.command, state: entry.state })
    }
  }
} else {
  console.warn(`корпус не найден: ${CORPUS_DIR} — только синтетика`)
}

// --- синтетика ---------------------------------------------------------------------------

const SYNTHETIC_STATE = {
  sessionCode: 'GUARD-1',
  players: [
    { id: 'hero', name: 'Ада' },
    { id: 'mage', name: 'Борис' },
  ],
  actors: [
    { id: 'wolf-1', kind: 'summon', faction: 'party', ownerId: 'mage', name: 'Волк' },
    { actor_id: 'hawk', kind: 'summon', faction: 'party', owner_id: 'hero', controllerId: 'hero' },
    { id: 'imp', kind: 'summon', faction: 'hostile', ownerId: 'mage' },
  ],
  enemies: [{ id: 'goblin-1' }, { id: 'goblin-2' }, {}],
  social: { npcs: [{ id: 'innkeeper' }, { id: 'ally' }], relationships: { ally: { hero: 60, mage: -70 }, innkeeper: { hero: 25 } } },
  mechanics: { resting: { hero: { rest_id: 'rest-7' }, mage: { rest_id: '' }, constructor: { rest_id: 'proto' } } },
  battleLog: [
    { id: 'b1', type: 'loot-taken', actorId: 'hero', recipientId: 'mage', containerId: 'loot:corpse:1', containerName: 'Тело: Гоблин', itemCount: 2, remainingCount: 1, statusAfter: 'partial', extra: 'секрет' },
    { id: 'b2', type: 'loot-taken', containerId: 'loot:corpse:1', itemCount: '3', remainingCount: -4 },
    { id: 'b3', type: 'note', containerId: 'loot:corpse:2' },
    { id: 4, type: 'loot-taken', containerId: 'loot:chest', itemCount: 1.5, remainingCount: 'NaN', statusAfter: null },
    null,
  ],
}
const NULL_STATE = { ...SYNTHETIC_STATE, players: [{ id: 'hero' }, null], enemies: [null, { id: 'goblin-1' }] }
const NULL_FIRST_STATE = { ...SYNTHETIC_STATE, players: [null, { id: 'hero' }] }
const EMPTY_STATE = { sessionCode: '' }

function syntheticCommands(state) {
  const known = ids(state)
  const hero = known.heroes[0] ?? 'hero'
  const enemy = known.enemies[0] ?? 'goblin-1'
  const npc = known.npcs[0] ?? 'innkeeper'
  return [
    { command_type: 'StartCombat', actor_id: hero },
    { command_type: 'EndTurn', actor_id: hero, expected_state_version: 3 },
    { command_type: 'MoveActor', actor_id: hero, to: { x: 4, y: 5 }, path: [[1, 1], [2, 2]], distance: 999 },
    { command_type: 'MakeAttack', actor_id: hero, target_id: enemy, item_id: ' longsword ', attack_mode: ' Melee ', attack_ability: 'STR', sneak_attack: true, knock_out: true, damage: 99 },
    { command_type: 'MakeAttack', actor_id: hero, targetId: npc, itemId: 'dagger', attackMode: 'thrown', sneakAttack: 'true' },
    { command_type: 'MakeAttack', actor_id: hero, target_id: enemy, attack_mode: 'melee' },
    { command_type: 'MakeAttack', actor_id: hero, target_id: enemy, item_id: 'bow', attack_mode: 'magic' },
    { command_type: 'MakeAttack', actor_id: hero, target_id: enemy, item_id: 'bow', attack_ability: 'wis' },
    { command_type: 'MakeAttack', actor_id: 'wolf-1', target_id: enemy },
    { command_type: 'MakeAttack', actor_id: 'hawk', target_id: 'undefined' },
    { command_type: 'MakeAreaAttack', actor_id: hero, item_id: 'flask', to: { x: 2, y: 3 }, radius: 30 },
    { command_type: 'ChangeWeapon', actor_id: hero, item_id: 0 },
    { command_type: 'CastSpell', actor_id: hero, spell_id: 'fire-bolt', target_id: enemy, slot_level: 1, casting_resource: 'spell_slot:1', spell_option: 'cold', item_id: ' staff ', to: { x: 1, y: 1 }, knock_out: true },
    { command_type: 'CastSpell', actor_id: hero, spellId: 'longstrider', targetIds: [hero, ' mage ', hero] },
    { command_type: 'CastSpell', actor_id: hero, spell_id: 'chain-lightning', target_ids: ['goblin-1', ' goblin-2 '] },
    { command_type: 'CastSpell', actor_id: hero, spell_id: 'bless', target_ids: [hero, ` ${hero}`, 'mage'], slot_level: 10 },
    { command_type: 'CastSpell', actor_id: hero, spell_id: 'bless', target_ids: [] },
    { command_type: 'CastSpell', actor_id: hero, spell_id: 'bless', target_ids: ['x'.repeat(121)] },
    { command_type: 'CastSpell', actor_id: hero, spell_id: '', target_id: enemy },
    { command_type: 'CastSpell', actor_id: hero, spell_id: 'shield', casting_resource: 'Bad Resource' },
    { command_type: 'CastSpell', actor_id: hero, spell_id: 'shield', spell_option: 7 },
    { command_type: 'CastSpell', actor_id: hero, spell_id: 'shield', slot_level: '2' },
    { command_type: 'CastSpell', actor_id: hero, spell_id: 'shield', slotLevel: 2.0, to: 'там' },
    { command_type: 'UseCombatAction', actor_id: hero, action_id: 'cast:silvery-barbs', target_id: enemy, beneficiary_id: ' mage ', item_id: 'x', shove_mode: 'prone' },
    { command_type: 'UseCombatAction', actor_id: hero, action_id: 'shove', shove_mode: 12345678901234567890123, slot_level: 3 },
    { command_type: 'UseCombatAction', actor_id: hero, action_id: 'divine-smite', slot_level: 5, amount: 9 },
    { command_type: 'UseCombatAction', actor_id: hero, action_id: 'font-of-magic', slot_level: 6, font_mode: 'create' },
    { command_type: 'UseCombatAction', actor_id: hero, action_id: 'lay-on-hands', amount: 200, target_id: 'mage' },
    { command_type: 'UseCombatAction', actor_id: hero, action_id: 'wild-shape', form_id: 'brown-bear' },
    { command_type: 'UseCombatAction', actor_id: hero, action_id: 'wild-shape', form_id: 'Bear' },
    { command_type: 'UseCombatAction', actor_id: hero, actionId: 'dodge', beneficiaryId: '' },
    { command_type: 'UseCombatAction', actor_id: hero, action_id: '' },
    { command_type: 'SetSpellBonusPreference', actor_id: hero, spell_id: 'hex', enabled: 'yes' },
    { command_type: 'SetReactionPreference', actor_id: hero, reaction_id: 'r'.repeat(90), mode: 'always-and-forever' },
    { command_type: 'IdentifyEnemy', actor_id: hero, targetId: enemy, skill: 'arcana', dc: 1 },
    { command_type: 'ProposeParley', actor_id: hero, skill: 'intimidation', dc: 1 },
    { command_type: 'ProposeParley', actor_id: hero, skill: 'deception' },
    { command_type: 'SettleParley', actor_id: hero, outcome: 'surrender'.repeat(6) },
    { command_type: 'OperateDoor', actor_id: hero, doorId: 'door-1', intent: 'force', dc: 1, success: true },
    { command_type: 'OperateDoor', actor_id: hero, door_id: 'door-1', intent: 'smash' },
    { command_type: 'OperateSceneObject', actor_id: hero, prop_id: 'altar', intent: 'pray', approach: 'force' },
    { command_type: 'OperateSceneObject', actor_id: hero, propId: 'barrel', intent: 'topple' },
    { command_type: 'UseLevelTransition', actor_id: hero, prop_id: 'stairs', to_level: 3 },
    { command_type: 'ResolveHeroDeath', actor_id: hero, resolution: 'replace', replacementName: '  Новый герой  ' },
    { command_type: 'ResolveHeroDeath', actor_id: hero, resolution: 'revive' },
    { command_type: 'AttackNpc', actor_id: hero, npc_id: ` ${npc} ` },
    { command_type: 'AttackNpc', actorId: hero, npcId: 'bad id!' },
    { command_type: 'StartRest', actor_id: hero, kind: 'long' },
    { command_type: 'StartRest', actor_id: hero },
    { command_type: 'StartRest', actor_id: hero, kind: null },
    { command_type: 'StartRest', actor_id: hero, kind: 'nap' },
    { command_type: 'SpendHitPointDie', actor_id: hero },
    { command_type: 'CompleteRest', actorId: hero, expectedStateVersion: 2 },
    { command_type: 'SpendHitPointDie', actor_id: hero, kind: 'long' },
    { command_type: 'SetCharacterChoices', actor_id: hero, subclass: '  champion  ', class_skill_proficiencies: ['athletics', 'perception', 'athletics', 7], selected_feature_ids: ['b', 'a', 'b'], ability_score_level: '4', ability_score_increases: ['str', 'dex'], ability_score_feat: { id: 'alert', choices: { a: 1 } } },
    { command_type: 'SetCharacterChoices', actorId: hero, classSkillProficiencies: 'xyz', abilityScoreIncreases: 'str', abilityScoreFeat: { choices: null } },
    { command_type: 'SetCharacterChoices', actor_id: hero, ability_score_feat: 5, ability_score_level: null, ability_score_increases: null },
    { command_type: 'SetSpellSelections', actor_id: hero, known_spell_ids: ['b', 'a', 'é', '\u{1F600}', '\uFFFD'], prepared_spell_ids: ['a', 'a'] },
    { command_type: 'LevelUp', actor_id: hero, expected_level: 3 },
    { command_type: 'LevelUp', actor_id: hero, expectedLevel: null },
    { command_type: 'ImportCharacter', actor_id: hero, document: { name: 'Лист', level: 20 } },
    { command_type: 'RollCharacterAbilities', actor_id: hero, roll_index: 2, result: [18, 18, 18] },
    { command_type: 'RollCharacterWealth', actor_id: hero, character_class: 'fighter', gold: 9999 },
    { command_type: 'EquipItem', actor_id: hero, item_id: 'sword', equipped: 'no' },
    { command_type: 'EquipItem', actor_id: hero, item_id: 'sword', equip_slot: 'off_hand' },
    { command_type: 'EquipItem', actor_id: hero, item_id: 'sword', equipped: false },
    { command_type: 'AttuneItem', actor_id: hero, itemId: 'ring', attuned: false },
    { command_type: 'ActivateItem', actor_id: hero, item_id: 'boots', activated: true },
    { command_type: 'ActivateItem', actor_id: hero, item_id: 'boots', activated: 'true' },
    { command_type: 'UseItem', actor_id: hero, item_id: 'potion', target_id: 'mage', charges_to_spend: '2', to: { x: '3', y: 4 }, use_mode: ' spill ', weapon_id: ' axe ' },
    { command_type: 'UseItem', actor_id: hero, item_id: 'potion', to: { x: 1, y: 2, z: 3 } },
    { command_type: 'UseItem', actor_id: hero, item_id: 'potion', to: { x: 1.5, y: 2 } },
    { command_type: 'UseItem', actor_id: hero, item_id: 'potion', use_mode: 'drink' },
    { command_type: 'UseItem', actor_id: hero, item_id: 'potion', targetId: '   ', chargesToSpend: null },
    { command_type: 'TransferItem', actor_id: hero, item_id: 'rope', targetId: 'mage', quantity: '3' },
    { command_type: 'TransferItem', actor_id: hero, item_id: 'rope', quantity: null },
    { command_type: 'TransferItem', actor_id: hero, item_id: '' },
    { command_type: 'BuyItem', actor_id: hero, merchant_id: 'smith', stock_id: 'axe', quantity: '2', expected_state_version: 5, price_cp: 1 },
    { command_type: 'SellItem', actor_id: hero, merchantId: 'smith', itemId: 'gem', expectedStateVersion: '6' },
    { command_type: 'AppraiseItem', actor_id: hero, merchant_id: 'smith', item_id: 'gem', expected_state_version: null },
    { command_type: 'PurchaseMerchantService', actor_id: hero, merchant_id: 'temple', service_id: 'healing', expected_state_version: 0 },
    { command_type: 'BargainWithMerchant', actor_id: hero, merchant_id: 'smith', expected_state_version: -1 },
    { command_type: 'BargainWithMerchant', actor_id: hero, expected_state_version: 1 },
    { command_type: 'PickpocketNpc', actor_id: hero, npc_id: ` ${npc} ` },
    { command_type: 'PickpocketNpc', actor_id: hero, npc_id: npc, dc: 1 },
    { command_type: 'InterrogateCaptive', actor_id: hero, captive_id: 'captive-1' },
    { command_type: 'InterrogateCaptive', actor_id: hero, captiveId: 'captive-1', skill: 7 },
    { command_type: 'ReleaseCaptive', actor_id: hero, captive_id: '  ' },
    { command_type: 'LootContainer', actor_id: hero, container_id: 'loot:corpse:1', lines: [{ item_instance_id: 'b', quantity: 1 }, { itemInstanceId: ' a ', quantity: '2' }] },
    { command_type: 'LootContainer', actor_id: hero, containerId: 'loot:corpse:1', recipientId: 'mage', lines: [{ item_instance_id: 'a' }] },
    { command_type: 'LootContainer', actor_id: hero, container_id: 'loot:corpse:1', lines: [] },
    { command_type: 'LootContainer', actor_id: hero, container_id: 'loot:corpse:1', lines: [{ item_instance_id: 'a', price: 1 }] },
    { command_type: 'LootContainer', actor_id: hero, container_id: 'loot:corpse:1', lines: [{ item_instance_id: 'a', quantity: 0 }] },
    { command_type: 'LootContainer', actor_id: hero, container_id: 'loot:corpse:1', lines: [{ item_instance_id: 'a', quantity: 1.5 }] },
    { command_type: 'LootContainer', actor_id: hero, container_id: 'loot:corpse:1', lines: [null] },
    { command_type: 'LootContainer', actor_id: hero, container_id: 'loot:corpse:1', lines: [{ item_instance_id: '' }] },
    { command_type: 'LootContainer', actor_id: hero, container_id: 'loot:corpse:1', lines: Array.from({ length: 14 }, (_, index) => ({ item_instance_id: `i-${13 - index}`, quantity: index + 1 })) },
    { command_type: 'LootContainer', actor_id: hero, container_id: 'loot:corpse:1', lines: Array.from({ length: 14 }, (_, index) => (index === 13 ? { bad: 1 } : { item_instance_id: `i-${index}` })) },
    { command_type: 'CalmBeast', actor_id: hero, beast_id: 'boar' },
    { command_type: 'FeedBeast', actor_id: hero, beastId: ' boar ', item_id: 'ration' },
    { command_type: 'ScareWithBeast', actor_id: hero, beast_id: '' },
    { command_type: 'ResolveGuardEncounter', actor_id: hero, resolution: 'fight', skill: 'athletics' },
    { command_type: 'ResolveGuardEncounter', actor_id: hero, resolution: 'flee'.repeat(10), skill: 'arcana', fine_cp: 0 },
    { command_type: 'OpenTavernDiceRound', actor_id: hero, npc_id: ` ${npc} `, stake_cp: '50' },
    { command_type: 'OpenTavernDiceRound', actor_id: hero, npcId: npc, stakeCp: 49 },
    { command_type: 'AnswerTavernDiceRound', actor_id: hero, approach: 'cheat' },
    { command_type: 'AnswerTavernDiceRound', actor_id: hero, approach: 'magic' },
    { command_type: 'LeaveTavernDiceRound', actor_id: hero },
    { command_type: 'OrderTavernDrink', actor_id: hero, dc: 1 },
    { command_type: 'ReceiveNpcBlessing', actor_id: hero, npc_id: ' priest ' },
    { command_type: 'ReceiveNpcBlessing', actor_id: hero, npc_id: 'priest', price_cp: 0 },
    { command_type: 'ChooseDialogueOption', actor_id: hero, npc_id: npc, option_id: `  ${'o'.repeat(90)}  ` },
    { command_type: 'ChooseDialogueOption', actor_id: hero, npcId: npc, optionId: 'ask', check: 'pass' },
    { command_type: 'SendLetter', actor_id: hero, addressee_kind: 'faction', addressee_id: ' guild ', body: 'Привет' },
    { command_type: 'SendLetter', actor_id: hero, addresseeKind: 'king', addresseeId: 'ally', body: 'Обещаю вернуть долг завтра. Жди.' },
    { command_type: 'SendLetter', actor_id: hero, addressee_id: 'ally', body: 'Ж'.repeat(1300), reply_draft: 'Я согласен на всё' },
    { command_type: 'AdvanceScene', actor_id: hero },
    { command_type: 'CreateEncounter', actor_id: hero },
    { command_type: 'CreateMerchant', actor_id: hero },
    { commandType: 'EndTurn', actorId: hero },
    { type: 'EndTurn', actor_id: hero },
    { command_type: null, commandType: 'EndTurn', actor_id: hero },
  ]
}

// --- маршрут: какой санитайзер ------------------------------------------------------------

const SANITIZERS = [
  ['PLAYER_REST_COMMANDS', 'sanitizePlayerRestCommand'],
  ['PLAYER_MERCHANT_COMMANDS', 'sanitizeMerchantCommand'],
  ['PLAYER_CHARACTER_COMMANDS', 'sanitizePlayerCharacterCommand'],
  ['PLAYER_CHARACTER_LIFECYCLE_COMMANDS', 'sanitizePlayerCharacterCommand'],
  ['PLAYER_ITEM_COMMANDS', 'sanitizePlayerItemCommand'],
  ['PLAYER_CAPTIVE_COMMANDS', 'sanitizePlayerCaptiveCommand'],
  ['PLAYER_PICKPOCKET_COMMANDS', 'sanitizePlayerPickpocketCommand'],
  ['PLAYER_LOOT_COMMANDS', 'sanitizePlayerLootCommand'],
  ['PLAYER_BEAST_COMMANDS', 'sanitizePlayerBeastCommand'],
  ['PLAYER_LAW_COMMANDS', 'sanitizePlayerLawCommand'],
  ['PLAYER_TAVERN_COMMANDS', 'sanitizePlayerTavernCommand'],
  ['PLAYER_LETTER_COMMANDS', 'sanitizePlayerLetterCommand'],
  ['PLAYER_BLESSING_COMMANDS', 'sanitizePlayerBlessingCommand'],
  ['PLAYER_DIALOGUE_COMMANDS', 'sanitizePlayerDialogueCommand'],
  ['PLAYER_NPC_COMBAT_COMMANDS', 'sanitizePlayerNpcCombatCommand'],
]
const ALL_SANITIZERS = [...new Set(SANITIZERS.map(([, fn]) => fn)), 'sanitizePlayerCombatCommand']
function sanitizerFor(type) {
  for (const [set, fn] of SANITIZERS) if (SETS[set].has(type)) return fn
  return 'sanitizePlayerCombatCommand'
}

const REPLIES = [
  { reply: '  Спасибо   за\n письмо.  Жду. ', provider: 'MeteredLLMClient' },
  { reply: 'Ответ', provider: '' },
  { reply: '', provider: 'MeteredLLMClient' },
  { reply: 'Ответ', provider: 'deterministic-social-fallback' },
  { reply: `${'слово '.repeat(250)}🙂`, provider: 'p'.repeat(90) },
  { reply: 42 },
  'throw',
  null,
]

/** Дубликаты журнала вокруг ожидаемого отпечатка. */
function duplicatesFor(typeSet, fingerprint, extra = {}) {
  const types = [...typeSet]
  const [type] = types
  return sample([
    null,
    { events: [{ event_type: type, payload: { request_fingerprint: fingerprint, ...extra } }] },
    { events: [{ event_type: type, payload: { request_fingerprint: fingerprint } }, { event_type: types.at(-1), payload: { request_fingerprint: fingerprint } }] },
    { events: [{ event_type: type, payload: { request_fingerprint: 'другой' } }] },
    { events: [{ event_type: type, payload: { request_fingerprint: fingerprint } }, { event_type: type, payload: { request_fingerprint: 'другой' } }] },
    { events: [{ event_type: type, payload: {} }] },
    { events: [{ event_type: 'SomethingElse', payload: { request_fingerprint: fingerprint } }] },
    { events: [] },
    'throw',
  ])
}
const resultsFor = (typeSet, fingerprint, types = [...typeSet]) => sample([
  { mechanics: [{ event_type: types[0], payload: { request_fingerprint: fingerprint } }] },
  { mechanics: [{ event_type: 'Other' }, { event_type: types.at(-1), payload: { request_fingerprint: fingerprint } }] },
  { mechanics: [{ event_type: types[0], payload: { request_fingerprint: 'другой' } }, { event_type: types[0], payload: { request_fingerprint: fingerprint } }] },
  { mechanics: [] },
  {},
  null,
])

async function followUps(fn, command, state, setting) {
  const type = F.commandType(command)
  if (fn === 'sanitizePlayerRestCommand') {
    await call('expandPlayerRestCommand', [command])
    await call('restCommandFingerprint', [command])
    const fingerprint = F.restCommandFingerprint(command)
    for (const result of resultsFor(SETS.REST_PRIMARY_EVENT_TYPES, fingerprint)) await call('assertRestResultFingerprint', [result, command])
    for (const duplicate of duplicatesFor(SETS.REST_PRIMARY_EVENT_TYPES, fingerprint)) await call('assertRestIdempotency', ['C', 'k', command], { duplicate })
    if (type !== 'StartRest') {
      const bare = { ...command }
      delete bare.rest_id
      const inferred = F.restCommandFingerprint({ ...bare, rest_id: 'rest-9' })
      for (const duplicate of [
        { events: [{ event_type: type === 'CompleteRest' ? 'RestCompleted' : 'HitPointDieSpent', payload: { rest_id: 'rest-9', request_fingerprint: inferred } }] },
        { events: [{ event_type: 'RestStarted', payload: { rest_id: 'rest-9', request_fingerprint: inferred } }, { event_type: 'RestCompleted', payload: { rest_id: 'rest-8', request_fingerprint: inferred } }] },
        { events: [{ event_type: 'RestStarted', payload: { rest_id: 7, request_fingerprint: F.restCommandFingerprint({ ...bare, rest_id: '7' }) } }] },
      ]) await call('assertRestIdempotency', ['C', 'k', bare], { duplicate })
    }
  } else if (fn === 'sanitizeMerchantCommand') {
    await call('merchantCommandFingerprint', [command])
  } else if (fn === 'sanitizePlayerCharacterCommand' && SETS.PLAYER_CHARACTER_COMMANDS.has(type)) {
    await call('characterBuildFingerprint', [command])
    const fingerprint = F.characterBuildFingerprint(command)
    const kind = type === 'SetCharacterChoices' ? 'CharacterChoicesUpdated' : 'SpellSelectionsUpdated'
    for (const result of [
      { mechanics: [{ event_type: kind, payload: { request_fingerprint: fingerprint } }] },
      { mechanics: [{ event_type: kind, payload: { request_fingerprint: fingerprint } }, { event_type: kind, payload: { request_fingerprint: fingerprint } }] },
      { mechanics: [{ event_type: kind, payload: {} }] },
      { mechanics: [] },
    ]) await call('assertCharacterBuildResultFingerprint', [result, [command]])
    await call('assertCharacterBuildResultFingerprint', [{ mechanics: [{ event_type: kind, payload: { request_fingerprint: fingerprint } }] }, [command, command]])
  } else if (fn === 'sanitizePlayerItemCommand') {
    await call('itemCommandFingerprint', [command])
    const fingerprint = F.itemCommandFingerprint(command)
    for (const result of resultsFor(SETS.ITEM_PRIMARY_EVENT_TYPES, fingerprint)) await call('assertItemResultFingerprint', [result, command])
    for (const duplicate of duplicatesFor(SETS.ITEM_PRIMARY_EVENT_TYPES, fingerprint)) await call('assertItemIdempotency', ['C', 'k', command], { duplicate })
  } else if (fn === 'sanitizePlayerLootCommand') {
    await call('lootCommandFingerprint', [command])
    const fingerprint = F.lootCommandFingerprint(command)
    for (const result of resultsFor(SETS.LOOT_PRIMARY_EVENT_TYPES, fingerprint)) await call('assertLootResultFingerprint', [result, command])
    for (const duplicate of duplicatesFor(SETS.LOOT_PRIMARY_EVENT_TYPES, fingerprint)) await call('assertLootIdempotency', ['C', 'k', command], { duplicate })
    const reversed = { ...command, lines: [...command.lines].reverse() }
    await call('lootCommandFingerprint', [reversed])
    await call('lootTakenRecordFor', [state, command.container_id], { stateArgs: [0] })
  } else if (fn === 'sanitizePlayerNpcCombatCommand') {
    const fingerprint = npcCombatRequestFingerprint(command)
    for (const result of resultsFor(SETS.NPC_COMBAT_PRIMARY_EVENT_TYPES, fingerprint)) await call('assertNpcCombatResultFingerprint', [result, command])
    for (const duplicate of duplicatesFor(SETS.NPC_COMBAT_PRIMARY_EVENT_TYPES, fingerprint)) await call('assertNpcCombatIdempotency', ['C', 'k', command], { duplicate })
  } else if (fn === 'sanitizePlayerLetterCommand') {
    for (let index = 0; index < 3; index += 1) {
      const reply = pick(REPLIES)
      await call('withCourierReplyDraft', [state, { ...command, ...(chance(0.5) ? { command_id: `cmd-${index}` } : {}) }], { stateArgs: [0], model: chance(0.85), reply, full: true })
    }
  } else if (type === 'MakeAttack') {
    await call('makeAttackCommandFingerprint', [command])
    const fingerprint = F.makeAttackCommandFingerprint(command)
    const variants = [
      null,
      { events: [{ event_type: 'AttackResolved', payload: { request_fingerprint: fingerprint } }] },
      { events: [{ event_type: 'CombatActionUsed', payload: { action_id: 'sanctuary-blocked', request_fingerprint: fingerprint } }] },
      { events: [{ event_type: 'CombatStarted', payload: { opening_action: { status: 'deferred', command_type: 'MakeAttack', request_fingerprint: fingerprint } } }] },
      { events: [{ event_type: 'CombatStarted', payload: { opening_action: { status: 'resolved', command_type: 'MakeAttack', request_fingerprint: fingerprint } } }] },
      { events: [{ event_type: 'AttackResolved', payload: { request_fingerprint: fingerprint } }, { event_type: 'AttackResolved', payload: { request_fingerprint: fingerprint } }] },
      { events: [{ event_type: 'AttackResolved', payload: { request_fingerprint: 'другой' } }] },
      { events: [{ event_type: 'AttackResolved', payload: {} }] },
      'throw',
    ]
    for (const duplicate of variants) {
      await call('assertMakeAttackIdempotency', ['C', 'k', [command], undefined], { duplicate, authorize: pick([null, 'ok', 'throw']) })
    }
    await call('assertMakeAttackIdempotency', ['C', 'k', [command, { command_type: 'EndTurn' }, command], undefined], { duplicate: variants[5], authorize: 'ok' })
    await call('assertMakeAttackIdempotency', ['C', 'k', [{ command_type: 'EndTurn' }], undefined], { duplicate: variants[1] })
    for (const duplicate of variants.slice(1, 6)) {
      if (duplicate !== 'throw') await call('assertMakeAttackResultFingerprint', [{ mechanics: duplicate.events }, [command]])
    }
    await call('assertMakeAttackResultFingerprint', [null, [command]])
  }
  void setting
}

async function exercise(command, state) {
  const type = F.commandType(command)
  const setting = pickUser(state)
  const fn = sanitizerFor(type)
  const extra = fn === 'sanitizeMerchantCommand' ? [pick([undefined, undefined, null, 'route-merchant', '', 5, 'r'.repeat(130)])] : fn === 'sanitizePlayerCombatCommand' ? [chance(0.3) ? { skipAttackTargetPolicy: true } : undefined] : []
  const output = await call(fn, [setting.user, state, command, ...extra], { stateArgs: [1], memberships: setting.memberships })
  if (chance(0.12)) {
    const other = pick(ALL_SANITIZERS.filter((name) => name !== fn))
    await call(other, [setting.user, state, command], { stateArgs: [1], memberships: setting.memberships })
  }
  if (type === 'MakeAttack' ? chance(0.6) : chance(0.04)) await call('normalizeMakeAttackCommand', [command])
  if (SETS.PLAYER_COMBAT_COMMANDS.has(type) && chance(0.3)) {
    await call('assertPlayerCombatActorPermission', [setting.user, state, command], { stateArgs: [1], memberships: setting.memberships })
    await call('combatActorFor', [state, command.actor_id ?? command.actorId], { stateArgs: [0] })
  }
  if (type === 'AttackNpc' && chance(0.5)) await call('assertNpcCombatActorPermission', [setting.user, state, command], { stateArgs: [1], memberships: setting.memberships })
  if (chance(0.05)) await call('authoritativeCombatCommandBase', [command])
  if (output.out.ok) await followUps(fn, output.out.ok, state, setting)
}

// --- прогон ------------------------------------------------------------------------------

const syntheticStates = [SYNTHETIC_STATE, NULL_STATE, NULL_FIRST_STATE, EMPTY_STATE]
for (const state of syntheticStates) {
  for (const command of syntheticCommands(state)) {
    await exercise(command, state)
    for (let index = 0; index < 2; index += 1) await exercise(mutate(command, state), state)
  }
}

for (const { command, state: stateId } of corpus) {
  const state = loadState(stateId)
  const clean = clientShape(command)
  await exercise(clean, state)
  for (let index = 0; index < 4; index += 1) await exercise(mutate(clean, state), state)
  if (chance(0.1)) await exercise(command, state)
  for (const synthetic of chance(0.02) ? syntheticCommands(state) : []) await exercise(synthetic, state)
}

// Почта: тон по отношению — варианты отношения к адресату.
for (const { command, state: stateId } of corpus.filter((entry) => entry.command.command_type === 'SendLetter')) {
  const state = loadState(stateId)
  const addressee = String(command.addressee_id ?? '')
  for (const score of [-60, -30, 0, 30, 60, '25', null]) {
    const varied = structuredClone(state)
    varied.social = { ...(varied.social ?? {}), relationships: { ...(varied.social?.relationships ?? {}), [addressee]: { [String(command.actor_id)]: score } } }
    const clean = clientShape(command)
    const output = await call('sanitizePlayerLetterCommand', [{ id: 'u-admin', role: 'admin', heroIds: [] }, varied, clean], { stateArgs: [1] })
    if (output.out.ok) await call('withCourierReplyDraft', [varied, output.out.ok], { stateArgs: [0], model: true, reply: REPLIES[0], full: true })
  }
}

// Отпечатки итогов корпуса: события настоящих коммитов.
for (const { command, events } of resultEvents) {
  await call('makeAttackEventFingerprints', [events])
  const result = { mechanics: events }
  const type = F.commandType(command)
  if (type === 'MakeAttack') await call('assertMakeAttackResultFingerprint', [result, [command]])
  if (SETS.ITEM_PRIMARY_EVENT_TYPES && SETS.PLAYER_ITEM_COMMANDS.has(type)) await call('assertItemResultFingerprint', [result, command])
  if (SETS.PLAYER_REST_COMMANDS.has(type)) await call('assertRestResultFingerprint', [result, command])
  if (SETS.PLAYER_LOOT_COMMANDS.has(type)) await call('assertLootResultFingerprint', [result, command])
  if (type === 'AttackNpc') await call('assertNpcCombatResultFingerprint', [result, command])
  if (SETS.PLAYER_CHARACTER_COMMANDS.has(type)) await call('assertCharacterBuildResultFingerprint', [result, [command]])
  if (SETS.PLAYER_MERCHANT_COMMANDS.has(type)) await call('merchantCommandFingerprint', [command])
}

// Прямые вызовы: commandType на мусоре, отпечатки на сырых командах,
// лётопись добычи, canUseHero по кодам кампании.
for (const value of [null, 0, 'x', [], {}, { type: 5 }, { commandType: ['a', 'b'] }, { command_type: { a: 1 } }, { command_type: null, type: 'X' }, { command_type: '', commandType: 'Y' }]) {
  await call('commandType', [value])
}
const rawCommands = [...syntheticCommands(SYNTHETIC_STATE), ...corpus.slice(0, 300).map((entry) => entry.command)]
for (const command of rawCommands) {
  for (const fn of ['itemCommandFingerprint', 'makeAttackCommandFingerprint', 'restCommandFingerprint', 'lootCommandFingerprint', 'merchantCommandFingerprint']) {
    if (chance(0.35)) await call(fn, [mutate(command, SYNTHETIC_STATE)])
  }
  const type = F.commandType(command)
  if (SETS.PLAYER_CHARACTER_COMMANDS.has(type) || chance(0.1)) {
    const mutated = mutate(command, SYNTHETIC_STATE)
    for (const key of ['class_skill_proficiencies', 'selected_feature_ids', 'known_spell_ids', 'prepared_spell_ids']) {
      const value = mutated[key]
      if (value != null && !Array.isArray(value) && typeof value !== 'string') delete mutated[key]
    }
    await call('characterBuildFingerprint', [mutated])
  }
}
const RAW_FINGERPRINTS = [
  ['itemCommandFingerprint', { item_id: 'x', command_type: 'UseItem', to: 'abc' }], ['itemCommandFingerprint', { command_type: 'UseItem', to: false }],
  ['itemCommandFingerprint', { command_type: 'UseItem', to: { x: 'a' } }], ['itemCommandFingerprint', { command_type: 'TransferItem', quantity: null }],
  ['merchantCommandFingerprint', { command_type: 'BuyItem' }], ['merchantCommandFingerprint', { command_type: 'SellItem', quantity: '2' }],
  ['lootCommandFingerprint', { command_type: 'LootContainer', lines: 'abc' }], ['lootCommandFingerprint', { command_type: 'LootContainer', lines: [null, 'x', { quantity: null }] }],
  ['restCommandFingerprint', { command_type: 'StartRest', kind: 'long', actor_id: 'h' }], ['restCommandFingerprint', { command_type: 'CompleteRest', rest_id: 5 }],
]
for (const [fn, variant] of RAW_FINGERPRINTS) await call(fn, [variant])
for (const container of ['loot:corpse:1', 'loot:chest', 'loot:corpse:2', '', undefined, null, 0, 'нет']) {
  await call('lootTakenRecordFor', [SYNTHETIC_STATE, container], { stateArgs: [0] })
}
await call('lootTakenRecordFor', [{}, 'loot:corpse:1'], { stateArgs: [0] })
for (const state of [SYNTHETIC_STATE, ...corpus.slice(0, 12).map((entry) => loadState(entry.state))]) {
  for (const { user, memberships } of usersFor(state)) {
    for (const hero of [...heroIdsOf(state).slice(0, 2), '', null, 0, 'нет', 'constructor']) {
      for (const code of [state.sessionCode, '', '  ', String(state.sessionCode ?? '').toLowerCase(), null, 'OTHER']) {
        if (chance(0.2)) await call('canUseHero', [user, hero, code], { memberships })
      }
    }
  }
  for (const actor of [...ids(state).heroes, ...ids(state).actors, 'нет', undefined, null, 5]) {
    await call('combatActorFor', [state, actor], { stateArgs: [0] })
  }
}

// --- запись ------------------------------------------------------------------------------

const sets = Object.fromEntries(Object.entries(SETS).map(([name, set]) => [name, [...set]]))
const fixture = {
  format: 'sk-server.command-guard/1',
  source: 'server/index.mjs',
  source_sha256: sha(source),
  ranges: RANGES,
  sets,
  users: Object.fromEntries([...users].map(([text, id]) => [id, JSON.parse(text)])),
  states: Object.fromEntries(states),
  cases,
}
const text = JSON.stringify(fixture)
writeFileSync(FIXTURE, text)
const byFn = {}
for (const entry of cases) byFn[entry.fn] = (byFn[entry.fn] ?? 0) + 1
const errors = cases.filter((entry) => entry.out.err).length
console.log(`эталон: ${FIXTURE.pathname} — ${cases.length} случаев (${errors} отказов), ${states.size} состояний, ${(text.length / 1e6).toFixed(2)} МБ`)
console.log(`урезанное состояние не подошло: ${trimmedFallbacks}; выброшено с одиноким суррогатом: ${excludedLoneSurrogate}`)
console.log(Object.entries(byFn).sort((a, b) => b[1] - a[1]).map(([fn, n]) => `${fn}:${n}`).join(' '))
console.log(`sha256 index.mjs (LF): ${sha(source)}`)
