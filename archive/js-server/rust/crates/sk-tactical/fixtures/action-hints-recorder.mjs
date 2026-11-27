import '../../../fixtures-env.mjs'
// Перехват `suggestedActionsFor` для эталона `action-hints.json`.
//
// Подключается ключом `--import` к прогону тестового файла JS
// (`gen-action-hints.mjs` запускает их сам) или импортом в генераторе. Модуль
// `server/action-hints.mjs` грузится с переименованной функцией и обёрткой,
// которая отдаёт каждую комнату, героя-читателя и ответ в
// `globalThis.__hintsRecorder`. Поведение функции не меняется.
//
// С переменной `HINTS_RECORD_FILE` записи копятся и при выходе процесса
// дописываются в этот файл строками JSON; комната сводится к полям, которые
// читает модуль (`reduceHintsRoom`), и сведённая комната обязана давать тот же
// ответ — иначе записывается целиком.
import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/server/action-hints.mjs')) return result
    const source = String(result.source)
    const renamed = source.replace(/export function suggestedActionsFor\(room, actorId = ''\) \{/u, "function originalSuggestedActionsFor(room, actorId = '') {")
    if (renamed === source) throw new Error('не нашёл suggestedActionsFor для перехвата')
    const wrapper = `
globalThis.__originalSuggestedActionsFor = originalSuggestedActionsFor
export function suggestedActionsFor(room, actorId = '') {
  let result
  try {
    result = originalSuggestedActionsFor(room, actorId)
  } catch (error) {
    globalThis.__hintsRecorder?.(room, actorId, { error })
    throw error
  }
  globalThis.__hintsRecorder?.(room, actorId, { result })
  return result
}
`
    return { ...result, source: `${renamed}\n${wrapper}` }
  },
})

const { sceneInteractionCatalogEntry, sceneInteractionRewardKinds } = await import(new URL('../../../../server/scene-interactions.mjs', import.meta.url).href)
const REWARD_KINDS = new Set(sceneInteractionRewardKinds())

function propMatters(prop) {
  if (prop?.interactive !== true) return false
  const catalog = sceneInteractionCatalogEntry(prop?.assetId)
  if (catalog && REWARD_KINDS.has(catalog.kind)) return true
  return (Array.isArray(prop?.interaction?.verbs) ? prop.interaction.verbs : []).map(String).includes('pray')
}

const has = (object, key) => object && typeof object === 'object' && Object.hasOwn(object, key)

/** Копия только перечисленных собственных полей объекта; не-объект — как есть. */
function pick(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return object
  const result = {}
  for (const key of keys) if (Object.hasOwn(object, key)) result[key] = object[key]
  return result
}

const mapArray = (value, map) => (Array.isArray(value) ? value.map(map) : value)

/** Комната, сведённая к полям, которые читает `server/action-hints.mjs`. */
export function reduceHintsRoom(room) {
  if (!room || typeof room !== 'object' || Array.isArray(room)) return room
  const reduced = {}
  if (has(room, 'scene')) {
    const scene = pick(room.scene, ['objective', 'location', 'map'])
    if (has(scene, 'map')) {
      const map = pick(scene.map, ['props', 'doors'])
      if (has(map, 'props')) {
        // Модуль читает только интерактивный реквизит с наградой по каталогу
        // (находки) или с молитвой (святыни); прочего на карте 100×100 тысячи.
        const props = Array.isArray(map.props) ? map.props.filter(propMatters) : map.props
        map.props = mapArray(props, (prop) => {
          const copy = pick(prop, ['id', 'assetId', 'interactive', 'interaction', 'x', 'y', 'footprint'])
          if (has(copy, 'interaction')) copy.interaction = pick(copy.interaction, ['verbs', 'pointOfInterest'])
          return copy
        })
      }
      if (has(map, 'doors')) map.doors = mapArray(map.doors, (door) => pick(door, ['id', 'state']))
      scene.map = map
    }
    reduced.scene = scene
  }
  if (has(room, 'scene_npcs')) reduced.scene_npcs = mapArray(room.scene_npcs, (npc) => pick(npc, ['id', 'name', 'role', 'alive', 'stance', 'x', 'y']))
  if (has(room, 'mechanics')) {
    const mechanics = pick(room.mechanics, ['combat', 'positions'])
    if (has(mechanics, 'combat')) mechanics.combat = pick(mechanics.combat, ['active'])
    reduced.mechanics = mechanics
  }
  if (has(room, 'players')) {
    reduced.players = mapArray(room.players, (player) => {
      const copy = pick(player, ['id', 'x', 'y', 'currency', 'inventory'])
      if (has(copy, 'inventory')) copy.inventory = mapArray(copy.inventory, (item) => pick(item, ['origin']))
      return copy
    })
  }
  if (has(room, 'loot_containers')) {
    const loot = pick(room.loot_containers, ['containers'])
    if (has(loot, 'containers')) loot.containers = mapArray(loot.containers, (entry) => pick(entry, ['id', 'name', 'kind', 'status', 'item_count', 'can_inspect']))
    reduced.loot_containers = loot
  }
  if (has(room, 'social')) {
    const social = pick(room.social, ['conversations'])
    if (has(social, 'conversations')) social.conversations = mapArray(social.conversations, (entry) => pick(entry, ['npc_id']))
    reduced.social = social
  }
  if (has(room, 'merchants')) reduced.merchants = mapArray(room.merchants, (merchant) => pick(merchant, ['id']))
  for (const key of ['tavern', 'blessings', 'courier_letters', 'beasts', 'scenario_court', 'lockpicking']) {
    if (has(room, key)) reduced[key] = room[key]
  }
  return JSON.parse(JSON.stringify(reduced))
}

const errorOf = (error) => ({ name: error?.name ?? 'Error', message: String(error?.message ?? error) })
const asJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/** Ответ модуля на комнату: `{ result }` или `{ error }`. */
export function hintsOutcome(room, actorId) {
  try {
    return { result: asJson(globalThis.__originalSuggestedActionsFor(room, actorId)) }
  } catch (error) {
    return { error: errorOf(error) }
  }
}

/**
 * Снимок одного вызова. Rust видит комнату как JSON, поэтому ответ снимается
 * на JSON-копии комнаты; сведённая копия хранится, только если отвечает так
 * же, как полная.
 */
export function hintsRecord(room, actorId) {
  const full = asJson(room)
  const reduced = reduceHintsRoom(full)
  const fullOut = hintsOutcome(full, actorId)
  const reducedOut = hintsOutcome(reduced, actorId)
  return isDeepStrictEqual(fullOut, reducedOut)
    ? { room: reduced, actor: actorId, out: reducedOut }
    : { room: full ?? null, actor: actorId, out: fullOut, full: true }
}

const target = process.env.HINTS_RECORD_FILE
if (target) {
  const records = []
  globalThis.__hintsRecorder = (room, actorId) => {
    try {
      records.push(hintsRecord(room, actorId))
    } catch {
      // Комната, которую JSON не держит (циклы), в эталон не идёт.
    }
  }
  process.on('exit', () => {
    if (records.length) appendFileSync(target, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  })
}
