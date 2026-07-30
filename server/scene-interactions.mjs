import { createHash } from 'node:crypto'
import { serverEncounterLoot } from './loot-tables.mjs'

export const SCENE_INTERACTION_POLICY_ID = 'skazanie:scene-interactions-v1'

const CATALOG = Object.freeze([
  Object.freeze({ kind: 'container', aliases: Object.freeze(['chest', 'barrel', 'crate']), verbs: Object.freeze(['inspect', 'open', 'take']) }),
  Object.freeze({ kind: 'relic', aliases: Object.freeze(['altar', 'rune', 'statue']), verbs: Object.freeze(['inspect', 'use']) }),
  Object.freeze({ kind: 'campfire', aliases: Object.freeze(['campfire']), verbs: Object.freeze(['inspect', 'use']) }),
  Object.freeze({ kind: 'lore', aliases: Object.freeze(['bookshelf', 'table']), verbs: Object.freeze(['inspect']) }),
  Object.freeze({ kind: 'corpse', aliases: Object.freeze(['bones', 'grave', 'corpse']), verbs: Object.freeze(['inspect', 'take']) }),
])

const DETAIL_TABLE = Object.freeze({
  'container:0': Object.freeze({ id: 'scratched-mark', text: 'На внутренней стороне крышки вырезан знак прежнего владельца.' }),
  'container:1': Object.freeze({ id: 'false-bottom', text: 'Под грубой обивкой заметно неглубокое двойное дно.' }),
  'container:2': Object.freeze({ id: 'recently-moved', text: 'Пыль вокруг предмета нарушена совсем недавно.' }),
  'relic:0': Object.freeze({ id: 'old-consecration', text: 'Знаки указывают на старое защитное посвящение.' }),
  'relic:1': Object.freeze({ id: 'warning-glyph', text: 'Надпись предупреждает не тревожить печать без нужды.' }),
  'relic:2': Object.freeze({ id: 'pilgrim-sign', text: 'Символ оставлен паломниками и отмечает безопасный путь.' }),
  'campfire:0': Object.freeze({ id: 'safe-rest', text: 'Очаг можно безопасно использовать для короткого привала.' }),
  'lore:0': Object.freeze({ id: 'route-note', text: 'Среди записей найдено упоминание обходного пути.' }),
  'lore:1': Object.freeze({ id: 'name-in-margin', text: 'На полях несколько раз повторено одно и то же имя.' }),
  'lore:2': Object.freeze({ id: 'hurried-message', text: 'Короткая запись оставлена в спешке незадолго до событий сцены.' }),
  'corpse:0': Object.freeze({ id: 'cause-of-death', text: 'Следы позволяют определить вероятную причину гибели.' }),
  'corpse:1': Object.freeze({ id: 'travel-token', text: 'При останках сохранился знак, связанный с местным путём.' }),
  'corpse:2': Object.freeze({ id: 'defensive-wounds', text: 'Положение останков говорит о внезапном нападении.' }),
})

const REWARD_KEYS = Object.freeze({
  container: Object.freeze(['generic-cache', 'traveler-cache', 'guard-cache']),
  relic: Object.freeze(['minor-ward']),
  campfire: Object.freeze(['short-rest']),
  lore: Object.freeze(['written-clue']),
  corpse: Object.freeze(['personal-effects']),
})

const ASSET_ALIASES_RU = Object.freeze({
  chest: Object.freeze(['сундук', 'ларец']),
  barrel: Object.freeze(['бочка', 'бочку', 'бочке']),
  crate: Object.freeze(['ящик', 'ящика', 'ящике']),
  altar: Object.freeze(['алтарь', 'алтаря']),
  rune: Object.freeze(['руна', 'руну', 'руне']),
  statue: Object.freeze(['статуя', 'статую', 'статуе']),
  campfire: Object.freeze(['костёр', 'костер', 'очаг']),
  bookshelf: Object.freeze(['полка', 'полку', 'шкаф', 'книги']),
  table: Object.freeze(['стол', 'стола', 'столе']),
  bones: Object.freeze(['кости', 'останки', 'скелет']),
  grave: Object.freeze(['могила', 'могилу', 'могиле']),
  corpse: Object.freeze(['труп', 'трупа', 'теле']),
})

const FALLBACK_ASSETS = Object.freeze(['chest', 'altar', 'campfire', 'bookshelf', 'bones'])

export function sceneInteractionFallbackAssets() {
  return [...FALLBACK_ASSETS]
}

export function sceneInteractionAssetIds() {
  return CATALOG.flatMap((entry) => [...entry.aliases])
}

function clean(value, maximum = 160) {
  return String(value ?? '').trim().slice(0, maximum)
}

function hashNumber(value) {
  return Number.parseInt(createHash('sha256').update(clean(value, 1_000)).digest('hex').slice(0, 8), 16)
}

function assetAlias(assetId) {
  const value = clean(assetId, 120).toLowerCase()
  return CATALOG.flatMap((entry) => entry.aliases).find((alias) => (
    value === alias || value.endsWith(`/${alias}`) || value.endsWith(`-${alias}`) || value.includes(`${alias}-`)
  )) ?? null
}

export function sceneInteractionCatalogEntry(assetId) {
  const alias = assetAlias(assetId)
  if (!alias) return null
  const entry = CATALOG.find((candidate) => candidate.aliases.includes(alias))
  return entry ? { kind: entry.kind, verbs: [...entry.verbs] } : null
}

function metadataVariant(mapSeed, prop, modulus = 3) {
  return hashNumber(`${clean(mapSeed)}:${clean(prop?.id)}:${clean(prop?.assetId)}`) % Math.max(1, modulus)
}

/**
 * Строит контракт одного пропа только из серверно подтверждённых полей карты.
 * Переданный клиентом `prop.interaction` намеренно не читается.
 */
export function interactionMetadataForProp({ mapSeed = '', prop, pointOfInterest = false } = {}) {
  const catalog = sceneInteractionCatalogEntry(prop?.assetId)
  const propId = clean(prop?.id, 120)
  if (!catalog || !propId) return null
  const detailVariants = catalog.kind === 'campfire' ? 1 : 3
  const detailKey = `${catalog.kind}:${metadataVariant(mapSeed, prop, detailVariants)}`
  const rewards = REWARD_KEYS[catalog.kind] ?? []
  const rewardKey = rewards.length ? `${catalog.kind}:${rewards[metadataVariant(`${mapSeed}:reward`, prop, rewards.length)]}` : ''
  return {
    kind: catalog.kind,
    verbs: [...catalog.verbs],
    pointOfInterest: pointOfInterest === true,
    detailKey,
    rewardKey,
  }
}

/**
 * Помечает ровно 2–4 поддержанных объекта (или все, если их меньше двух).
 */
export function sceneInteractionMetadata({ mapSeed = '', props = [] } = {}) {
  const supported = (Array.isArray(props) ? props : [])
    .filter((prop) => clean(prop?.id, 120) && sceneInteractionCatalogEntry(prop?.assetId))
    .map((prop) => ({
      prop,
      score: hashNumber(`${clean(mapSeed)}:poi:${clean(prop.id)}:${clean(prop.assetId)}`),
    }))
    .sort((left, right) => left.score - right.score || clean(left.prop.id).localeCompare(clean(right.prop.id)))
  const desired = supported.length
    ? Math.min(supported.length, 2 + (hashNumber(`${clean(mapSeed)}:poi-count`) % 3))
    : 0
  const selected = new Set(supported.slice(0, desired).map(({ prop }) => clean(prop.id, 120)))
  return new Map(supported.map(({ prop }) => [
    clean(prop.id, 120),
    interactionMetadataForProp({ mapSeed, prop, pointOfInterest: selected.has(clean(prop.id, 120)) }),
  ]))
}

export function sceneInteractionDefinition({ mapSeed = '', props = [], propId = '' } = {}) {
  const prop = (Array.isArray(props) ? props : []).find((candidate) => clean(candidate?.id, 120) === clean(propId, 120))
  if (!prop) return null
  const metadata = sceneInteractionMetadata({ mapSeed, props }).get(clean(prop.id, 120))
  if (!metadata) return null
  const alias = assetAlias(prop.assetId)
  const seed = `${clean(mapSeed)}:${clean(prop.id)}:${clean(prop.assetId)}`
  const difficulty = 10 + (hashNumber(`${seed}:dc`) % 3) * 2
  const locked = metadata.kind === 'container' && hashNumber(`${seed}:locked`) % 3 === 0
  const trapped = metadata.kind === 'container' && hashNumber(`${seed}:trap`) % 4 === 0
  const detail = DETAIL_TABLE[metadata.detailKey] ?? DETAIL_TABLE[`${metadata.kind}:0`]
  return {
    ...metadata,
    alias,
    initialState: metadata.kind === 'container' ? (locked ? 'locked' : 'closed') : 'idle',
    check: metadata.kind === 'relic'
      ? { ability: 'int', skill: alias === 'altar' || alias === 'statue' ? 'religion' : 'arcana', dc: difficulty, purpose: `scene-object:${metadata.kind}:inspect` }
      : metadata.kind === 'lore' || metadata.kind === 'corpse'
        ? { ability: 'wis', skill: 'investigation', dc: difficulty, purpose: `scene-object:${metadata.kind}:inspect` }
        : null,
    lock: locked ? { ability: 'dex', skill: 'sleight_of_hand', dc: difficulty, purpose: 'scene-object:container:lock' } : null,
    trap: trapped ? {
      notice: { ability: 'wis', skill: 'perception', dc: difficulty, purpose: 'scene-object:container:trap' },
      damage: { expression: '1d4', type: 'piercing', purpose: 'scene-object:container:trap-damage' },
    } : null,
    detail: detail ? { id: detail.id, text: detail.text } : null,
    effect: metadata.kind === 'relic' ? { id: 'minor-ward', temporary_hp: 1 } : null,
  }
}

export function sceneObjectLoot({ mapSeed = '', prop } = {}) {
  const item = serverEncounterLoot({
    theme: 'generic',
    difficulty: 'easy',
    encounterId: `scene:${clean(mapSeed)}:${clean(prop?.id)}:${clean(prop?.assetId)}`,
  })[0]
  if (!item) return []
  return [{
    ...item,
    id: `scene-loot-${clean(prop?.id, 80)}-1`,
    quantity: Math.max(1, Number(item.quantity) || 1),
    equipped: false,
  }]
}

export function sceneObjectOperationFromText(text) {
  const normalized = clean(text, 1_000).toLowerCase()
  if (!normalized) return null
  const approach = /(?:разбить|сломать|взломать|выломать|ударить|топор)/u.test(normalized) ? 'force' : 'hand'
  const intent = /(?:взять|забрать|поднять|обыскать)/u.test(normalized)
    ? 'take'
    : /(?:использовать|активировать|отдохнуть|привал)/u.test(normalized)
      ? 'use'
      : /(?:открыть|разбить|сломать|взломать|выломать)/u.test(normalized)
        ? 'open'
        : /(?:осмотреть|изучить|прочитать|проверить|обыскать)/u.test(normalized)
          ? 'inspect'
          : null
  if (!intent) return null
  const aliases = Object.entries(ASSET_ALIASES_RU)
    .filter(([, words]) => words.some((word) => normalized.includes(word)))
    .map(([alias]) => alias)
  return { intent, approach, aliases }
}

function propCells(prop) {
  if (Array.isArray(prop?.footprint) && prop.footprint.length) {
    return prop.footprint
      .map((cell) => ({ x: Number(cell?.x), y: Number(cell?.y) }))
      .filter((cell) => Number.isFinite(cell.x) && Number.isFinite(cell.y))
  }
  const x = Math.floor(Number(prop?.x))
  const y = Math.floor(Number(prop?.y))
  return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : []
}

export function sceneObjectDistance(prop, actorPosition) {
  const at = { x: Number(actorPosition?.x), y: Number(actorPosition?.y) }
  if (!Number.isSafeInteger(at.x) || !Number.isSafeInteger(at.y)) return Number.POSITIVE_INFINITY
  return Math.min(...propCells(prop).map((cell) => Math.max(Math.abs(cell.x - at.x), Math.abs(cell.y - at.y))), Number.POSITIVE_INFINITY)
}

export function nearestSceneObjectCommand({ props = [], actorPosition, text } = {}) {
  const operation = sceneObjectOperationFromText(text)
  if (!operation) return null
  const candidates = (Array.isArray(props) ? props : [])
    .filter((prop) => sceneInteractionCatalogEntry(prop?.assetId))
    .filter((prop) => {
      if (!operation.aliases.length) return true
      const alias = assetAlias(prop.assetId)
      return alias && operation.aliases.includes(alias)
    })
    .map((prop) => ({ prop, distance: sceneObjectDistance(prop, actorPosition) }))
    .sort((left, right) => left.distance - right.distance || clean(left.prop.id).localeCompare(clean(right.prop.id)))
  const selected = candidates[0]?.prop
  return selected ? {
    command_type: 'OperateSceneObject',
    prop_id: clean(selected.id, 120),
    intent: operation.intent,
    approach: operation.approach,
  } : null
}

export function sceneInteractionNarration(events = []) {
  const batch = Array.isArray(events) ? events : []
  const relevant = batch.filter((event) => String(event?.event_type ?? '').startsWith('SceneObject')
    || event?.event_type === 'RestCompleted'
    || (event?.event_type === 'DamageApplied' && event?.payload?.reason === 'scene-object-trap'))
  if (!relevant.length) return ''
  const knowledge = relevant.find((event) => event.event_type === 'SceneObjectKnowledgeRevealed')
  if (knowledge?.payload?.text) return clean(knowledge.payload.text, 500)
  const loot = relevant.find((event) => event.event_type === 'SceneObjectLootGranted')
  if (loot) {
    const names = (Array.isArray(loot.payload?.loot) ? loot.payload.loot : [])
      .map((item) => clean(item?.name, 120))
      .filter(Boolean)
    return names.length ? `Находка забрана: ${names.join(', ')}.` : 'Находка забрана.'
  }
  const trap = relevant.find((event) => event.event_type === 'DamageApplied' && event.payload?.reason === 'scene-object-trap')
  if (trap) return `Сработала ловушка: ${Math.max(0, Number(trap.payload?.applied_amount) || 0)} урона.`
  const revealed = relevant.find((event) => event.event_type === 'SceneObjectLootRevealed')
  if (revealed) {
    const names = (Array.isArray(revealed.payload?.loot) ? revealed.payload.loot : [])
      .map((item) => clean(item?.name, 120))
      .filter(Boolean)
    return names.length ? `Внутри обнаружено: ${names.join(', ')}.` : 'Внутри обнаружена находка.'
  }
  const rest = relevant.find((event) => event.event_type === 'RestCompleted' && event.payload?.source_prop_id)
  if (rest) return 'У костра завершён короткий привал.'
  const state = [...relevant].reverse().find((event) => event.event_type === 'SceneObjectStateChanged')
  if (state?.payload?.success === false) return 'Попытка не удалась; состояние объекта не изменилось.'
  if (state?.payload?.state === 'open') return 'Объект открыт.'
  if (state?.payload?.state === 'taken') return 'Содержимое объекта забрано.'
  if (state?.payload?.state === 'used') return 'Эффект объекта использован.'
  const inspected = relevant.find((event) => event.event_type === 'SceneObjectInspected')
  if (inspected) return inspected.payload?.success === false
    ? 'Осмотр не дал уверенного ответа.'
    : 'Объект осмотрен.'
  return 'Взаимодействие с объектом завершено.'
}
