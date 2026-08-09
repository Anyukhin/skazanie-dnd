import { createHash } from 'node:crypto'

import { normalizeNpcWorldState, presentSceneNpcs, sceneLocationId } from './npc-positioning.mjs'
import { factionIdsForNpc } from './reputation-policy.mjs'

/**
 * Свидетели и слухи: мир узнаёт о поступках отряда.
 *
 * До этого модуля свидетель в проекте поднимался ровно на насилие
 * (`npcHarmEventDrafts`, `propagateWitnesses`), а слой слухов был готов целиком
 * и **пуст**: `RecordRumor` не вызывал ни один серверный контур, команда жила
 * только в админской ручке (`docs/dnd-table-situations.md`, B5 и D1).
 *
 * Здесь замыкается петля, и она устроена в три шага:
 *
 * 1. **Поступок.** Летопись поступков (`state.world_deeds`) выводится
 *    редьюсером из уже подтверждённых событий — своих команд и своих событий
 *    поступок не заводит. Это не экономия, а инвариант: то, что выводится из
 *    журнала, переживает replay по построению и не может разойтись с ним.
 *    Каждая запись несёт место, время кампании и **список свидетелей** — живых
 *    NPC, которые в этот момент были в сцене. Видимость поступка меряется их
 *    числом: бой на площади видят все, тёмный переулок — никто.
 * 2. **Слух.** Поступок со свидетелями рождает слух не сразу: через
 *    детерминированную задержку по тяжести, и дальше — по суткам на каждый шаг
 *    графа мира (`server/world-map.mjs`). Слух — это `RecordRumor` в памяти
 *    мира, то есть обычное событие движка; держатель — конкретный NPC, поэтому
 *    его читает уже существующий социальный контроллер.
 * 3. **Реакция.** Дошедший слух двигает репутацию фракций держателя
 *    существующим механизмом (`FactionReputationAdjusted` →
 *    `server/reputation-policy.mjs`): цены, СЛ разговора и доступность услуг.
 *
 * Слухи пишутся с видимостью `gm_only` намеренно: игрок узнаёт их из уст NPC
 * или подслушав, а не из проекции состояния. Ведущий видит их целиком.
 */

export const WORLD_DEEDS_SCHEMA_VERSION = 1
export const WORLD_DEEDS_POLICY_ID = 'skazanie:world-deeds-v1'
export const WORLD_RUMOR_POLICY_ID = 'skazanie:world-rumor-v1'

/** Сутки игрового времени на один шаг по графу мира. */
export const RUMOR_HOP_MINUTES = 1_440
/** Дальше двух шагов слух в этой редакции не уходит: третий пересказ — уже небыль. */
export const MAX_RUMOR_HOPS = 2
/** Крупный дар — от 5 зм: ниже этого подарок не молва, а мелочь. */
export const GENEROSITY_THRESHOLD_CP = 500
const MAX_DEEDS = 200
const MAX_WITNESSES = 40

/**
 * Задержка рождения местной молвы. Чем тяжелее поступок, тем быстрее о нём
 * говорят: тяжкое обсуждают к вечеру, мелочь — на следующий день.
 */
export const DEED_LOCAL_DELAY_MINUTES = Object.freeze({ grave: 360, major: 720, minor: 1_440 })

/** Базовая поправка репутации у прямых свидетелей; дальше делится по дальности. */
const DEED_REPUTATION_BASE = Object.freeze({ grave: 8, major: 5, minor: 2 })

/**
 * Что считается поступком с моральным весом. Таблица закрытая и серверная:
 * ни модель, ни клиент в неё не добавляют.
 */
export const DEED_KINDS = Object.freeze({
  murder: Object.freeze({ alignment: 'dark', severity: 'grave', label: 'Убийство' }),
  arson: Object.freeze({ alignment: 'dark', severity: 'major', label: 'Поджог' }),
  theft: Object.freeze({ alignment: 'dark', severity: 'major', label: 'Кража' }),
  destruction: Object.freeze({ alignment: 'dark', severity: 'major', label: 'Разрушение' }),
  violence: Object.freeze({ alignment: 'dark', severity: 'minor', label: 'Насилие' }),
  vandalism: Object.freeze({ alignment: 'dark', severity: 'minor', label: 'Погром' }),
  promise_broken: Object.freeze({ alignment: 'dark', severity: 'minor', label: 'Нарушенное слово' }),
  rescue: Object.freeze({ alignment: 'bright', severity: 'major', label: 'Спасение' }),
  generosity: Object.freeze({ alignment: 'bright', severity: 'major', label: 'Щедрость' }),
  promise_kept: Object.freeze({ alignment: 'bright', severity: 'minor', label: 'Сдержанное слово' }),
})

/**
 * Три ступени точности пересказа. Нулевая — то, что видели своими глазами;
 * первая — соседняя локация; вторая — край карты, где от правды остаётся
 * только направление.
 */
const RUMOR_PHRASES = Object.freeze({
  murder: Object.freeze([
    'В «{place}» от руки {who} погиб(ла) {what}. Тому есть свидетели.',
    'Говорят, в «{place}» кто-то из чужаков убил человека.',
    'Слыхал, будто в «{place}» пришлые устроили резню. Врут, поди.',
  ]),
  violence: Object.freeze([
    'В «{place}» {who} поднял(а) руку на {what}. Тому есть свидетели.',
    'Говорят, в «{place}» чужаки кого-то избили.',
    'Слыхал, будто в «{place}» пришлые чуть не убили человека.',
  ]),
  arson: Object.freeze([
    'В «{place}» {who} пустил(а) огонь по {what}. Тому есть свидетели.',
    'Говорят, в «{place}» из-за чужаков случился пожар.',
    'Слыхал, будто «{place}» едва не выгорело дотла по вине проезжих.',
  ]),
  vandalism: Object.freeze([
    'В «{place}» {who} разнёс(ла) {what}. Тому есть свидетели.',
    'Говорят, в «{place}» чужаки переломали хозяйское добро.',
    'Слыхал, будто в «{place}» проезжие разгромили целый дом.',
  ]),
  theft: Object.freeze([
    'В «{place}» {who} обчистил(а) {what}. Тому есть свидетели.',
    'Говорят, в «{place}» чужаки взяли чужое.',
    'Слыхал, будто в «{place}» проезжие обобрали полгорода.',
  ]),
  destruction: Object.freeze([
    'В «{place}» после {who} осталось разрушение: {what}. Тому есть свидетели.',
    'Говорят, в «{place}» после чужаков остались руины.',
    'Слыхал, будто «{place}» после проезжих и не узнать.',
  ]),
  promise_broken: Object.freeze([
    'В «{place}» {who} не сдержал(а) слово, данное {what}. Тому есть свидетели.',
    'Говорят, слову этих чужаков в «{place}» верить нельзя.',
    'Слыхал, будто те пришлые обманули всех, кому что-то обещали.',
  ]),
  rescue: Object.freeze([
    'В «{place}» {who} отбил(а) нападение и заслонил(а) людей. Тому есть свидетели.',
    'Говорят, в «{place}» чужаки заступились за местных.',
    'Слыхал, будто в «{place}» пришлые кого-то спасли. Может, и правда.',
  ]),
  generosity: Object.freeze([
    'В «{place}» {who} отдал(а) {what} и не взял(а) ничего взамен. Тому есть свидетели.',
    'Говорят, в «{place}» чужаки щедро одарили местных.',
    'Слыхал, будто те проезжие золото раздают направо и налево.',
  ]),
  promise_kept: Object.freeze([
    'В «{place}» {who} сдержал(а) слово, данное {what}. Тому есть свидетели.',
    'Говорят, слову этих чужаков в «{place}» верить можно.',
    'Слыхал, будто те пришлые слово держат. Редкость нынче.',
  ]),
})

/** Русские имена видов обстановки: латинский `kind` в молву попадать не должен. */
const PROP_KIND_LABELS = Object.freeze({
  container: 'чужие пожитки',
  corpse: 'останки погибшего',
  relic: 'святыню',
  campfire: 'костёр',
  lore: 'обстановку',
  furnishing: 'обстановку',
})

const clone = (value) => structuredClone(value)
const text = (value, maximum = 300) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback
const comparable = (value) => text(value, 180).toLocaleLowerCase('ru')

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex').slice(0, 20)
}

function severityOf(kind) {
  return DEED_KINDS[kind]?.severity ?? 'minor'
}

function alignmentOf(kind) {
  return DEED_KINDS[kind]?.alignment ?? 'dark'
}

function safeDeed(value = {}) {
  const kind = DEED_KINDS[text(value.kind, 40)] ? text(value.kind, 40) : ''
  if (!kind) return null
  const id = text(value.id, 120)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(id)) return null
  const atMinutes = Math.max(0, integer(value.at_minutes, 0))
  const severity = ['grave', 'major', 'minor'].includes(String(value.severity)) ? String(value.severity) : severityOf(kind)
  const witnessIds = [...new Set((Array.isArray(value.witness_ids) ? value.witness_ids : [])
    .map((entry) => text(entry, 120)).filter(Boolean))].sort().slice(0, MAX_WITNESSES)
  return {
    id,
    kind,
    alignment: ['dark', 'bright'].includes(String(value.alignment)) ? String(value.alignment) : alignmentOf(kind),
    severity,
    actor_ids: [...new Set((Array.isArray(value.actor_ids) ? value.actor_ids : []).map((entry) => text(entry, 120)).filter(Boolean))].slice(0, 12),
    actor_names: [...new Set((Array.isArray(value.actor_names) ? value.actor_names : []).map((entry) => text(entry, 120)).filter(Boolean))].slice(0, 12),
    subject: text(value.subject, 180),
    location_id: text(value.location_id, 180),
    location_name: text(value.location_name, 180),
    at_minutes: atMinutes,
    witness_ids: witnessIds,
    secret: witnessIds.length === 0,
    summary: text(value.summary, 500),
    source_event_ids: [...new Set((Array.isArray(value.source_event_ids) ? value.source_event_ids : []).map((entry) => text(entry, 120)).filter(Boolean))].slice(0, 10),
    spread_at_minutes: Math.max(atMinutes, integer(value.spread_at_minutes, atMinutes + (DEED_LOCAL_DELAY_MINUTES[severity] ?? RUMOR_HOP_MINUTES))),
    reputation_faction_ids: [...new Set((Array.isArray(value.reputation_faction_ids) ? value.reputation_faction_ids : [])
      .map((entry) => text(entry, 120)).filter(Boolean))].sort().slice(0, 60),
    policy_id: WORLD_DEEDS_POLICY_ID,
  }
}

export function normalizeWorldDeedsState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const deeds = []
  const seen = new Set()
  for (const raw of Array.isArray(source.deeds) ? source.deeds : []) {
    const deed = safeDeed(raw)
    if (!deed || seen.has(deed.id)) continue
    seen.add(deed.id)
    deeds.push(deed)
  }
  return { schema_version: WORLD_DEEDS_SCHEMA_VERSION, deeds: deeds.slice(-MAX_DEEDS) }
}

function heroNameFor(state, actorId) {
  const expected = String(actorId ?? '')
  const hero = (state?.players ?? []).find((player) => String(player?.id ?? '') === expected)
  return text(hero?.character || hero?.name, 120)
}

function partyLabel(state, actorNames) {
  if (actorNames.length) return actorNames.join(', ')
  return text(state?.partyName, 120) || 'отряд'
}

/** Свидетели — живые NPC текущей сцены. Число свидетелей и есть видимость поступка. */
function sceneWitnessIds(state) {
  return presentSceneNpcs(state).map((npc) => String(npc.id)).sort()
}

function promiseFor(state, promiseId) {
  const expected = String(promiseId ?? '')
  return (state?.social?.promises ?? []).find((entry) => String(entry?.id ?? '') === expected) ?? null
}

function npcNameFor(state, npcId) {
  const expected = String(npcId ?? '')
  const npc = (state?.social?.npcs ?? []).find((entry) => String(entry?.id ?? '') === expected)
  return text(npc?.name, 160) || expected
}

/**
 * Распознавание поступка в подтверждённом событии. Возвращает описание без
 * идентификатора и времени — их доставляет `deedFromEvent`.
 *
 * @returns {{ kind: string, subject?: string, actorIds?: string[], witnessIds?: string[] } | null}
 */
function recognizeDeed(state, event) {
  const type = String(event?.event_type ?? '')
  const payload = event?.payload ?? {}
  if (type === 'NpcDied') {
    return { kind: 'murder', subject: text(payload.npc_name, 160) || npcNameFor(state, payload.npc_id), actorIds: [payload.source_actor_id ?? event.actor_id] }
  }
  if (type === 'NpcHarmed') {
    // Смертельный удар описан отдельным поступком: считать его дважды нельзя.
    if (integer(payload.hp_after, 0) <= 0) return null
    return { kind: 'violence', subject: text(payload.npc_name, 160) || npcNameFor(state, payload.npc_id), actorIds: [payload.source_actor_id ?? event.actor_id] }
  }
  if (type === 'SceneObjectOperated') {
    const what = PROP_KIND_LABELS[text(payload.kind, 40)] ?? 'обстановку'
    if (payload.intent === 'ignite') return { kind: 'arson', subject: what, actorIds: [event.actor_id] }
    if (payload.intent === 'topple') return { kind: 'vandalism', subject: what, actorIds: [event.actor_id] }
    if (payload.intent === 'take') {
      // Хозяина у пропса в движке нет (`docs/dnd-table-situations.md`, B1),
      // поэтому кражей считается взятое **на людях**: пустое подземелье
      // поступком не становится и ленту ведущего не засоряет.
      const witnessIds = sceneWitnessIds(state)
      if (!witnessIds.length) return null
      return { kind: 'theft', subject: what, actorIds: [event.actor_id], witnessIds }
    }
    return null
  }
  if (type === 'WorldFactRecorded' && text(payload.fact?.predicate, 120) === 'scene_change') {
    return { kind: 'destruction', subject: text(payload.fact?.object || payload.fact?.summary, 180), actorIds: [] }
  }
  if (type === 'NpcPromiseResolved') {
    const status = text(payload.status, 30)
    if (!['broken', 'fulfilled'].includes(status)) return null
    const promise = promiseFor(state, payload.promise_id)
    if (!promise) return null
    return {
      kind: status === 'broken' ? 'promise_broken' : 'promise_kept',
      subject: npcNameFor(state, promise.npc_id),
      actorIds: [promise.hero_id],
      // Обещание помнит тот, кому его дали, даже если рядом больше никого нет.
      witnessIds: [...new Set([String(promise.npc_id), ...sceneWitnessIds(state)])].filter(Boolean).sort(),
    }
  }
  if (type === 'ItemTransferred' && text(payload.recipient_kind, 40) === 'npc') {
    const price = Math.max(0, integer(payload.item?.base_price_cp, 0)) * Math.max(1, integer(payload.quantity, 1))
    if (price < GENEROSITY_THRESHOLD_CP) return null
    return {
      kind: 'generosity',
      subject: text(payload.item?.name, 160) || 'дар',
      actorIds: [payload.from_actor_id ?? event.actor_id],
      witnessIds: [...new Set([text(payload.to_actor_id, 120), ...sceneWitnessIds(state)])].filter(Boolean).sort(),
    }
  }
  if (type === 'WitnessConsequencePropagated' && text(payload.outcome, 30) === 'helpful') {
    const witnessIds = [...new Set((Array.isArray(payload.witness_ids) ? payload.witness_ids : []).map((entry) => text(entry, 120)).filter(Boolean))].sort()
    if (!witnessIds.length) return null
    return { kind: 'rescue', subject: text(state?.scene?.location, 180) || 'местных', actorIds: [], witnessIds }
  }
  return null
}

/**
 * Идентификатор поступка выводится из содержимого команды, а не из `event_id`:
 * до коммита события идентификатора ещё нет, и ключ от него разошёлся бы между
 * предварительной проекцией и replay.
 */
function deedIdFor(event, recognized, atMinutes) {
  return `deed:${digest(event?.command_id ?? event?.event_id ?? '', event?.event_type ?? '', recognized.kind, recognized.subject ?? '', atMinutes)}`
}

function summaryFor(state, deed) {
  const who = partyLabel(state, deed.actor_names)
  const place = deed.location_name || 'неизвестном месте'
  const what = deed.subject || '—'
  const table = {
    murder: `${who}: убит(а) ${what} (${place})`,
    violence: `${who}: побои — ${what} (${place})`,
    arson: `${who}: поджог — ${what} (${place})`,
    vandalism: `${who}: погром — ${what} (${place})`,
    theft: `${who}: кража — ${what} (${place})`,
    destruction: `${who}: разрушение — ${what} (${place})`,
    promise_broken: `${who}: нарушено слово, данное ${what} (${place})`,
    promise_kept: `${who}: сдержано слово, данное ${what} (${place})`,
    generosity: `${who}: дар — ${what} (${place})`,
    rescue: `${who}: защита людей (${place})`,
  }
  return text(table[deed.kind] ?? `${who}: ${deed.kind} (${place})`, 500)
}

/**
 * Поступок из подтверждённого события. Чистая функция: одинаковый вход даёт
 * одинаковый выход, поэтому replay воспроизводит летопись байт в байт.
 */
export function deedFromEvent(state = {}, event = {}) {
  const recognized = recognizeDeed(state, event)
  if (!recognized) return null
  const atMinutes = Math.max(0, integer(state?.mechanics?.world_time?.elapsed_minutes, 0))
  const witnessIds = (recognized.witnessIds ?? sceneWitnessIds(state))
    .map((entry) => text(entry, 120)).filter(Boolean)
  const actorIds = (recognized.actorIds ?? []).map((entry) => text(entry, 120)).filter(Boolean)
  const severity = severityOf(recognized.kind)
  const deed = safeDeed({
    id: deedIdFor(event, recognized, atMinutes),
    kind: recognized.kind,
    alignment: alignmentOf(recognized.kind),
    severity,
    actor_ids: actorIds,
    actor_names: actorIds.map((actorId) => heroNameFor(state, actorId)).filter(Boolean),
    subject: recognized.subject,
    location_id: sceneLocationId(state),
    location_name: text(state?.scene?.location ?? state?.scene?.title, 180),
    at_minutes: atMinutes,
    witness_ids: witnessIds,
    source_event_ids: [text(event?.event_id, 120)].filter(Boolean),
    spread_at_minutes: atMinutes + (DEED_LOCAL_DELAY_MINUTES[severity] ?? RUMOR_HOP_MINUTES),
  })
  if (!deed) return null
  return { ...deed, summary: summaryFor(state, deed) }
}

/**
 * Редьюсер летописи поступков. Кроме распознавания он отмечает фракции, которым
 * слух уже сдвинул репутацию: без этой отметки повторный тик заплатил бы за тот
 * же слух второй раз.
 */
export function applyWorldDeedEvent(input, event, state = {}) {
  const ledger = normalizeWorldDeedsState(input)
  if (String(event?.event_type ?? '') === 'FactionReputationAdjusted'
    && text(event?.payload?.provenance?.policy, 120) === WORLD_RUMOR_POLICY_ID) {
    const deedId = text(event.payload?.deed_id, 120)
    const factionId = text(event.payload?.faction_id, 120)
    if (!deedId || !factionId) return ledger
    return normalizeWorldDeedsState({
      ...ledger,
      deeds: ledger.deeds.map((deed) => deed.id === deedId
        ? { ...deed, reputation_faction_ids: [...new Set([...deed.reputation_faction_ids, factionId])] }
        : deed),
    })
  }
  const deed = deedFromEvent(state, event)
  if (!deed || ledger.deeds.some((entry) => entry.id === deed.id)) return ledger
  return normalizeWorldDeedsState({ ...ledger, deeds: [...ledger.deeds, deed] })
}

/** Лента ведущего: свежие поступки сверху, поля уже пригодны для карточки. */
export function worldDeedsFeed(state = {}, { limit = 30 } = {}) {
  return normalizeWorldDeedsState(state?.world_deeds).deeds
    .slice()
    .sort((left, right) => right.at_minutes - left.at_minutes || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(200, integer(limit, 30))))
    .map((deed) => ({
      ...clone(deed),
      label: DEED_KINDS[deed.kind]?.label ?? deed.kind,
      witness_count: deed.witness_ids.length,
    }))
}

// ---------------------------------------------------------------------------
// География: слух идёт по графу мира, а не по прямой
// ---------------------------------------------------------------------------

function worldNodes(state) {
  return Array.isArray(state?.worldMap?.locations) ? state.worldMap.locations : []
}

/** Узел графа мира по идентификатору или по названию — оба ключа законны. */
export function worldNodeIdFor(state, value) {
  const wanted = text(value, 180)
  if (!wanted) return ''
  const key = comparable(wanted)
  const nodes = worldNodes(state)
  return nodes.find((node) => String(node?.id ?? '') === wanted)?.id
    ?? nodes.find((node) => comparable(node?.name) === key)?.id
    ?? ''
}

/**
 * Расстояние в шагах графа от места происшествия до каждого известного узла.
 * Маршруты неориентированные: молва идёт по дороге в обе стороны.
 */
export function worldHopDistances(state, originNodeId) {
  const origin = text(originNodeId, 180)
  const distances = new Map()
  if (!origin) return distances
  const adjacency = new Map()
  for (const route of Array.isArray(state?.worldMap?.routes) ? state.worldMap.routes : []) {
    const from = text(route?.from, 180)
    const to = text(route?.to, 180)
    if (!from || !to) continue
    adjacency.set(from, [...(adjacency.get(from) ?? []), to])
    adjacency.set(to, [...(adjacency.get(to) ?? []), from])
  }
  distances.set(origin, 0)
  let frontier = [origin]
  for (let hop = 1; hop <= MAX_RUMOR_HOPS && frontier.length; hop += 1) {
    const next = []
    for (const node of frontier) {
      for (const neighbour of (adjacency.get(node) ?? []).slice().sort()) {
        if (distances.has(neighbour)) continue
        distances.set(neighbour, hop)
        next.push(neighbour)
      }
    }
    frontier = next.sort()
  }
  return distances
}

/** Где сейчас числится NPC: собственная локация, иначе текущая сцена. */
function npcNodeIdFor(state, npc) {
  const own = worldNodeIdFor(state, npc?.location)
  if (own) return own
  return worldNodeIdFor(state, sceneLocationId(state)) || worldNodeIdFor(state, state?.scene?.location)
}

/**
 * Кто вообще способен услышать и пересказать. Мёртвый NPC остаётся профилем в
 * `social.npcs` — держателем слуха он быть не может, и первым же поступком это
 * стало видно: убитый на площади «узнавал» о собственной гибели.
 */
function livingNpcs(state) {
  const world = normalizeNpcWorldState(state?.npc_world)
  return (Array.isArray(state?.social?.npcs) ? state.social.npcs : [])
    .filter((npc) => npc?.id && npc?.name && npc.available !== false && world.vitals[String(npc.id)]?.alive !== false)
}

export function rumorClaimId(deed, npcId) {
  return `rumor:${digest(deed?.id ?? '', npcId ?? '')}`
}

/** Формулировка слуха по дальности пересказа: 0 — точно, 2 — уже небыль. */
export function rumorWording(deed = {}, hop = 0) {
  const variants = RUMOR_PHRASES[deed.kind] ?? RUMOR_PHRASES.destruction
  const index = Math.max(0, Math.min(variants.length - 1, integer(hop, 0)))
  return text(variants[index]
    .replaceAll('{place}', deed.location_name || 'дальних краях')
    .replaceAll('{who}', (deed.actor_names ?? []).join(', ') || 'чужаки')
    .replaceAll('{what}', deed.subject || 'что-то'), 1_000)
}

/**
 * Кому и когда слух дойдёт. Свидетели знают о поступке в момент рождения
 * местной молвы; каждый следующий шаг графа стоит суток игрового времени.
 */
export function rumorSpreadTargets(state = {}, { worldMinute } = {}) {
  const minute = Math.max(0, integer(worldMinute ?? state?.mechanics?.world_time?.elapsed_minutes, 0))
  const ledger = normalizeWorldDeedsState(state?.world_deeds)
  const npcs = livingNpcs(state)
  const existingClaims = new Set((state?.worldMemory?.epistemic_claims ?? []).map((claim) => String(claim?.id ?? '')))
  const targets = []
  for (const deed of ledger.deeds) {
    // Без свидетелей поступок остаётся тайной: молве неоткуда взяться.
    if (deed.secret) continue
    if (minute < deed.spread_at_minutes) continue
    const witnesses = new Set(deed.witness_ids)
    const distances = worldHopDistances(state, worldNodeIdFor(state, deed.location_id) || worldNodeIdFor(state, deed.location_name))
    for (const npc of npcs) {
      const npcId = String(npc.id)
      const nodeId = npcNodeIdFor(state, npc)
      const hop = witnesses.has(npcId)
        ? 0
        : distances.has(nodeId) ? distances.get(nodeId) : null
      if (hop == null || hop > MAX_RUMOR_HOPS) continue
      if (minute < deed.spread_at_minutes + hop * RUMOR_HOP_MINUTES) continue
      const claimId = rumorClaimId(deed, npcId)
      if (existingClaims.has(claimId)) continue
      targets.push({ deed, npc, npc_id: npcId, hop, claim_id: claimId, claim: rumorWording(deed, hop) })
    }
  }
  return targets.sort((left, right) => left.claim_id.localeCompare(right.claim_id))
}

function deedFactId(deed) {
  return `fact:party-deed:${digest(deed.id)}`
}

function locationEntityFor(state, deed) {
  const name = deed.location_name || deed.location_id || 'Неизвестное место'
  return {
    id: `location-${digest(deed.location_id || name)}`,
    kind: 'location',
    name: text(name, 160),
    summary: '',
    aliases: [],
    // Летопись поступков принадлежит ведущему: игрок узнаёт о молве из игры.
    visibility: 'gm_only',
    tags: ['world-deeds'],
  }
}

/**
 * Команды памяти мира на один такт: факт поступка для ведущего плюс новые
 * слухи. Все — обычные команды движка, поэтому проходят валидацию и replay.
 */
export function planWorldRumorTick(state = {}, { worldMinute, limit = 24 } = {}) {
  const memory = state?.worldMemory ?? {}
  const existingEntities = new Set((memory.entities ?? []).map((entity) => String(entity?.id ?? '')))
  const existingFacts = new Set((memory.facts ?? []).map((fact) => String(fact?.id ?? '')))
  const commands = []
  const upserted = new Set()
  const ledger = normalizeWorldDeedsState(state?.world_deeds)
  const upsertEntity = (entity) => {
    if (existingEntities.has(entity.id) || upserted.has(entity.id)) return
    upserted.add(entity.id)
    commands.push({ command_type: 'UpsertWorldEntity', entity })
  }
  for (const deed of ledger.deeds) {
    const factId = deedFactId(deed)
    if (existingFacts.has(factId)) continue
    const entity = locationEntityFor(state, deed)
    upsertEntity(entity)
    commands.push({ command_type: 'RecordWorldFact', fact: {
      id: factId,
      subject_id: entity.id,
      predicate: 'party_deed',
      object: JSON.stringify({
        deed_id: deed.id, kind: deed.kind, alignment: deed.alignment, severity: deed.severity,
        at_minutes: deed.at_minutes, witnesses: deed.witness_ids.length, secret: deed.secret,
      }).slice(0, 1_000),
      summary: deed.summary,
      visibility: 'gm_only',
      source_event_ids: deed.source_event_ids,
    } })
  }
  const targets = rumorSpreadTargets(state, { worldMinute }).slice(0, Math.max(1, Math.min(60, integer(limit, 24))))
  for (const target of targets) {
    upsertEntity({
      id: target.npc_id,
      kind: 'npc',
      name: text(target.npc.name, 160),
      summary: text(target.npc.public_summary, 1_000),
      aliases: [],
      visibility: 'gm_only',
      tags: [],
    })
    commands.push({ command_type: 'RecordRumor', claim: {
      id: target.claim_id,
      holder_entity_id: target.npc_id,
      predicate: `party_deed:${target.deed.kind}`,
      claim: target.claim,
      summary: target.claim,
      visibility: 'gm_only',
      source_event_ids: target.deed.source_event_ids,
    } })
    // Прямой свидетель не пересказывает — он видел. Такой слух сразу
    // подтверждён провенансом самого поступка; пересказ остаётся `unknown`.
    if (target.hop === 0 && target.deed.source_event_ids.length) commands.push({
      command_type: 'ResolveEpistemicClaim',
      claim_id: target.claim_id,
      truth_status: 'confirmed',
      source_event_ids: target.deed.source_event_ids,
    })
  }
  return { commands, targets }
}

/** Поправка репутации по тяжести и дальности: чем дальше пересказ, тем слабее. */
export function rumorReputationDelta(deed, hop) {
  const base = DEED_REPUTATION_BASE[deed?.severity] ?? 2
  const divisor = [1, 2, 4][Math.max(0, Math.min(2, integer(hop, 0)))] ?? 4
  const magnitude = Math.max(1, Math.round(base / divisor))
  return alignmentOf(deed?.kind) === 'bright' ? magnitude : -magnitude
}

/**
 * Реакция мира: дошедший слух двигает репутацию фракций своего держателя один
 * раз на пару «поступок + фракция». Механизм существующий — новых сущностей
 * репутации здесь не заводится.
 */
export function planWorldRumorReputation(state = {}) {
  const ledger = normalizeWorldDeedsState(state?.world_deeds)
  const npcs = new Map(livingNpcs(state).map((npc) => [String(npc.id), npc]))
  const claims = (state?.worldMemory?.epistemic_claims ?? []).filter((claim) => String(claim?.kind ?? '') === 'rumor')
  const events = []
  for (const deed of ledger.deeds) {
    const paid = new Set(deed.reputation_faction_ids)
    const nearest = new Map()
    const distances = worldHopDistances(state, worldNodeIdFor(state, deed.location_id) || worldNodeIdFor(state, deed.location_name))
    for (const claim of claims) {
      const holderId = String(claim?.holder_entity_id ?? '')
      const npc = npcs.get(holderId)
      if (!npc || String(claim?.id ?? '') !== rumorClaimId(deed, holderId)) continue
      // Дальность считается тем же правилом, что и при рождении слуха: в самом
      // утверждении её нет, и хранить её отдельно значило бы завести второй
      // источник истины о географии.
      const hop = deed.witness_ids.includes(holderId)
        ? 0
        : distances.get(npcNodeIdFor(state, npc)) ?? MAX_RUMOR_HOPS
      for (const factionId of factionIdsForNpc(npc)) {
        if (paid.has(factionId)) continue
        const previous = nearest.get(factionId)
        if (previous == null || hop < previous) nearest.set(factionId, hop)
      }
    }
    for (const [factionId, hop] of [...nearest.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      events.push({
        event_type: 'FactionReputationAdjusted',
        payload: {
          faction_id: factionId,
          delta: rumorReputationDelta(deed, hop),
          deed_id: deed.id,
          deed_kind: deed.kind,
          source_event_id: deed.source_event_ids[0] ?? '',
          provenance: { source: 'server-rumor-policy', policy: WORLD_RUMOR_POLICY_ID },
        },
        target_ids: [],
        visibility: 'gm_only',
      })
    }
  }
  return events
}
