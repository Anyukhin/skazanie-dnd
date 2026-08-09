import { createHash } from 'node:crypto'

import { campaignElapsedMinutes } from './npc-social.mjs'
import {
  isValidNpcPost,
  npcPlacementFor,
  presentSceneNpcs,
  sceneLocationId,
} from './npc-positioning.mjs'
import { factionIdsForNpc } from './reputation-policy.mjs'

/**
 * Пленные: «мы его не убили, а допросим».
 *
 * У движка уже были обе половины этого хода и не было середины. Мораль ломала
 * врага в бегство или сдачу (`npc-controller.mjs`, `NpcMoraleAgent`), а ближняя
 * атака с `knock_out` оставляла существо без сознания и стабилизированным
 * (`CreatureKnockedOut`). Дальше не происходило ничего: сдавшийся оставался
 * боевым актором с `alive: false`, и через минуту про него забывали и стол, и
 * состояние. Отсюда и запись шага 3 — «механизма плена в движке нет», из-за
 * которой жестокость к пленному не попала в летопись поступков.
 *
 * Модуль замыкает середину и устроен так:
 *
 * 1. **Захват выводится из конца боя, а не из отдельной команды игрока.**
 *    `EndCombat` — единственный момент, когда «мы победили» уже подтверждено
 *    журналом. Сдавшийся или нокаутнутый враг подходящего вида перестаёт быть
 *    боевым актором и становится обычным NPC со своим социальным профилем: у
 *    безымянного он собирается **детерминированно от сида кампании и id
 *    актора**, поэтому replay даёт то же имя и тот же характер.
 * 2. **Пленный — состояние поверх существующего актора.** Стат-блок врага не
 *    меняется и не копируется: запись плена держит `actor_id`, `stat_block_id`
 *    и ссылку на профиль, а всё остальное берётся из уже существующих данных.
 * 3. **То, что пленный знает, лежит в памяти мира и закрыто `gm_only`.** Допрос
 *    не выдумывает факт: он раскрывает уже записанный — тем же механизмом
 *    `KnowledgeRevealed`, которым NPC раскрывает факт в разговоре. До удачной
 *    проверки игрок его не видит: ни в проекции, ни в списке пленных.
 * 4. **Голод — поступок, а не таймер в UI.** Связанного надо кормить; сутки без
 *    еды дают `CaptiveNeglected`, и летопись поступков считает это жестокостью
 *    ровно так же, как убийство пленного.
 *
 * Осознанные границы (не «забыли», а решено):
 * - пленным становится только тот, кого можно связать и допросить: волк,
 *   скелет и слизь в плен не берутся (`CAPTURABLE_CREATURE_TYPES`);
 * - кормёжка **не списывает паёк**: каталог предметов принадлежит другой
 *   задаче, и лезть в него отсюда нельзя. Механика голода при этом настоящая —
 *   она меряется мировым временем, а не наличием строки в инвентаре;
 * - сумма награды за сдачу страже выводится из XP стат-блока — числа, которое
 *   уже лежит в провенансе врага, — а не из новой таблицы цен за головы.
 */

export const CAPTIVES_SCHEMA_VERSION = 1
export const CAPTIVES_POLICY_ID = 'skazanie:captives-v1'

/**
 * Кого вообще можно взять в плен. Список закрытый и серверный: плен — это
 * связать, довести и разговорить, а с медведем, скелетом и слизью так нельзя.
 * Нелетальный нокаут при этом остаётся доступен кому угодно — он про милосердие
 * в бою, а не про допрос.
 */
export const CAPTURABLE_CREATURE_TYPES = Object.freeze(new Set([
  'humanoid', 'giant', 'fiend', 'celestial', 'dragon',
]))

export const CAPTIVE_STATUSES = Object.freeze(['held', 'released', 'handed_over', 'dead'])
export const CAPTIVE_ORIGINS = Object.freeze(['surrendered', 'knocked_out'])

/**
 * Действия с пленным. `NeglectCaptive` в наборе игрока нет намеренно: голод
 * фиксируют мировые часы, а не кнопка — иначе отряд мог бы объявить о нём сам.
 */
export const CAPTIVE_PLAYER_COMMAND_TYPES = Object.freeze(new Set([
  'InterrogateCaptive', 'ReleaseCaptive', 'HandCaptiveToGuards', 'FeedCaptive', 'ExecuteCaptive',
]))
export const CAPTIVE_COMMAND_TYPES = Object.freeze(new Set([...CAPTIVE_PLAYER_COMMAND_TYPES, 'NeglectCaptive']))

/** Сутки игрового времени без еды — и связанный начинает страдать. */
export const CAPTIVE_FEED_INTERVAL_MINUTES = 1_440

/** Виды поселений, где есть кому принять пленного. */
export const SETTLEMENT_LOCATION_KINDS = Object.freeze(new Set(['town', 'village', 'city', 'port', 'fortress']))

const MAX_CAPTIVES = 60
const MAX_KNOWN_FACTS = 2

const clone = (value) => structuredClone(value)
const text = (value, maximum = 200) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback
const comparable = (value) => text(value, 180).toLocaleLowerCase('ru')
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

/** Детерминированный выбор из таблицы: одинаковый вход — одинаковый выход. */
function pick(list, seed, salt = '') {
  const values = Array.isArray(list) ? list : []
  if (!values.length) return null
  const index = Number.parseInt(digest(seed, salt).slice(0, 8), 16) % values.length
  return values[index]
}

// ---------------------------------------------------------------------------
// Детерминированный профиль безымянного врага
// ---------------------------------------------------------------------------

const CAPTIVE_EPITHETS = Object.freeze([
  'Кривой', 'Меченый', 'Рябой', 'Тихий', 'Косматый', 'Одноухий',
  'Хромой', 'Беспалый', 'Задира', 'Битый', 'Скорый', 'Сивый',
])

const CAPTIVE_NAMES = Object.freeze([
  'Ждан', 'Бажен', 'Горыня', 'Малюта', 'Некрас', 'Путята',
  'Хват', 'Ярец', 'Гудим', 'Молчан', 'Сувор', 'Томило',
])

/**
 * Характер решает не только текст, но и сложность допроса: сломленный говорит
 * охотнее, упрямый молчит дольше. Таблица закрытая и серверная.
 */
export const CAPTIVE_TEMPERS = Object.freeze([
  Object.freeze({ id: 'broken', label: 'сломлен и покорен', dc_shift: -2, voice: 'говорит тихо, не поднимая глаз' }),
  Object.freeze({ id: 'talkative', label: 'болтлив от страха', dc_shift: -1, voice: 'тараторит и повторяется' }),
  Object.freeze({ id: 'sullen', label: 'угрюм и неразговорчив', dc_shift: 0, voice: 'отвечает односложно' }),
  Object.freeze({ id: 'haggler', label: 'хитёр и торгуется', dc_shift: 1, voice: 'на каждый ответ просит своё' }),
  Object.freeze({ id: 'defiant', label: 'дерзок даже связанным', dc_shift: 2, voice: 'цедит сквозь зубы' }),
])

/** Семья стат-блока: «goblin-warrior» и «goblin-minion» — одна ватага. */
export function captiveBandId(statBlockId, name = '') {
  const slug = text(statBlockId, 120).split(':').at(-1) ?? ''
  const family = slug.replace(/-(?:minion|warrior|captain|veteran|boss|scout|spy|guard)$/u, '')
  return text(family || comparable(name).replace(/\s+\d+$/u, '') || 'unknown', 60)
}

function captiveSeed(state, actorId) {
  return digest(text(state?.sessionCode, 60), text(actorId, 120))
}

/** Имя и характер безымянного врага. Одинаковы после каждого replay. */
export function captivePersona(state, enemy = {}) {
  const seed = captiveSeed(state, enemy.id)
  const temper = pick(CAPTIVE_TEMPERS, seed, 'temper') ?? CAPTIVE_TEMPERS[2]
  const role = text(enemy.name, 120).replace(/\s+\d+$/u, '') || 'Пленник'
  return {
    seed,
    name: `${pick(CAPTIVE_EPITHETS, seed, 'epithet')} ${pick(CAPTIVE_NAMES, seed, 'name')}`,
    role,
    temper: temper.id,
    temper_label: temper.label,
    voice: temper.voice,
  }
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

function safeCaptive(value = {}) {
  const id = text(value.id, 120)
  const npcId = text(value.npc_id, 120)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(id) || !npcId) return null
  const takenAt = Math.max(0, integer(value.taken_at_minutes, 0))
  const revealed = [...new Set((Array.isArray(value.revealed_fact_ids) ? value.revealed_fact_ids : [])
    .map((entry) => text(entry, 120)).filter(Boolean))].slice(0, MAX_KNOWN_FACTS)
  return {
    id,
    npc_id: npcId,
    actor_id: text(value.actor_id, 120),
    name: text(value.name, 160),
    role: text(value.role, 160),
    temper: CAPTIVE_TEMPERS.some((entry) => entry.id === value.temper) ? String(value.temper) : 'sullen',
    origin: CAPTIVE_ORIGINS.includes(value.origin) ? value.origin : 'surrendered',
    status: CAPTIVE_STATUSES.includes(value.status) ? value.status : 'held',
    band_id: text(value.band_id, 60),
    stat_block_id: text(value.stat_block_id, 120),
    xp: Math.max(0, integer(value.xp, 0)),
    taken_at_minutes: takenAt,
    location_id: text(value.location_id, 180),
    location_name: text(value.location_name, 180),
    known_fact_ids: [...new Set((Array.isArray(value.known_fact_ids) ? value.known_fact_ids : [])
      .map((entry) => text(entry, 120)).filter(Boolean))].slice(0, MAX_KNOWN_FACTS),
    revealed_fact_ids: revealed,
    interrogations: Math.max(0, integer(value.interrogations, 0)),
    last_fed_at_minutes: Math.max(0, integer(value.last_fed_at_minutes, takenAt)),
    neglected_at_minutes: value.neglected_at_minutes == null ? null : Math.max(0, integer(value.neglected_at_minutes, 0)),
    resolved_at_minutes: value.resolved_at_minutes == null ? null : Math.max(0, integer(value.resolved_at_minutes, 0)),
    resolution: text(value.resolution, 60),
    disposition: ['ally', 'informant', 'none'].includes(value.disposition) ? value.disposition : 'none',
    policy_id: CAPTIVES_POLICY_ID,
  }
}

export function normalizeCaptivesState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const captives = []
  const seen = new Set()
  for (const raw of Array.isArray(source.captives) ? source.captives : []) {
    const captive = safeCaptive(raw)
    if (!captive || seen.has(captive.id)) continue
    seen.add(captive.id)
    captives.push(captive)
  }
  return { schema_version: CAPTIVES_SCHEMA_VERSION, captives: captives.slice(-MAX_CAPTIVES) }
}

export function captiveList(state = {}) {
  return normalizeCaptivesState(state?.captives).captives
}

export function captiveFor(state = {}, captiveId) {
  const expected = text(captiveId, 120)
  return captiveList(state).find((captive) => captive.id === expected) ?? null
}

/** Пленный, которого прямо сейчас держит отряд, по идентификатору его NPC. */
export function heldCaptiveForNpc(state = {}, npcId) {
  const expected = text(npcId, 120)
  return captiveList(state).find((captive) => captive.npc_id === expected && captive.status === 'held') ?? null
}

export function heldCaptives(state = {}) {
  return captiveList(state).filter((captive) => captive.status === 'held')
}

export function captiveIdFor(state, actorId) {
  return `captive:${captiveSeed(state, actorId).slice(0, 24)}`
}

// ---------------------------------------------------------------------------
// Захват на конце боя
// ---------------------------------------------------------------------------

function conditionIds(state, actorId) {
  return new Set((state?.mechanics?.conditions?.[String(actorId)] ?? [])
    .map((condition) => String(condition?.id ?? condition)))
}

function creatureTypeOf(enemy = {}) {
  return comparable(enemy.creature_type ?? enemy.creatureType ?? enemy.monster_type ?? enemy.kind)
}

/**
 * Почему этот враг переживает бой пленным. `null` — не переживает: он либо
 * дерётся дальше, либо мёртв, либо это существо, которое не связывают.
 */
export function captiveOriginFor(state = {}, enemy = {}) {
  if (!CAPTURABLE_CREATURE_TYPES.has(creatureTypeOf(enemy))) return null
  const conditions = conditionIds(state, enemy.id)
  if (conditions.has('surrendered')) return 'surrendered'
  const knockedOut = state?.mechanics?.resting?.[String(enemy.id)]?.reason === 'knockout'
  if (knockedOut && conditions.has('unconscious')) return 'knocked_out'
  return null
}

/** Сбежавший пленным не становится: `fled` уводит существо с поля вместе с ним. */
export function capturableEnemies(state = {}) {
  const held = new Set(heldCaptives(state).map((captive) => captive.actor_id))
  return (Array.isArray(state?.enemies) ? state.enemies : [])
    .filter((enemy) => enemy?.id && !held.has(String(enemy.id)) && !conditionIds(state, enemy.id).has('fled'))
    .map((enemy) => ({ enemy, origin: captiveOriginFor(state, enemy) }))
    .filter((entry) => entry.origin)
    .sort((left, right) => String(left.enemy.id).localeCompare(String(right.enemy.id)))
}

const CAPTIVE_LEAD_TEMPLATES = Object.freeze([
  Object.freeze({
    predicate: 'band_camp',
    summary: 'Лагерь ватаги стоит {direction} от «{place}» — меньше половины дневного перехода.',
  }),
  Object.freeze({
    predicate: 'band_paid',
    summary: 'Ватага пришла в «{place}» не сама: за налёт заплатили вперёд, и заказчик ждёт вестей.',
  }),
  Object.freeze({
    predicate: 'band_reinforcements',
    summary: 'В «{place}» ватага ждала подкрепление — оно выйдет со дня на день.',
  }),
  Object.freeze({
    predicate: 'band_cache',
    summary: 'У ватаги есть схрон: туда снесли всё взятое в «{place}» и окрестностях.',
  }),
])

const LEAD_DIRECTIONS = Object.freeze(['к северу', 'к югу', 'к востоку', 'к западу', 'выше по дороге', 'за ближайшим гребнем'])

/**
 * Что пленный знает. Сначала берётся уже записанное ведущим: живые `gm_only`
 * факты этой локации — их допрос именно **раскрывает**, а не сочиняет. Если
 * ведущий ничего не прятал, зацепка собирается детерминированным шаблоном от
 * места и ватаги: это по-прежнему не выдумка модели, а серверная запись,
 * которую можно проверить и отыграть.
 */
export function captiveKnowledgeDrafts(state = {}, captive = {}) {
  const facts = (state?.worldMemory?.facts ?? [])
    .filter((fact) => fact?.status === 'active' && fact?.visibility === 'gm_only')
  const placeKey = comparable(captive.location_name || captive.location_id)
  const existing = facts
    .filter((fact) => placeKey && (comparable(fact.summary).includes(placeKey) || comparable(fact.object).includes(placeKey)))
    .map((fact) => String(fact.id))
    .sort()
    .slice(0, MAX_KNOWN_FACTS)
  if (existing.length) return { fact_ids: existing, drafts: [] }
  const template = pick(CAPTIVE_LEAD_TEMPLATES, captive.id, 'lead')
  const direction = pick(LEAD_DIRECTIONS, captive.id, 'direction')
  const factId = `fact:captive-lead:${digest(captive.id, template.predicate).slice(0, 20)}`
  const summary = template.summary
    .replaceAll('{place}', captive.location_name || 'этих краях')
    .replaceAll('{direction}', direction)
  return {
    fact_ids: [factId],
    drafts: [{
      event_type: 'WorldFactRecorded',
      payload: {
        fact: {
          id: factId,
          subject_id: captive.npc_id,
          predicate: template.predicate,
          object: captive.band_id,
          summary,
          // Пока не допросили — это знание ведущего, а не отряда.
          visibility: 'gm_only',
          source_event_ids: [],
          status: 'active',
          recorded_at_minutes: captive.taken_at_minutes,
        },
      },
      target_ids: [],
      visibility: 'gm_only',
    }],
  }
}

function captivePost(state, enemy) {
  const position = state?.mechanics?.positions?.[String(enemy.id)] ?? { x: enemy.x, y: enemy.y }
  const candidate = { x: integer(position?.x, Number.NaN), y: integer(position?.y, Number.NaN) }
  if (!Number.isSafeInteger(candidate.x) || !Number.isSafeInteger(candidate.y)) return null
  return isValidNpcPost(state, candidate, { exceptNpcId: String(enemy.id) }) ? candidate : null
}

/**
 * События захвата. Возвращаются черновиками (`event_type`/`payload`/`visibility`),
 * потому что собирать законченное событие умеет только Rules Engine — у него
 * лежит команда и её `source_rule_ids`.
 */
export function planCaptureDrafts(state = {}) {
  const drafts = []
  const minutes = campaignElapsedMinutes(state)
  const locationId = sceneLocationId(state)
  const locationName = text(state?.scene?.location ?? state?.scene?.title, 180)
  const existingNpcIds = new Set((state?.social?.npcs ?? []).map((npc) => String(npc?.id ?? '')))
  const existingEntityIds = new Set((state?.worldMemory?.entities ?? []).map((entity) => String(entity?.id ?? '')))
  for (const { enemy, origin } of capturableEnemies(state)) {
    const npcId = String(enemy.id)
    const persona = captivePersona(state, enemy)
    const known = (state?.social?.npcs ?? []).find((npc) => String(npc?.id ?? '') === npcId) ?? null
    const bandId = captiveBandId(enemy.stat_block_id, enemy.name)
    const captive = safeCaptive({
      id: captiveIdFor(state, npcId),
      npc_id: npcId,
      actor_id: npcId,
      name: text(known?.name, 160) || persona.name,
      role: text(known?.role, 160) || persona.role,
      temper: persona.temper,
      origin,
      status: 'held',
      band_id: bandId,
      stat_block_id: text(enemy.stat_block_id, 120),
      xp: Math.max(0, integer(enemy.provenance?.xp, 0)),
      taken_at_minutes: minutes,
      location_id: locationId,
      location_name: locationName,
      last_fed_at_minutes: minutes,
    })
    if (!captive) continue
    if (!existingNpcIds.has(npcId)) {
      drafts.push({
        event_type: 'NpcSocialProfileUpserted',
        payload: {
          npc: {
            id: npcId,
            name: captive.name,
            role: captive.role,
            location: locationName || locationId,
            public_summary: `Пленник отряда: ${persona.temper_label}.`,
            voice: persona.voice,
            goals: ['выбраться живым'],
            beliefs: [],
            known_fact_ids: [],
            social_dcs: {},
            visibility: 'party',
            available: true,
            tags: ['captive', `faction:band:${bandId}`],
            schedule: [],
            inventory: [],
          },
        },
        target_ids: [],
        visibility: 'party',
      })
    }
    const post = captivePost(state, enemy)
    if (post && !npcPlacementFor(state, npcId, locationId)) {
      drafts.push({
        event_type: 'NpcPlaced',
        payload: {
          npc_id: npcId,
          npc_name: captive.name,
          npc_role: captive.role,
          location_id: locationId,
          x: post.x,
          y: post.y,
          anchor_prop_id: '',
          placement_reason: 'captive-taken',
          vitality: { hp: 1, max_hp: Math.max(1, integer(enemy.maxHp, 4)), alive: true },
        },
        target_ids: [npcId],
        visibility: 'party',
      })
    }
    if (!existingEntityIds.has(npcId)) {
      drafts.push({
        event_type: 'WorldEntityUpserted',
        payload: {
          entity: {
            id: npcId,
            kind: 'npc',
            name: captive.name,
            summary: `${captive.role}, взят(а) в плен отрядом.`,
            aliases: [],
            visibility: 'party',
            tags: ['captive'],
          },
        },
        target_ids: [],
        visibility: 'party',
      })
      existingEntityIds.add(npcId)
    }
    const knowledge = captiveKnowledgeDrafts(state, captive)
    drafts.push(...knowledge.drafts)
    drafts.push({
      event_type: 'CaptiveTaken',
      payload: { captive: { ...captive, known_fact_ids: knowledge.fact_ids } },
      target_ids: [npcId],
      visibility: 'party',
    })
  }
  return drafts
}

/**
 * Пленный идёт с отрядом. Без этого связанный оставался бы в подземелье, где
 * его взяли, и «сдать страже» работало бы только при захвате прямо в городе.
 */
export function planCaptiveRelocationDrafts(state = {}) {
  const locationId = sceneLocationId(state)
  const locationName = text(state?.scene?.location ?? state?.scene?.title, 180)
  const drafts = []
  for (const captive of heldCaptives(state)) {
    const npc = (state?.social?.npcs ?? []).find((entry) => String(entry?.id ?? '') === captive.npc_id)
    if (!npc || comparable(npc.location) === comparable(locationName || locationId)) continue
    drafts.push({
      event_type: 'NpcSocialProfileUpserted',
      payload: { npc: { ...clone(npc), location: locationName || locationId, dossier: undefined } },
      target_ids: [],
      visibility: 'party',
    })
    drafts.push({
      event_type: 'CaptiveMoved',
      payload: {
        captive_id: captive.id,
        npc_id: captive.npc_id,
        location_id: locationId,
        location_name: locationName,
        policy_id: CAPTIVES_POLICY_ID,
      },
      target_ids: [captive.npc_id],
      visibility: 'party',
    })
  }
  return drafts
}

// ---------------------------------------------------------------------------
// Допрос
// ---------------------------------------------------------------------------

export const CAPTIVE_INTERROGATION_SKILLS = Object.freeze(['persuasion', 'intimidation'])
const INTERROGATION_ABILITY = 'cha'

/**
 * Базовая СЛ разговора со связанным. Она ниже обычной враждебной (18) на
 * величину страха: разгром уже случился, и торговаться пленному нечем. Дальше
 * СЛ растёт за каждый уже вытянутый факт — иначе пленный превращается в
 * бесконечный источник зацепок.
 */
export const CAPTIVE_BASE_DC = 15
export const CAPTIVE_FEAR_DC_SHIFT = -3
export const CAPTIVE_REPEAT_DC_STEP = 3

export function captiveInterrogationPolicy(state = {}, captive = {}, { skill = 'intimidation', reputationShift = 0 } = {}) {
  const normalizedSkill = CAPTIVE_INTERROGATION_SKILLS.includes(skill) ? skill : 'intimidation'
  const temper = CAPTIVE_TEMPERS.find((entry) => entry.id === captive.temper) ?? CAPTIVE_TEMPERS[2]
  // Запугивание работает по уже сломленному, убеждение — по тому, кто торгуется.
  const skillShift = normalizedSkill === 'intimidation'
    ? (temper.id === 'defiant' ? 1 : -1)
    : (temper.id === 'haggler' ? -1 : 1)
  const revealed = (captive.revealed_fact_ids ?? []).length
  const difficulty = clamp(
    CAPTIVE_BASE_DC + CAPTIVE_FEAR_DC_SHIFT + temper.dc_shift + skillShift
      + revealed * CAPTIVE_REPEAT_DC_STEP + clamp(integer(reputationShift, 0), -3, 3),
    5,
    25,
  )
  const pending = (captive.known_fact_ids ?? []).filter((factId) => !(captive.revealed_fact_ids ?? []).includes(factId))
  return {
    skill: normalizedSkill,
    ability: INTERROGATION_ABILITY,
    difficulty,
    fear_shift: CAPTIVE_FEAR_DC_SHIFT,
    temper: temper.id,
    temper_label: temper.label,
    fact_id: pending[0] ?? '',
    exhausted: pending.length === 0,
  }
}

// ---------------------------------------------------------------------------
// Отпустить, сдать страже, покормить
// ---------------------------------------------------------------------------

/** Насколько пощада двигает личное отношение. Одно число, и оно серверное. */
export const CAPTIVE_SPARED_RELATIONSHIP_DELTA = 12

/** Пощажённый помнит: кем он вернётся — решено при захвате, а не броском потом. */
export function captiveSparedDisposition(captive = {}) {
  return pick(['informant', 'ally', 'none', 'informant'], captive.id, 'spared') ?? 'none'
}

/**
 * Награда за сдачу страже. Выводится из XP стат-блока — числа, которое уже
 * лежит в провенансе врага: за головореза платят больше, чем за мальчишку с
 * ножом, и новой таблицы цен для этого не нужно.
 */
export function captiveBountyCp(captive = {}) {
  return clamp(Math.round(Math.max(0, integer(captive.xp, 0)) / 5) * 10, 20, 2_000)
}

function worldNodeFor(state, value) {
  const wanted = comparable(value)
  if (!wanted) return null
  const nodes = Array.isArray(state?.worldMap?.locations) ? state.worldMap.locations : []
  return nodes.find((node) => comparable(node?.id) === wanted || comparable(node?.name) === wanted) ?? null
}

/** Есть ли в текущей сцене кому передать пленного. */
export function captiveSettlementFor(state = {}) {
  const node = worldNodeFor(state, sceneLocationId(state)) ?? worldNodeFor(state, state?.scene?.location)
  if (!node || !SETTLEMENT_LOCATION_KINDS.has(String(node.kind))) return null
  return { id: String(node.id), name: text(node.name, 180), kind: String(node.kind) }
}

/**
 * Фракции, которым есть дело до порядка в этом месте: жители текущей сцены.
 * Сами пленные из списка исключены — иначе выдача разбойника страже поднимала
 * бы славу отряда у той самой ватаги, которую он сдал.
 */
export function localFactionIds(state = {}) {
  const captiveNpcIds = new Set(heldCaptives(state).map((captive) => captive.npc_id))
  return [...new Set(presentSceneNpcs(state)
    .filter((npc) => !captiveNpcIds.has(String(npc.id)))
    .flatMap((npc) => factionIdsForNpc(npc)))].sort().slice(0, 8)
}

/**
 * Голод пленного. Такт зовёт это по мировым часам; запись жестокости выходит не
 * чаще раза в сутки на пленного, поэтому повторный такт той же минуты ничего не
 * добавляет.
 */
export function planCaptiveNeglectCommands(state = {}, { worldMinute } = {}) {
  const minute = Math.max(0, integer(worldMinute ?? state?.mechanics?.world_time?.elapsed_minutes, 0))
  const commands = []
  for (const captive of heldCaptives(state)) {
    const since = Math.max(captive.last_fed_at_minutes, captive.neglected_at_minutes ?? 0)
    if (minute - since < CAPTIVE_FEED_INTERVAL_MINUTES) continue
    commands.push({ command_type: 'NeglectCaptive', captive_id: captive.id, at_minutes: minute })
    if (commands.length >= 12) break
  }
  return commands
}

// ---------------------------------------------------------------------------
// Проекция и редьюсер
// ---------------------------------------------------------------------------

/**
 * Что отряд видит про своих пленных. Раскрытое знание остаётся, нераскрытое —
 * нет: `known_fact_ids` принадлежит ведущему, и именно ради него допрос вообще
 * является проверкой.
 */
export function captivesForViewer(state = {}, viewer = {}) {
  const captives = captiveList(state)
  if (viewer?.isAdmin === true) return { schema_version: CAPTIVES_SCHEMA_VERSION, captives: clone(captives) }
  return {
    schema_version: CAPTIVES_SCHEMA_VERSION,
    captives: captives.map((captive) => {
      const { known_fact_ids: _known, ...visible } = captive
      return clone({
        ...visible,
        pending_knowledge: Math.max(0, captive.known_fact_ids.length - captive.revealed_fact_ids.length),
      })
    }),
  }
}

export function applyCaptiveEvent(input, event, state = {}) {
  const type = String(event?.event_type ?? '')
  const payload = event?.payload ?? {}
  const normalized = input?.schema_version === CAPTIVES_SCHEMA_VERSION && Array.isArray(input.captives)
    ? input
    : normalizeCaptivesState(input)
  const patch = (captiveId, updater) => {
    const expected = text(captiveId, 120)
    if (!expected) return normalized
    return normalizeCaptivesState({
      ...normalized,
      captives: normalized.captives.map((captive) => captive.id === expected ? updater(captive) : captive),
    })
  }
  if (type === 'CaptiveTaken') {
    const captive = safeCaptive(payload.captive)
    if (!captive || normalized.captives.some((entry) => entry.id === captive.id)) return normalized
    return normalizeCaptivesState({ ...normalized, captives: [...normalized.captives, captive] })
  }
  if (type === 'CaptiveMoved') {
    return patch(payload.captive_id, (captive) => ({
      ...captive,
      location_id: text(payload.location_id, 180),
      location_name: text(payload.location_name, 180),
    }))
  }
  if (type === 'CaptiveInterrogated') {
    return patch(payload.captive_id, (captive) => ({
      ...captive,
      interrogations: captive.interrogations + 1,
      revealed_fact_ids: payload.success === true && payload.fact_id
        ? [...new Set([...captive.revealed_fact_ids, text(payload.fact_id, 120)])]
        : captive.revealed_fact_ids,
    }))
  }
  if (type === 'CaptiveFed') {
    return patch(payload.captive_id, (captive) => ({
      ...captive,
      last_fed_at_minutes: Math.max(0, integer(payload.at_minutes, captive.last_fed_at_minutes)),
      neglected_at_minutes: null,
    }))
  }
  if (type === 'CaptiveNeglected') {
    return patch(payload.captive_id, (captive) => ({
      ...captive,
      neglected_at_minutes: Math.max(0, integer(payload.at_minutes, captive.neglected_at_minutes ?? 0)),
    }))
  }
  if (type === 'CaptiveReleased') {
    return patch(payload.captive_id, (captive) => ({
      ...captive,
      status: 'released',
      resolution: 'released',
      disposition: ['ally', 'informant', 'none'].includes(payload.disposition) ? payload.disposition : 'none',
      resolved_at_minutes: Math.max(0, integer(payload.at_minutes, captive.resolved_at_minutes ?? 0)),
    }))
  }
  if (type === 'CaptiveHandedOver') {
    return patch(payload.captive_id, (captive) => ({
      ...captive,
      status: 'handed_over',
      resolution: 'handed_over',
      resolved_at_minutes: Math.max(0, integer(payload.at_minutes, captive.resolved_at_minutes ?? 0)),
    }))
  }
  if (type === 'CaptiveExecuted') {
    return patch(payload.captive_id, (captive) => ({
      ...captive,
      status: 'dead',
      resolution: 'executed',
      resolved_at_minutes: Math.max(0, integer(payload.at_minutes, captive.resolved_at_minutes ?? 0)),
    }))
  }
  return normalized
}
