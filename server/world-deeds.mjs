import { createHash } from 'node:crypto'

import { heldCaptiveForNpc } from './captives.mjs'
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
 *    его читает уже существующий социальный контроллер и **произносит вслух**.
 *    Часы молвы приводит серверный драйвер `nudgeWorldClocks`
 *    (`server/index.mjs`) — тот же, что у часов лавки. Это не деталь
 *    реализации: клиент системный такт не дёргает, и без своего драйвера часы
 *    молвы стояли бы, а весь этот модуль дальше первого шага не работал бы.
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
  // Жестокость — не «ещё одно убийство»: беззащитность жертвы и есть содержание
  // поступка. Пленного добили связанным или уморили голодом, и мир судит это
  // отдельно от боя, где обе стороны были при оружии.
  cruelty: Object.freeze({ alignment: 'dark', severity: 'grave', label: 'Жестокость' }),
  // Вероломство — удар под объявленным перемирием. Тяжесть та же, что у
  // убийства и жестокости, и по той же причине: сломано не тело, а слово, на
  // котором держится любая следующая попытка договориться.
  treachery: Object.freeze({ alignment: 'dark', severity: 'grave', label: 'Вероломство' }),
  arson: Object.freeze({ alignment: 'dark', severity: 'major', label: 'Поджог' }),
  theft: Object.freeze({ alignment: 'dark', severity: 'major', label: 'Кража' }),
  destruction: Object.freeze({ alignment: 'dark', severity: 'major', label: 'Разрушение' }),
  violence: Object.freeze({ alignment: 'dark', severity: 'minor', label: 'Насилие' }),
  // Шулерство за костями. Тяжесть мелкая и это осознанно: подкрученная кость —
  // обман на глазах у стола, а не преступление, поэтому в таблицу закона
  // (`WANTED_CRIME_POINTS`, `law-and-order.mjs`) этот вид не входит и ступень
  // розыска не двигает. За руку здесь ловит хозяин заведения, а не стража.
  cheating: Object.freeze({ alignment: 'dark', severity: 'minor', label: 'Шулерство' }),
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
 *
 * Согласование падежей держится правилом, а не удачей: **обе подстановки стоят
 * в именительном падеже**. Имя героя и название пропса склонять некому — в
 * состоянии лежит одна форма, — поэтому фраза строится так, чтобы другой падеж
 * ей и не понадобился: `{what}` — подлежащее своего предложения или приложение
 * после тире, `{who}` — именная часть после двоеточия. Прежняя редакция ставила
 * подстановку под предлог («после {who}», «огонь по {what}») и выдавала «после
 * Ада» и «огонь по обстановку». Это не служебная строка: её NPC произносит
 * игрокам вслух.
 */
const RUMOR_PHRASES = Object.freeze({
  murder: Object.freeze([
    'В «{place}» случилось убийство: погиб(ла) {what}. Свидетели указывают: {who}.',
    'Говорят, в «{place}» кто-то из чужаков убил человека.',
    'Слыхал, будто в «{place}» пришлые устроили резню. Врут, поди.',
  ]),
  cruelty: Object.freeze([
    'В «{place}» расправились со связанным. Погиб(ла) {what}. Свидетели указывают: {who}.',
    'Говорят, в «{place}» чужаки не пощадили пленного.',
    'Слыхал, будто те пришлые пленных не берут — а берут, так лучше бы убили сразу.',
  ]),
  treachery: Object.freeze([
    'В «{place}» ударили под перемирием. Обманутая сторона — {what}. Свидетели указывают: {who}.',
    'Говорят, в «{place}» чужаки позвали говорить, а ударили в спину.',
    'Слыхал, будто тем пришлым слово не слово: зовут на переговоры и режут.',
  ]),
  violence: Object.freeze([
    'В «{place}» человека избили до крови: пострадал(а) {what}. Свидетели указывают: {who}.',
    'Говорят, в «{place}» чужаки кого-то избили.',
    'Слыхал, будто в «{place}» пришлые чуть не убили человека.',
  ]),
  cheating: Object.freeze([
    'В «{place}» поймали шулера за костями. Обыгрывали вот кого: {what}. Свидетели указывают: {who}.',
    'Говорят, в «{place}» чужаки играют краплёными костями.',
    'Слыхал, будто с теми пришлыми за кости лучше не садиться.',
  ]),
  arson: Object.freeze([
    'В «{place}» был пожар. Горело вот что: {what}. Свидетели указывают: {who}.',
    'Говорят, в «{place}» из-за чужаков случился пожар.',
    'Слыхал, будто «{place}» едва не выгорело дотла по вине проезжих.',
  ]),
  vandalism: Object.freeze([
    'В «{place}» переломали хозяйское добро. Сломано вот что: {what}. Свидетели указывают: {who}.',
    'Говорят, в «{place}» чужаки переломали хозяйское добро.',
    'Слыхал, будто в «{place}» проезжие разгромили целый дом.',
  ]),
  theft: Object.freeze([
    'В «{place}» взяли чужое. Пропало вот что: {what}. Свидетели указывают: {who}.',
    'Говорят, в «{place}» чужаки взяли чужое.',
    'Слыхал, будто в «{place}» проезжие обобрали полгорода.',
  ]),
  destruction: Object.freeze([
    'В «{place}» ломились силой. Не уцелело вот что: {what}. Свидетели указывают: {who}.',
    'Говорят, в «{place}» чужаки вышибли чужую дверь.',
    'Слыхал, будто в «{place}» проезжие вламываются куда захотят.',
  ]),
  promise_broken: Object.freeze([
    'В «{place}» слово дали и не сдержали. Обманутая сторона — {what}. Свидетели указывают: {who}.',
    'Говорят, слову этих чужаков в «{place}» верить нельзя.',
    'Слыхал, будто те пришлые обманули всех, кому что-то обещали.',
  ]),
  rescue: Object.freeze([
    'В «{place}» заслонили местных и отбили нападение. Свидетели указывают: {who}.',
    'Говорят, в «{place}» чужаки заступились за местных.',
    'Слыхал, будто в «{place}» пришлые кого-то спасли. Может, и правда.',
  ]),
  generosity: Object.freeze([
    'В «{place}» одарили и ничего не взяли взамен. Подарок — {what}. Свидетели указывают: {who}.',
    'Говорят, в «{place}» чужаки щедро одарили местных.',
    'Слыхал, будто те проезжие золото раздают направо и налево.',
  ]),
  promise_kept: Object.freeze([
    'В «{place}» слово дали и сдержали. Вторая сторона — {what}. Свидетели указывают: {who}.',
    'Говорят, слову этих чужаков в «{place}» верить можно.',
    'Слыхал, будто те пришлые слово держат. Редкость нынче.',
  ]),
})

/**
 * Запасные формулировки. Отдельные, а не «взять чужой вид»: у каждого вида
 * фраза называет само событие, и подстановка чужой ветки соврала бы игроку.
 * Дойти сюда можно только при рассинхроне `DEED_KINDS` и таблицы фраз.
 */
const FALLBACK_RUMOR_PHRASES = Object.freeze([
  'В «{place}» случилось нехорошее. Речь вот о чём: {what}. Свидетели указывают: {who}.',
  'Говорят, в «{place}» чужаки чем-то отличились.',
  'Слыхал, будто в «{place}» проезжие такое устроили — не перескажешь.',
])

/**
 * Русские имена видов обстановки: латинский `kind` в молву попадать не должен.
 * Формы **именительные** — того требует правило подстановки в `RUMOR_PHRASES`.
 */
const PROP_KIND_LABELS = Object.freeze({
  container: 'чужие пожитки',
  corpse: 'останки погибшего',
  relic: 'святыня',
  campfire: 'костёр',
  lore: 'обстановка',
  furnishing: 'обстановка',
})

/** Что ломают силой: у двери в движке нет ни имени, ни хозяина. */
const FORCED_DOOR_LABEL = 'дверь'

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
 * Типы событий, в которых поступок вообще может обнаружиться. Проверка стоит
 * перед любой работой: редьюсер зовётся на **каждое** событие журнала, и
 * разбирать все подряд значило бы платить за поступки на каждом шаге replay.
 */
const DEED_EVENT_TYPES = new Set([
  'NpcDied', 'NpcHarmed', 'SceneObjectOperated', 'DoorForced',
  'NpcPromiseResolved', 'ItemTransferred', 'WitnessConsequencePropagated',
  'CaptiveNeglected', 'TruceBroken', 'TavernCheatCaught',
])

/**
 * Распознавание поступка в подтверждённом событии. Возвращает описание без
 * идентификатора и времени — их доставляет `deedFromEvent`.
 *
 * Самообороны здесь нет намеренно. Единственное место в движке, где мирный NPC
 * становится враждебным, — `npcHarmEventDrafts` (`npc-positioning.mjs`, ветка
 * `stanceDraft(..., 'hostile', 'harmed', ...)`): стойка `hostile` **следствие
 * удара отряда**, а не его причина. Скидка «был враждебен — значит защищались»
 * снимала бы вину ровно там, где отряд ударил первым, и второй удар по уже
 * избитому переставал бы считаться. Пока в состоянии нет факта «NPC напал на
 * отряд», отличить оборону от расправы нечем; заводить его — работа боевого
 * контура, а не летописи (`docs/dnd-table-situations.md`).
 *
 * @returns {{ kind: string, key: string, subject?: string, actorIds?: string[], witnessIds?: string[] } | null}
 */
function recognizeDeed(state, event) {
  const type = String(event?.event_type ?? '')
  const payload = event?.payload ?? {}
  if (type === 'CaptiveNeglected') {
    // Жестокость называет своим именем то, чего в обычном убийстве нет:
    // жертва была связана и безоружна. Голод считается тем же поступком —
    // морить пленного не мягче, чем добить.
    return {
      kind: 'cruelty',
      key: text(payload.captive_id, 120),
      subject: text(payload.captive_name, 160) || npcNameFor(state, payload.npc_id),
      actorIds: [payload.hero_id ?? event.actor_id].filter(Boolean),
      // Сама жертва свидетелем не считается: голодающий пленник ещё жив и попал
      // бы в список сцены, а «свидетель собственного мучения» и репутацию
      // двигал бы за себя.
      witnessIds: sceneWitnessIds(state).filter((npcId) => npcId !== text(payload.npc_id, 120)),
    }
  }
  if (type === 'TavernCheatCaught') {
    // Шулерство ловят на людях по определению: за костями сидят в общем зале, и
    // обыгранный сосед по столу — свидетель сам по себе, даже если больше в
    // зале никого нет. Тот же приём, что у обещания и у перемирия.
    const npcId = text(payload.npc_id, 120)
    return {
      kind: 'cheating',
      key: npcId || text(payload.hero_id, 120),
      subject: text(payload.npc_name, 160) || npcNameFor(state, npcId) || 'соперник за костями',
      actorIds: [payload.hero_id ?? event.actor_id].filter(Boolean),
      witnessIds: [...new Set([npcId, ...sceneWitnessIds(state)])].filter(Boolean).sort(),
    }
  }
  if (type === 'TruceBroken') {
    // Летопись — счёт поступков **отряда**: перемирие, разорванное самим
    // противником, поступком отряда быть не может. Свидетелями здесь считается
    // не только сцена: под перемирием стороны стоят лицом к лицу, и
    // предводитель противника видел удар первым, даже если мирных NPC рядом нет.
    if (text(payload.broken_by, 30) !== 'party') return null
    const leaderId = text(payload.leader_id, 120)
    return {
      kind: 'treachery',
      key: leaderId || text(payload.actor_id, 120),
      subject: text(payload.leader_name, 160) || npcNameFor(state, leaderId) || 'противник',
      actorIds: [payload.actor_id ?? event.actor_id].filter(Boolean),
      witnessIds: [...new Set([leaderId, ...sceneWitnessIds(state)])].filter(Boolean).sort(),
    }
  }
  if (type === 'NpcDied') {
    // Смерть связанного — жестокость, а не рядовое убийство: беззащитность
    // жертвы и есть содержание поступка.
    //
    // Распознаётся она по **самой смерти**, а не по команде казни. Первая
    // редакция делала наоборот: гасила здесь убийство, если NPC числится
    // пленным, и рассчитывала, что жестокость запишет `CaptiveExecuted`. Но это
    // событие шлёт одна-единственная команда `ExecuteCaptive`, а связанного
    // убивает и площадное заклинание, и добивающий удар по соседней клетке, и
    // прямой `HarmNpc` — там не оставалось ни убийства, ни жестокости, то есть
    // сторож слабел ровно на том, ради чего заводился.
    //
    // Порядок редьюсеров в `applyGameEvent` (`rules-engine.mjs`) — часть
    // контракта: реестр пленных обновляется **после** летописи, поэтому здесь
    // запись ещё числится удерживаемой.
    const captive = heldCaptiveForNpc(state, payload.npc_id)
    const subject = text(payload.npc_name, 160) || npcNameFor(state, payload.npc_id)
    const actorIds = [payload.source_actor_id ?? event.actor_id]
    if (captive) {
      return { kind: 'cruelty', key: text(captive.id, 120), subject: subject || text(captive.name, 160), actorIds }
    }
    return { kind: 'murder', key: text(payload.npc_id, 120), subject, actorIds }
  }
  if (type === 'NpcHarmed') {
    // Смертельный удар описан отдельным поступком: считать его дважды нельзя.
    if (integer(payload.hp_after, 0) <= 0) return null
    return { kind: 'violence', key: text(payload.npc_id, 120), subject: text(payload.npc_name, 160) || npcNameFor(state, payload.npc_id), actorIds: [payload.source_actor_id ?? event.actor_id] }
  }
  if (type === 'SceneObjectOperated') {
    const what = PROP_KIND_LABELS[text(payload.kind, 40)] ?? 'обстановка'
    const key = text(payload.prop_id, 120)
    if (payload.intent === 'ignite') return { kind: 'arson', key, subject: what, actorIds: [event.actor_id] }
    if (payload.intent === 'topple') return { kind: 'vandalism', key, subject: what, actorIds: [event.actor_id] }
    if (payload.intent === 'take') {
      // Хозяина у пропса в движке нет (`docs/dnd-table-situations.md`, B1),
      // поэтому кражей считается взятое **на людях**: пустое подземелье
      // поступком не становится и ленту ведущего не засоряет.
      const witnessIds = sceneWitnessIds(state)
      if (!witnessIds.length) return null
      return { kind: 'theft', key, subject: what, actorIds: [event.actor_id], witnessIds }
    }
    return null
  }
  if (type === 'DoorForced' && payload.success === true) {
    // Выломанная дверь — единственное разрушение, о котором движок знает
    // структурно: `DoorForced` с успехом переводит дверь в `broken`
    // (`rules-engine.mjs`, редьюсер `DoorForced`).
    //
    // Раньше здесь стоял `WorldFactRecorded` с предикатом `scene_change`, и это
    // было прямой ошибкой: единственный писатель таких фактов —
    // `materialConsequenceCommands` (`autonomous-orchestrator.mjs`), а он пишет
    // их на **любую успешную** рискованную проверку. Обезвреженная ловушка,
    // перепрыгнутая пропасть и потушенный пожар записывались тёмным поступком
    // «разрушение» и роняли славу отряда. Свободного текста, по которому можно
    // отличить разрушение от подвига, в факте нет — значит, и поступка из него
    // выводить нельзя.
    //
    // Свидетели обязательны по той же причине, что и у кражи: хозяина у двери в
    // движке нет, и выломанная дверь в пустом подземелье никого не обидела.
    const witnessIds = sceneWitnessIds(state)
    if (!witnessIds.length) return null
    return { kind: 'destruction', key: text(payload.door_id, 120), subject: FORCED_DOOR_LABEL, actorIds: [event.actor_id], witnessIds }
  }
  if (type === 'NpcPromiseResolved') {
    const status = text(payload.status, 30)
    if (!['broken', 'fulfilled'].includes(status)) return null
    const promise = promiseFor(state, payload.promise_id)
    if (!promise) return null
    return {
      kind: status === 'broken' ? 'promise_broken' : 'promise_kept',
      key: text(payload.promise_id, 120),
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
      key: text(payload.item_id, 120),
      subject: text(payload.item?.name, 160) || 'дар',
      actorIds: [payload.from_actor_id ?? event.actor_id],
      witnessIds: [...new Set([text(payload.to_actor_id, 120), ...sceneWitnessIds(state)])].filter(Boolean).sort(),
    }
  }
  if (type === 'WitnessConsequencePropagated' && text(payload.outcome, 30) === 'helpful') {
    const witnessIds = [...new Set((Array.isArray(payload.witness_ids) ? payload.witness_ids : []).map((entry) => text(entry, 120)).filter(Boolean))].sort()
    if (!witnessIds.length) return null
    return { kind: 'rescue', key: text(payload.source_event_id, 120), subject: text(state?.scene?.location, 180) || 'местных', actorIds: [], witnessIds }
  }
  return null
}

/**
 * Идентификатор поступка выводится из содержимого команды, а не из `event_id`:
 * до коммита события идентификатора ещё нет, и ключ от него разошёлся бы между
 * предварительной проекцией и replay. `key` — устойчивый различитель внутри
 * одной команды: одно площадное заклинание убивает двоих, и без него оба
 * убийства слились бы в один поступок.
 */
function deedIdFor(event, recognized, atMinutes) {
  return `deed:${digest(event?.command_id ?? event?.event_id ?? '', event?.event_type ?? '', recognized.kind, recognized.key ?? '', atMinutes)}`
}

function summaryFor(state, deed) {
  const who = partyLabel(state, deed.actor_names)
  const place = deed.location_name || 'неизвестном месте'
  const what = deed.subject || '—'
  // Форма у всех одна — «подпись — что», — и она держит именительный падеж:
  // склонять имя героя и название пропса нечем, склеенная же по месту фраза
  // («слово, данное Мельник Ждан») читается как ошибка.
  const table = {
    murder: `${who}: убийство — ${what} (${place})`,
    cruelty: `${who}: жестокость к пленному — ${what} (${place})`,
    treachery: `${who}: удар под перемирием — ${what} (${place})`,
    violence: `${who}: побои — ${what} (${place})`,
    cheating: `${who}: шулерство за костями — ${what} (${place})`,
    arson: `${who}: поджог — ${what} (${place})`,
    vandalism: `${who}: погром — ${what} (${place})`,
    theft: `${who}: кража — ${what} (${place})`,
    destruction: `${who}: разрушение — ${what} (${place})`,
    promise_broken: `${who}: нарушенное слово — ${what} (${place})`,
    promise_kept: `${who}: сдержанное слово — ${what} (${place})`,
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
  const type = String(event?.event_type ?? '')
  const normalized = input?.schema_version === WORLD_DEEDS_SCHEMA_VERSION && Array.isArray(input.deeds)
    ? input
    : normalizeWorldDeedsState(input)
  if (type === 'FactionReputationAdjusted') {
    if (text(event?.payload?.provenance?.policy, 120) !== WORLD_RUMOR_POLICY_ID) return normalized
    const deedId = text(event.payload?.deed_id, 120)
    const factionId = text(event.payload?.faction_id, 120)
    if (!deedId || !factionId) return normalized
    return normalizeWorldDeedsState({
      ...normalized,
      deeds: normalized.deeds.map((deed) => deed.id === deedId
        ? { ...deed, reputation_faction_ids: [...new Set([...deed.reputation_faction_ids, factionId])] }
        : deed),
    })
  }
  if (!DEED_EVENT_TYPES.has(type)) return normalized
  const deed = deedFromEvent(state, event)
  if (!deed || normalized.deeds.some((entry) => entry.id === deed.id)) return normalized
  return normalizeWorldDeedsState({ ...normalized, deeds: [...normalized.deeds, deed] })
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
  const variants = RUMOR_PHRASES[deed.kind] ?? FALLBACK_RUMOR_PHRASES
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
  // Пачка одного такта ограничена намеренно: кампания, поднятая из старого
  // журнала, может принести две сотни поступков разом, и один `resolvePlan` на
  // четыре сотни команд заблокировал бы такт. Остальное доедет следующим тиком.
  const maximumFacts = Math.max(1, Math.min(40, integer(limit, 24)))
  for (const deed of ledger.deeds) {
    if (commands.length >= maximumFacts * 2) break
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
