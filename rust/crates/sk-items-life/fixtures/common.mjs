// Общие помощники генераторов эталонов item-lifecycle.
//
// Эталон — таблица крупных аргументов (каждый хранится один раз) и случаи
// `{ fn, args, retention?, result | sha256 | undefined | error }`. Крупный
// аргумент (состояние, герои) пишется ссылкой `{ "$v": i }`, герои уже
// записанного состояния — `{ "$v": i, "path": ["players", 0] }`; `undefined` —
// `{ "$undefined": true }`. Результат длиннее RESULT_LIMIT — SHA-256 строки
// `JSON.stringify`. Исключение — `{ name, code, message }`, у `TypeError` —
// только имя (текст V8 Rust не повторяет).
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const RESULT_LIMIT = 400
const VALUE_MIN = 300
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const jsonReplacer = (_key, value) => (value instanceof Set ? [...value] : value)

export const UNDEFINED = { $undefined: true }

/** Вход через JSON: то, что увидит Rust. */
export function viaJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value, jsonReplacer))
}

export function errorOf(error) {
  if (error instanceof TypeError) return { name: 'TypeError' }
  return { name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) }
}

/** Детерминированный ГПСЧ mulberry32. */
export function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function chooser(random) {
  const int = (min, max) => min + Math.floor(random() * (max - min + 1))
  const pick = (list) => list[Math.floor(random() * list.length)]
  const chance = (p) => random() < p
  return { int, pick, chance }
}

/** Писатель эталона. */
export function fixtureWriter() {
  const values = []
  const valueIndex = new Map()
  const cases = []
  const seen = new Set()
  const perFn = new Map()
  const perOutcomeCount = new Map()

  const childIndex = new Map()

  /** Герои записанного состояния — ссылкой внутрь него. */
  function registerChildren(index, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.players)) return
    const players = JSON.stringify(value.players)
    if (players.length >= VALUE_MIN && !childIndex.has(players)) childIndex.set(players, { $v: index, path: ['players'] })
    value.players.forEach((player, position) => {
      const text = JSON.stringify(player)
      if (text && text.length >= VALUE_MIN && !childIndex.has(text)) childIndex.set(text, { $v: index, path: ['players', position] })
    })
  }

  function ref(value) {
    if (value === undefined) return UNDEFINED
    const text = JSON.stringify(value)
    if (!value || typeof value !== 'object' || text.length < VALUE_MIN) return value
    const child = childIndex.get(text)
    if (child) return child
    let index = valueIndex.get(text)
    if (index === undefined) {
      index = values.length
      values.push(JSON.parse(text))
      valueIndex.set(text, index)
      registerChildren(index, value)
    }
    return { $v: index }
  }

  /**
   * Вызвать `fn(...args)` в режиме retention и записать случай. Повтор входа
   * не пишется; `perOutcome` ограничивает число случаев с тем же исходом
   * (функция + код отказа), чтобы частые отказы не вытесняли редкие ветки.
   */
  function call(name, fn, args, { retention = 'current', cap = Infinity, perOutcome = Infinity } = {}) {
    const plain = args.map(viaJson)
    const key = sha256(JSON.stringify([name, plain, retention], (_k, v) => (v === undefined ? '\u0000undefined' : v)))
    if (seen.has(key) || (perFn.get(name) ?? 0) >= cap) return { recorded: false }
    seen.add(key)
    const entry = { fn: name }
    let value
    try {
      value = fn(...plain.map(viaJson))
      const text = value === undefined ? undefined : JSON.stringify(value, jsonReplacer)
      if (text === undefined) entry.undefined = true
      else if (text.length > RESULT_LIMIT) entry.sha256 = sha256(text)
      else entry.result = JSON.parse(text)
    } catch (error) {
      entry.error = errorOf(error)
      value = undefined
    }
    const outcomeKey = `${name}:${entry.error ? entry.error.code ?? entry.error.name : 'ok'}`
    const outcomeCount = perOutcomeCount.get(outcomeKey) ?? 0
    const limit = typeof perOutcome === 'function' ? perOutcome(outcomeKey) : perOutcome
    if (outcomeCount < limit) {
      perOutcomeCount.set(outcomeKey, outcomeCount + 1)
      perFn.set(name, (perFn.get(name) ?? 0) + 1)
      entry.args = plain.map(ref)
      if (retention !== 'current') entry.retention = retention
      cases.push({ fn: name, args: entry.args, ...(entry.retention ? { retention: entry.retention } : {}), ...Object.fromEntries(Object.entries(entry).filter(([k]) => !['fn', 'args', 'retention'].includes(k))) })
    }
    return { recorded: true, value, error: entry.error }
  }

  return {
    call,
    cases,
    counts: perFn,
    write(url) {
      const text = `{\n"values": [\n${values.map((value) => JSON.stringify(value)).join(',\n')}\n],\n"cases": [\n${cases.map((entry) => JSON.stringify(entry)).join(',\n')}\n]\n}\n`
      writeFileSync(url, text)
      console.log(`${url.pathname.split('/').at(-1)}: аргументов в таблице ${values.length}, случаев ${cases.length}, ${(text.length / 1024 / 1024).toFixed(2)} МБ`)
      console.log([...perFn.entries()].map(([name, count]) => `${name} ${count}`).join(', '))
    },
  }
}

/** Вызов экспорта по имени с аргументами эталона (опции — как у JS). */
export function dispatch(lifecycle) {
  return {
    itemProfileFor: (item, options) => lifecycle.itemProfileFor(item, options),
    inventoryWeight: (actor) => lifecycle.inventoryWeight(actor),
    carryingCapacity: (actor) => lifecycle.carryingCapacity(actor),
    inventoryLoadFor: (actor) => lifecycle.inventoryLoadFor(actor),
    activeItemEffectTotals: (actor) => lifecycle.activeItemEffectTotals(actor),
    activeItemMechanicEffects: (actor, options) => lifecycle.activeItemMechanicEffects(actor, options),
    weaponDamageRidersForItem: (actor, itemId, options) => lifecycle.weaponDamageRidersForItem(actor, itemId, options),
    equippedShieldBonus: (actor) => lifecycle.equippedShieldBonus(actor),
    derivedEquipmentArmorClass: (actor, options) => lifecycle.derivedEquipmentArmorClass(actor, options),
    validateItemLifecycleCommand: (command, state, context) => lifecycle.validateItemLifecycleCommand(command, state, context),
    itemLifecycleEvents: (command) => lifecycle.itemLifecycleEvents(command),
    applyItemLifecycleEventToPlayers: (players, event) => lifecycle.applyItemLifecycleEventToPlayers(players, event),
  }
}

const pick = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = {}
  for (const key of keys) if (Object.hasOwn(value, key)) out[key] = value[key]
  return out
}

/** Герой без листа: модуль читает только id, имя, инвентарь и характеристики. */
export const stripActor = (actor) => pick(actor, ['id', 'actor_id', 'name', 'inventory', 'abilities'])

/**
 * Состояние кампании без того, чего модуль не читает: герои, противники,
 * отряд, бой, сцена и NPC для передачи вещи NPC.
 */
export function stripState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  const out = pick(state, ['ruleset_id', 'partyMemberIds', 'npc_world'])
  for (const key of ['players', 'actors', 'enemies']) {
    if (Object.hasOwn(state, key)) out[key] = Array.isArray(state[key]) ? state[key].map(stripActor) : state[key]
  }
  if (Object.hasOwn(state, 'mechanics')) {
    const mechanics = pick(state.mechanics, ['combat'])
    out.mechanics = mechanics && typeof mechanics === 'object' && !Array.isArray(mechanics) && Object.hasOwn(mechanics, 'combat')
      ? { combat: pick(mechanics.combat, ['active', 'action_economy']) }
      : mechanics
  }
  if (Object.hasOwn(state, 'scene')) {
    const scene = pick(state.scene, ['location_id', 'locationId', 'location', 'title', 'map'])
    out.scene = scene && typeof scene === 'object' && !Array.isArray(scene) && Object.hasOwn(scene, 'map') ? { ...scene, map: pick(scene.map, ['locationId']) } : scene
  }
  if (Object.hasOwn(state, 'social')) out.social = pick(state.social, ['npcs'])
  return out
}

/** Аргументы вызова без лишнего: состояние и герои — урезанные. */
export function stripArgs(name, args) {
  if (name === 'validateItemLifecycleCommand') return [args[0], stripState(args[1]), ...args.slice(2)]
  if (name === 'applyItemLifecycleEventToPlayers') return [Array.isArray(args[0]) ? args[0].map(stripActor) : args[0], ...args.slice(1)]
  if (['inventoryWeight', 'carryingCapacity', 'inventoryLoadFor', 'activeItemEffectTotals', 'activeItemMechanicEffects', 'weaponDamageRidersForItem', 'equippedShieldBonus', 'derivedEquipmentArmorClass'].includes(name)) {
    return [stripActor(args[0]), ...args.slice(1)]
  }
  return args
}
