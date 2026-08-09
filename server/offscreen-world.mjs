import { createHash } from 'node:crypto'

import { normalizeNpcWorldState, presentSceneNpcs } from './npc-positioning.mjs'
import { campaignDayOf, campaignSeedOf } from './weather.mjs'
import { rumorSpreadTargets } from './world-deeds.mjs'

/**
 * «Пока вас не было…» — мир живёт, когда отряд спит.
 *
 * Каталог ситуаций стола (`docs/dnd-table-situations.md`, D4 и D5) описывал две
 * половины одной дыры. У задания есть часы, но двигает их только Режиссёр —
 * календарного срока нет (D4). Мир между сценами записывает («расписание
 * исполнено»), но не действует: лавка не сгорит, соперники не опередят (D5).
 * Из этого же вытекает и сквозной пробел 5 — «мир записывает, но не действует».
 *
 * Модуль закрывает обе половины одним слоем и устроен так:
 *
 * 1. **Слой поверх, а не второй счётчик времени.** Ход мира считает та же
 *    функция, что и все прочие последствия минут, — `appendWorldTimeConsequences`
 *    (`server/rules-engine.mjs`). Своих тиков здесь нет: обещания NPC,
 *    восстановление героев, рассвет предметов, рестоки лавок и расписания NPC
 *    уже двигаются этими минутами, и второй привод разошёлся бы с первым.
 *    Молву модуль **считает, но не рождает**: `RecordRumor` пишет свой драйвер
 *    (`nudgeWorldClocks`, `server/index.mjs`), а здесь она только называется в
 *    карточке — иначе один и тот же слух записался бы дважды.
 * 2. **Ходит мир только на существенном скачке.** Порог — восемь часов
 *    (`OFFSCREEN_STEP_MINIMUM_MINUTES`): продолжительный отдых и сутки под
 *    замком существенны, десять минут ритуала и час привала — нет. Сверх порога
 *    стоит второе правило: не чаще раза в игровые сутки
 *    (`OFFSCREEN_STEP_INTERVAL_MINUTES`). Без него два отдыха подряд в одни и те
 *    же сутки означали бы два хода мира, и «каждый отдых — катастрофа» стало бы
 *    правилом, а не преувеличением.
 *
 *    Оба порога считают **разрыв между ходами, а не длину скачка**: одна
 *    команда времени даёт не больше одного хода мира, сколько бы суток в ней ни
 *    уместилось. Месяц под замком двигает часы задания на одно деление, ровно
 *    как ночёвка. Это решение, а не недосмотр: месячный скачок иначе выдал бы
 *    столу тридцать врезок разом и заодно провалил бы все открытые задания в
 *    одном коммите, ни разу не спросив стол. Развязку длинного простоя ставит
 *    Режиссёр, у которого есть сцена; мир за спиной отряда только отмечает, что
 *    время прошло.
 * 3. **Часы задания мир доводит до последнего деления, но не до развязки.**
 *    Шаг ставится, только пока `current + 1 < max`. Это не осторожность, а
 *    граница ответственности: заполненные часы — это исход, а исход принадлежит
 *    столу и Режиссёру, и решать его во сне отряда нельзя.
 * 4. **Протухает то, что уже просрочено, и не сразу.** Задание с заполненными
 *    часами сначала попадает под наблюдение (`watch`), и только следующий ход
 *    мира через игровые сутки закрывает его провалом. Сутки — это фора: у
 *    Режиссёра есть свой контур развязки триггернувшихся квестов
 *    (`server/autonomous-orchestrator.mjs`), и перебивать его нельзя.
 * 5. **Фракция-антагонист ходит из закрытого набора.** Три последствия, ни
 *    одного нового стат-блока и ни одного нового существа: усилить посты,
 *    сместить лагерь, увести заложника из **уже известных** NPC. Всё, что
 *    меняется, — память мира и доступность NPC; бой из этого не рождается.
 *    «Тема кампании» входит в текст именами: как зовут фракцию, где она стоит,
 *    кого она увела. Свободного текста модуль не сочиняет — иначе он перестал
 *    бы быть детерминированным.
 *
 *    Увод заложника — единственный ход, который выходит за память мира: он
 *    пишет `NpcSocialProfileUpserted` с `available: false` (и гасит расписание,
 *    иначе `npcProfileAtWorldTime` вернул бы уведённого к людям в ближайшую
 *    смену). Без этого строка «больше не выходит к людям» осталась бы враньём:
 *    `available` читают Режиссёр (`available_npcs`), разбор намерения,
 *    адъюдикаторы и политика цикла — и уведённый NPC вышел бы к отряду в
 *    следующей же сцене.
 *
 *    Набор из трёх ходов на длинной кампании вырождается: известные NPC
 *    кончаются, и остаются два хода по кругу. Это осознанный потолок слоя —
 *    расширять набор значило бы заводить встречи и стат-блоки за кадром, — но
 *    дословных повторов в ленте ведущего быть не должно, поэтому у каждого
 *    хода несколько формулировок (`FACTION_MOVE_SUMMARY`), и они идут по кругу
 *    от точки, заданной сидом кампании.
 *
 * Детерминизм держится теми же приёмами, что у погоды и закона: никаких костей
 * (`DiceService` — общий поток случайности, и выпавшее из него зависит от числа
 * бросков раньше), никаких часов реального мира, выбор из таблиц — sha256 от
 * подписи и остаток от деления. Одинаковое состояние и одинаковый скачок дают
 * один и тот же мир, поэтому replay воспроизводит ход мира по построению.
 *
 * `GAME_STATE_PROJECTOR_VERSION` не бампится, и это решение, а не забывчивость.
 * Летопись поступков, реестр пленных и реестр закона бампили версию потому, что
 * выводились из **уже существовавших** событий: снимок старой версии их не
 * содержал, а хвост журнала после снимка восстановил бы только часть. Здесь
 * выводить не из чего — `OffscreenWorldStepResolved` в старых журналах нет
 * вовсе, — и бамп заставил бы каждую живую кампанию переиграть поток целиком
 * ради пустой ленты. Тот же довод записан у перемирия (`server/parley.mjs`).
 *
 * Видимость: всё, что модуль пишет, party-видимо и по построению безопасно.
 * «Пока вас не было…» — монтаж для стола, и тайные нити ведущего в нём не
 * участвуют: в ход мира попадают только party-видимые квесты, фракции и NPC.
 * Так карточка не может назвать того, чего отряд знать не должен.
 *
 * Держат это ровно три фильтра — `visibleToParty` в `partyQuests`, в
 * `antagonistFactionFor` и в `hostageCandidates`. Второй формы у ленты нет:
 * `offscreen_world` уезжает игроку той же проекцией, что и ведущему
 * (`server/viewer-projection.mjs`), и утечка была бы сквозной и молчаливой.
 * Поэтому фильтры закреплены поимённо (`test/offscreen-world.test.mjs`,
 * «тайные нити ведущего в ход мира не попадают»), а не подразумеваются.
 */

export const OFFSCREEN_WORLD_SCHEMA_VERSION = 1
export const OFFSCREEN_WORLD_POLICY_ID = 'skazanie:offscreen-world-v1'
export const OFFSCREEN_WORLD_EVENT_TYPE = 'OffscreenWorldStepResolved'
/**
 * Заголовок карточки летописи и сводки памяти мира — один на оба места.
 *
 * В памяти мира он ложится в NFKC-форме (`…` → `...`, `server/world-memory.mjs`),
 * поэтому сравнивать сохранённую сводку с этой строкой посимвольно нельзя:
 * искать её полагается по началу заголовка.
 */
export const OFFSCREEN_CARD_TITLE = 'Пока вас не было…'
/** Начало заголовка без завершающего многоточия: им сводка и опознаётся. */
export const OFFSCREEN_CARD_TITLE_PREFIX = 'Пока вас не было'

/** Существенный скачок: продолжительный отдых и всё, что дольше. */
export const OFFSCREEN_STEP_MINIMUM_MINUTES = 480
/** Мир ходит не чаще раза в игровые сутки, сколько бы отдыхов ни случилось. */
export const OFFSCREEN_STEP_INTERVAL_MINUTES = 1_440
/** Сколько игрового времени просроченное задание держится под наблюдением. */
export const OFFSCREEN_QUEST_EXPIRY_MINUTES = 1_440
/** Сколько заданий двигает один ход мира: лента ведущего не должна тонуть. */
export const OFFSCREEN_QUEST_TICK_LIMIT = 4

const MAX_STEPS = 40
const MAX_ENTRIES = 12
const MAX_LINES = 3
const MAX_WATCH = 16
/** Сколько заданий за ход мира попадают в ленту строкой «срок на исходе». */
const MAX_DEADLINE_ENTRIES = 3
/** Сколько заданий за ход мира могут протухнуть разом. */
const MAX_EXPIRED_ENTRIES = 2

/** Закрытый набор ходов фракции-антагониста. Ни модель, ни клиент его не расширяют. */
export const FACTION_MOVE_KINDS = Object.freeze(['reinforced_posts', 'moved_camp', 'took_hostage'])

/** Русские подписи записей ленты. Таблица одна и живёт на сервере. */
export const OFFSCREEN_ENTRY_LABELS = Object.freeze({
  quest_clock: 'Часы задания',
  quest_deadline: 'Срок на исходе',
  quest_expired: 'Задание провалено',
  faction_move: 'Ход противника',
  rumor_spread: 'Молва',
})

const VISIBLE_TO_PARTY = new Set(['party', 'public'])

const text = (value, maximum = 200) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

const worldMinutes = (state) => Math.max(0, integer(state?.mechanics?.world_time?.elapsed_minutes, 0))

/**
 * Номер игрового дня для карточки — **тот же счёт, что у неба**
 * (`campaignDayOf`, `server/weather.mjs`): сутки идут от рассвета к рассвету, а
 * кампания начинается уже начавшимся днём. Свой счётчик здесь заводить было
 * нельзя: игрок видит «День N» в подсказке погоды, и две разные цифры в одном
 * интерфейсе расходились бы у него на глазах каждую ночь.
 */
export const offscreenCampaignDay = (minutes) => campaignDayOf(Math.max(0, integer(minutes, 0))) + 1

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------

function safeEntry(value = {}) {
  const kind = text(value.kind, 40)
  if (!Object.hasOwn(OFFSCREEN_ENTRY_LABELS, kind)) return null
  return {
    kind,
    summary: text(value.summary, 400),
    quest_id: text(value.quest_id, 120),
    quest_title: text(value.quest_title, 180),
    faction_id: text(value.faction_id, 120),
    faction_name: text(value.faction_name, 180),
    move_kind: FACTION_MOVE_KINDS.includes(text(value.move_kind, 40)) ? text(value.move_kind, 40) : '',
    npc_id: text(value.npc_id, 120),
    npc_name: text(value.npc_name, 180),
    count: Math.max(0, integer(value.count, 0)),
  }
}

function safeStep(value = {}) {
  const id = text(value.id, 140)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,139}$/u.test(id)) return null
  const entries = []
  for (const raw of Array.isArray(value.entries) ? value.entries : []) {
    const entry = safeEntry(raw)
    if (entry) entries.push(entry)
  }
  if (!entries.length) return null
  const atMinutes = Math.max(0, integer(value.at_minutes, 0))
  return {
    id,
    at_minutes: atMinutes,
    elapsed_minutes: Math.max(0, integer(value.elapsed_minutes, 0)),
    day: Math.max(1, integer(value.day, offscreenCampaignDay(atMinutes))),
    entries: entries.slice(0, MAX_ENTRIES),
    lines: (Array.isArray(value.lines) ? value.lines : []).map((line) => text(line, 400)).filter(Boolean).slice(0, MAX_LINES),
    policy_id: OFFSCREEN_WORLD_POLICY_ID,
  }
}

function safeWatch(value = {}) {
  const questId = text(value.quest_id, 120)
  if (!questId) return null
  return { quest_id: questId, since_minutes: Math.max(0, integer(value.since_minutes, 0)) }
}

export function normalizeOffscreenWorldState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const steps = []
  const seen = new Set()
  for (const raw of Array.isArray(source.steps) ? source.steps : []) {
    const step = safeStep(raw)
    if (!step || seen.has(step.id)) continue
    seen.add(step.id)
    steps.push(step)
  }
  const watch = []
  const watched = new Set()
  for (const raw of Array.isArray(source.watch) ? source.watch : []) {
    const entry = safeWatch(raw)
    if (!entry || watched.has(entry.quest_id)) continue
    watched.add(entry.quest_id)
    watch.push(entry)
  }
  return {
    schema_version: OFFSCREEN_WORLD_SCHEMA_VERSION,
    steps: steps.slice(-MAX_STEPS),
    watch: watch.slice(-MAX_WATCH),
  }
}

// ---------------------------------------------------------------------------
// Кто участвует в ходе мира
// ---------------------------------------------------------------------------

const visibleToParty = (value) => VISIBLE_TO_PARTY.has(text(value, 30) || 'gm_only')

/**
 * Задания, которые вообще участвуют в ходе мира. Только party-видимые и только
 * активные: карточка «Пока вас не было…» показывается всему столу, и назвать в
 * ней тайную нить ведущего значило бы отдать её игроку даром.
 */
function partyQuests(state) {
  return (Array.isArray(state?.worldMemory?.quests) ? state.worldMemory.quests : [])
    .filter((quest) => quest?.id && quest.status === 'active' && visibleToParty(quest.visibility))
    .slice()
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

const questClockOf = (quest) => {
  const max = Math.max(1, integer(quest?.clock?.max, 4))
  const current = Math.max(0, Math.min(max, integer(quest?.clock?.current, 0)))
  return { current, max, triggered: quest?.clock?.triggered === true || current >= max }
}

/**
 * Фракция-антагонист. Сначала — явная пометка автора кампании (`antagonist`,
 * `enemy`, `hostile` в тегах сущности), потом — та, чья слава об отряде хуже
 * всех и при этом отрицательна.
 *
 * Порог «строго ниже нуля» стоит намеренно: у свежей кампании антагониста нет,
 * и назначать им стартовую фракцию проводников только потому, что других в
 * памяти мира ещё не завели, — значит выдумывать врага. Пока отряд никому не
 * насолил и автор никого не пометил, за спиной отряда никто и не ходит.
 */
export function antagonistFactionFor(state = {}) {
  const factions = (Array.isArray(state?.worldMemory?.entities) ? state.worldMemory.entities : [])
    .filter((entity) => entity?.id && entity.kind === 'faction' && visibleToParty(entity.visibility))
  const tagged = factions
    .filter((entity) => (Array.isArray(entity.tags) ? entity.tags : [])
      .some((tag) => ['antagonist', 'enemy', 'hostile'].includes(text(tag, 60))))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  if (tagged.length) return tagged[0]
  const reputations = state?.autonomy?.reputations && typeof state.autonomy.reputations === 'object'
    ? state.autonomy.reputations
    : {}
  return factions
    .map((entity) => ({ entity, score: integer(reputations[String(entity.id)], 0) }))
    .filter((row) => row.score < 0)
    .sort((left, right) => left.score - right.score || String(left.entity.id).localeCompare(String(right.entity.id)))[0]?.entity ?? null
}

/**
 * Кого фракция может увести. Только известный отряду живой NPC, которого нет в
 * текущей сцене: заложник из-под носа героев — это сцена, а не сводка, и
 * забирать фигурку с доски за кадром нельзя.
 *
 * Торговцы исключены не из жалости к лавке, а потому, что увести их **нечем**:
 * профиль торговца пересобирается из `state.merchants` при каждой нормализации
 * (`ensureNpcSocialState`, `server/npc-social.mjs`), и выставленный здесь
 * `available: false` был бы затёрт следующим же снимком. Карточка обещала бы
 * столу недоступность, а лавка работала бы как ни в чём не бывало.
 */
function hostageCandidates(state, takenIds) {
  const vitals = normalizeNpcWorldState(state?.npc_world).vitals
  const present = new Set(presentSceneNpcs(state).map((npc) => String(npc.id)))
  const merchants = new Set((Array.isArray(state?.merchants) ? state.merchants : []).map((merchant) => String(merchant?.id ?? '')))
  return (Array.isArray(state?.social?.npcs) ? state.social.npcs : [])
    .filter((npc) => npc?.id && npc?.name)
    .filter((npc) => visibleToParty(npc.visibility))
    .filter((npc) => npc.available !== false && vitals[String(npc.id)]?.alive !== false)
    .filter((npc) => !present.has(String(npc.id)) && !takenIds.has(String(npc.id)))
    .filter((npc) => !merchants.has(String(npc.id)))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
}

/** Где стоит отряд — только для формулировки хода фракции. */
function placeNameFor(state) {
  return text(state?.scene?.location ?? state?.scene?.title, 180)
}

/**
 * Формулировки ходов. Вариантов на вид несколько намеренно: набор ходов
 * закрытый, и на длинной кампании, когда известные NPC кончились, фракция
 * ходит двумя оставшимися по кругу. Расширять набор нельзя — это завело бы
 * встречи и стат-блоки за кадром, — а дословный повтор в ленте ведущего
 * читается как залипший движок.
 */
const FACTION_MOVE_SUMMARY = Object.freeze({
  reinforced_posts: Object.freeze([
    ({ faction, place }) => (place
      ? `${faction} усилила посты у «${place}»: чужаков теперь считают на подходе.`
      : `${faction} усилила посты: чужаков теперь считают на подходе.`),
    ({ faction, place }) => (place
      ? `${faction} выставила дозоры вокруг «${place}»: незамеченным больше не пройти.`
      : `${faction} выставила дозоры: незамеченным больше не пройти.`),
    ({ faction, place }) => (place
      ? `${faction} сменила караулы близ «${place}»: на тракте стало людно и недобро.`
      : `${faction} сменила караулы: на трактах стало людно и недобро.`),
  ]),
  moved_camp: Object.freeze([
    ({ faction, place }) => (place
      ? `${faction} снялась со стоянки близ «${place}» и встала там, где её не ждут.`
      : `${faction} снялась со стоянки и встала там, где её не ждут.`),
    ({ faction, place }) => (place
      ? `${faction} свернула лагерь под «${place}»: кострище остыло, а куда ушли — не сказали.`
      : `${faction} свернула лагерь: кострище остыло, а куда ушли — не сказали.`),
    ({ faction, place }) => (place
      ? `${faction} бросила старое место у «${place}» и залегла в стороне от дорог.`
      : `${faction} бросила старое место и залегла в стороне от дорог.`),
  ]),
  took_hostage: Object.freeze([
    ({ faction, npc }) => `${faction} увела заложника: ${npc} больше не выходит к людям.`,
    ({ faction, npc }) => `${faction} забрала с собой ${npc}: с тех пор к людям больше не выходит.`,
  ]),
})

/**
 * Формулировка выбирается **по кругу**, а не остатком от очередного sha256:
 * остаток честно случаен, а значит два хода подряд с одинаковой строкой
 * выпадают регулярно — именно они и читаются как залипший движок. Счётчик
 * прошлых ходов того же вида берётся из ленты, то есть выводится из событий и
 * переживает replay. Стартовая точка круга — от сида кампании, чтобы две
 * кампании не открывались одной и той же фразой.
 */
function factionMoveSummary(moveKind, { seed, factionId, alreadyMoved, faction, place, npc }) {
  const variants = FACTION_MOVE_SUMMARY[moveKind]
  const start = Number.parseInt(digest(seed, factionId, moveKind).slice(8, 16), 16) % variants.length
  return variants[(start + Math.max(0, integer(alreadyMoved, 0))) % variants.length]({ faction, place, npc })
}

/**
 * Ход фракции. Порядок в закрытом наборе обходится по кругу от детерминированно
 * выбранной точки: если заложника взять не из кого, следующий ход берётся из
 * того же набора, а не выдумывается.
 *
 * Возвращается пара: запись ленты и — для увода — сам профиль заложника.
 * Профиль нужен вызывающему, чтобы выпустить `NpcSocialProfileUpserted`: без
 * него строка «больше не выходит к людям» осталась бы текстом, а NPC —
 * доступным всему серверу.
 *
 * @returns {{ entry: any, hostage: any } | null}
 */
function planFactionMove(state, { faction, atMinutes, takenIds, movesByKind }) {
  const seed = campaignSeedOf(state)
  const factionId = text(faction.id, 120)
  const start = Number.parseInt(digest(seed, faction.id, String(atMinutes)).slice(0, 8), 16) % FACTION_MOVE_KINDS.length
  const place = placeNameFor(state)
  const factionName = text(faction.name, 180) || 'Противник'
  for (let offset = 0; offset < FACTION_MOVE_KINDS.length; offset += 1) {
    const moveKind = FACTION_MOVE_KINDS[(start + offset) % FACTION_MOVE_KINDS.length]
    const alreadyMoved = movesByKind.get(moveKind) ?? 0
    if (moveKind !== 'took_hostage') {
      return {
        entry: {
          kind: 'faction_move',
          move_kind: moveKind,
          faction_id: factionId,
          faction_name: factionName,
          summary: factionMoveSummary(moveKind, { seed, factionId, alreadyMoved, faction: factionName, place }),
        },
        hostage: null,
      }
    }
    const hostage = hostageCandidates(state, takenIds)[0]
    if (!hostage) continue
    const hostageName = text(hostage.name, 180)
    return {
      entry: {
        kind: 'faction_move',
        move_kind: moveKind,
        faction_id: factionId,
        faction_name: factionName,
        npc_id: text(hostage.id, 120),
        npc_name: hostageName,
        summary: factionMoveSummary(moveKind, { seed, factionId, alreadyMoved, faction: factionName, npc: hostageName }),
      },
      hostage,
    }
  }
  return null
}

/**
 * Уведённый NPC перестаёт быть доступным. Профиль пересобирается целиком,
 * потому что редьюсер `NpcSocialProfileUpserted` заменяет запись, а не
 * сливает её (`applyNpcSocialEvent`, `server/npc-social.mjs`); досье он
 * восстанавливает из прежней записи сам, поэтому здесь оно не передаётся.
 *
 * Расписание гасится вместе с профилем: `npcProfileAtWorldTime` берёт
 * `available` из активной записи расписания, и оставленное «утром в лавке»
 * вернуло бы уведённого к людям в ближайшую смену.
 */
function hostageUnavailableDraft(hostage) {
  return {
    event_type: 'NpcSocialProfileUpserted',
    visibility: 'party',
    payload: {
      npc: {
        ...hostage,
        available: false,
        schedule: (Array.isArray(hostage.schedule) ? hostage.schedule : []).map((entry) => ({ ...entry, available: false })),
        dossier: undefined,
      },
    },
    target_ids: [text(hostage.id, 120)],
  }
}

/** Кого фракции уже уводили: одного и того же заложника дважды не берут. */
function hostagesTaken(ledger) {
  return new Set(ledger.steps
    .flatMap((step) => step.entries)
    .filter((entry) => entry.kind === 'faction_move' && entry.move_kind === 'took_hostage' && entry.npc_id)
    .map((entry) => entry.npc_id))
}

/** Сколько раз фракция уже ходила каждым видом: круг формулировок считает это. */
function factionMovesByKind(ledger) {
  const counts = new Map(FACTION_MOVE_KINDS.map((kind) => [kind, 0]))
  for (const entry of ledger.steps.flatMap((step) => step.entries)) {
    if (entry.kind !== 'faction_move' || !counts.has(entry.move_kind)) continue
    counts.set(entry.move_kind, counts.get(entry.move_kind) + 1)
  }
  return counts
}

// ---------------------------------------------------------------------------
// Ход мира
// ---------------------------------------------------------------------------

const questLabel = (quest) => text(quest?.title, 180) || text(quest?.id, 120) || 'задание'

/**
 * Черновик факта памяти мира в той форме, которую ждёт редьюсер
 * (`safeFact`, `server/world-memory.mjs`). Собран в одном месте намеренно:
 * поля памяти мира легко забыть, а забытое `recorded_at_minutes` тихо ставит
 * факт в нулевую минуту и выносит его за горизонт выдачи.
 */
function worldFactDraft({ id, subjectId, predicate, object, summary, atMinutes }) {
  return {
    event_type: 'WorldFactRecorded',
    visibility: 'party',
    payload: {
      fact: {
        id,
        subject_id: subjectId,
        predicate,
        object: JSON.stringify(object).slice(0, 1_000),
        summary,
        visibility: 'party',
        source_event_ids: [],
        source_command_id: '',
        supersedes_fact_id: '',
        status: 'active',
        recorded_at_minutes: atMinutes,
      },
    },
    target_ids: [],
  }
}

/**
 * Ход мира за один скачок времени. Чистая функция: одинаковое состояние и
 * одинаковый скачок дают одинаковый результат, поэтому replay воспроизводит его
 * без отдельного счётчика и без обращения к модели.
 *
 * @returns {{ step: any, drafts: any[] } | null}
 */
export function planOffscreenWorldStep(state = {}, { elapsedMinutes = 0 } = {}) {
  const jump = Math.max(0, integer(elapsedMinutes, 0))
  if (jump < OFFSCREEN_STEP_MINIMUM_MINUTES) return null
  const atMinutes = worldMinutes(state) + jump
  const ledger = normalizeOffscreenWorldState(state?.offscreen_world)
  const previous = ledger.steps.at(-1)
  if (previous && atMinutes - previous.at_minutes < OFFSCREEN_STEP_INTERVAL_MINUTES) return null

  const quests = partyQuests(state)
  const watchedSince = new Map(ledger.watch.map((entry) => [entry.quest_id, entry.since_minutes]))
  const entries = []
  const drafts = []

  // 1. Просроченное. Считается до движения часов: протухает то, что уже стояло
  //    заполненным целые сутки, а не то, что заполнилось этим же ходом.
  const expired = quests
    .filter((quest) => questClockOf(quest).triggered)
    .filter((quest) => watchedSince.has(String(quest.id))
      && atMinutes - watchedSince.get(String(quest.id)) >= OFFSCREEN_QUEST_EXPIRY_MINUTES)
    .slice(0, MAX_EXPIRED_ENTRIES)
  for (const quest of expired) {
    const title = questLabel(quest)
    const summary = `«${title}»: срок вышел, помощи так и не дождались.`
    entries.push({ kind: 'quest_expired', quest_id: text(quest.id, 120), quest_title: title, summary })
    drafts.push({
      event_type: 'QuestResolved',
      visibility: 'party',
      payload: {
        quest_id: text(quest.id, 120),
        outcome: 'failure',
        status: 'failed',
        summary,
        next_objective: 'Разобраться, чем обернулся упущенный срок.',
        source_event_ids: [],
        policy_id: OFFSCREEN_WORLD_POLICY_ID,
      },
      target_ids: [],
    })
    // Факт памяти мира — то, ради чего протухание вообще нужно: Режиссёр и
    // рассказчик обязаны узнать об упущенном сроке из памяти, а не из ленты.
    const entityId = `offscreen-quest-${digest(text(quest.id, 120)).slice(0, 20)}`
    drafts.push({
      event_type: 'WorldEntityUpserted',
      visibility: 'party',
      payload: {
        entity: {
          id: entityId,
          kind: 'event',
          name: title,
          summary: text(quest.summary, 1_000),
          aliases: [],
          visibility: 'party',
          tags: ['offscreen-world'],
        },
      },
      target_ids: [],
    })
    drafts.push(worldFactDraft({
      id: `fact:offscreen-quest-expired:${digest(text(quest.id, 120), String(atMinutes)).slice(0, 20)}`,
      subjectId: entityId,
      predicate: 'quest_deadline_missed',
      object: { quest_id: text(quest.id, 120), at_minutes: atMinutes },
      summary,
      atMinutes,
    }))
  }

  const expiredIds = new Set(expired.map((quest) => String(quest.id)))

  // 2. Часы. Последнее деление мир не ставит: заполненные часы — это исход, а
  //    исход принадлежит столу.
  const ticking = quests
    .filter((quest) => !expiredIds.has(String(quest.id)))
    .filter((quest) => {
      const clock = questClockOf(quest)
      return !clock.triggered && clock.current + 1 < clock.max
    })
    .slice(0, OFFSCREEN_QUEST_TICK_LIMIT)
  for (const quest of ticking) {
    const clock = questClockOf(quest)
    const title = questLabel(quest)
    entries.push({
      kind: 'quest_clock',
      quest_id: text(quest.id, 120),
      quest_title: title,
      count: clock.current + 1,
      summary: `«${title}»: срок поджимает (${clock.current + 1} из ${clock.max}).`,
    })
    drafts.push({
      event_type: 'QuestClockAdvanced',
      visibility: 'party',
      payload: { quest_id: text(quest.id, 120), amount: 1, policy_id: OFFSCREEN_WORLD_POLICY_ID },
      target_ids: [],
    })
  }

  // 3. Наблюдение. Заполненные часы, которых мир ещё не видел, встают под
  //    отсчёт: следующий ход мира через сутки закроет их провалом, если стол и
  //    Режиссёр так и не назвали исход.
  const watchAfter = []
  const questById = new Map(quests.map((quest) => [String(quest.id), quest]))
  for (const [questId, since] of watchedSince) {
    if (expiredIds.has(questId) || !questById.has(questId)) continue
    if (!questClockOf(questById.get(questId)).triggered) continue
    watchAfter.push({ quest_id: questId, since_minutes: since })
  }
  let announcedDeadlines = 0
  for (const quest of quests) {
    const questId = String(quest.id)
    if (expiredIds.has(questId) || watchedSince.has(questId)) continue
    if (!questClockOf(quest).triggered) continue
    watchAfter.push({ quest_id: questId, since_minutes: atMinutes })
    if (announcedDeadlines >= MAX_DEADLINE_ENTRIES) continue
    announcedDeadlines += 1
    entries.push({
      kind: 'quest_deadline',
      quest_id: text(quest.id, 120),
      quest_title: questLabel(quest),
      summary: `«${questLabel(quest)}»: часы заполнены, счёт пошёл на сутки.`,
    })
  }

  // 4. Ход фракции-антагониста.
  const faction = antagonistFactionFor(state)
  const factionPlan = faction
    ? planFactionMove(state, {
        faction,
        atMinutes,
        takenIds: hostagesTaken(ledger),
        movesByKind: factionMovesByKind(ledger),
      })
    : null
  const factionMove = factionPlan?.entry ?? null
  if (factionMove) {
    entries.push(factionMove)
    // Увод — единственный ход, который меняет не только память мира: без этого
    // драфта Режиссёр вывел бы уведённого к отряду в следующей же сцене.
    if (factionPlan.hostage) drafts.push(hostageUnavailableDraft(factionPlan.hostage))
    const entityId = text(factionMove.faction_id, 120)
    drafts.push(worldFactDraft({
      id: `fact:offscreen-faction:${digest(entityId, factionMove.move_kind, String(atMinutes)).slice(0, 20)}`,
      subjectId: entityId,
      predicate: `faction_offscreen_move:${factionMove.move_kind}`,
      object: {
        faction_id: entityId,
        move_kind: factionMove.move_kind,
        npc_id: factionMove.npc_id ?? '',
        at_minutes: atMinutes,
      },
      summary: factionMove.summary,
      atMinutes,
    }))
  }

  // 5. Молва. Своих `RecordRumor` модуль не пишет — их пишет драйвер часов
  //    молвы. Здесь считается только то, сколько ушей слух догонит к этой
  //    минуте: без этой строки карточка молчала бы о самой заметной части хода.
  const rumors = rumorSpreadTargets(state, { worldMinute: atMinutes }).length
  if (rumors > 0) {
    entries.push({
      kind: 'rumor_spread',
      count: rumors,
      summary: rumors === 1
        ? 'Молва о делах отряда доходит ещё до одного человека.'
        : `Молва о делах отряда расходится дальше: её пересказывают ещё ${rumors} раз.`,
    })
  }

  if (!entries.length) return null

  const bounded = entries.slice(0, MAX_ENTRIES).map(safeEntry).filter(Boolean)
  const lines = offscreenLinesFor(bounded)
  const step = safeStep({
    id: `offscreen:${digest(campaignSeedOf(state), String(atMinutes), String(jump)).slice(0, 24)}`,
    at_minutes: atMinutes,
    elapsed_minutes: jump,
    day: offscreenCampaignDay(atMinutes),
    entries: bounded,
    lines,
  })
  if (!step) return null

  drafts.push({
    event_type: OFFSCREEN_WORLD_EVENT_TYPE,
    visibility: 'party',
    payload: {
      schema_version: OFFSCREEN_WORLD_SCHEMA_VERSION,
      policy_id: OFFSCREEN_WORLD_POLICY_ID,
      step,
      watch_after: watchAfter.slice(-MAX_WATCH),
    },
    target_ids: [],
  })
  // Сводка памяти мира — стык с рекапом «В прошлой серии»: он собирается из
  // `worldMemory.summaries` (`server/campaign-recap.mjs`), и без этой записи
  // ход мира не дожил бы до следующего вечера.
  drafts.push({
    event_type: 'NarrativeSummaryRecorded',
    visibility: 'party',
    payload: {
      summary: {
        id: `summary:${step.id}`,
        kind: 'scene',
        title: OFFSCREEN_CARD_TITLE,
        summary: lines.join(' '),
        visibility: 'party',
        entity_ids: [],
        thread_ids: [],
        source_event_ids: [],
        source_command_id: '',
        recorded_at_minutes: atMinutes,
      },
    },
    target_ids: [],
  })
  return { step, drafts }
}

/**
 * Порядок строк карточки — порядок важности за столом: сначала то, что уже
 * потеряно, потом ход противника, потом сроки и молва. Строк не больше трёх:
 * «Пока вас не было…» — врезка, а не глава.
 */
const LINE_PRIORITY = Object.freeze(['quest_expired', 'faction_move', 'quest_deadline', 'quest_clock', 'rumor_spread'])

export function offscreenLinesFor(entries = []) {
  const list = Array.isArray(entries) ? entries : []
  return LINE_PRIORITY
    .flatMap((kind) => list.filter((entry) => entry?.kind === kind))
    .map((entry) => text(entry.summary, 400))
    .filter(Boolean)
    .slice(0, MAX_LINES)
}

// ---------------------------------------------------------------------------
// Редьюсер и ленты
// ---------------------------------------------------------------------------

export function applyOffscreenWorldEvent(input, event) {
  const normalized = input?.schema_version === OFFSCREEN_WORLD_SCHEMA_VERSION && Array.isArray(input.steps)
    ? input
    : normalizeOffscreenWorldState(input)
  if (String(event?.event_type ?? '') !== OFFSCREEN_WORLD_EVENT_TYPE) return normalized
  const step = safeStep(event?.payload?.step)
  if (!step || normalized.steps.some((entry) => entry.id === step.id)) return normalized
  return normalizeOffscreenWorldState({
    ...normalized,
    steps: [...normalized.steps, step],
    watch: Array.isArray(event?.payload?.watch_after) ? event.payload.watch_after : normalized.watch,
  })
}

/** Лента ведущего: свежие ходы мира сверху, подписи уже проставлены. */
export function offscreenWorldFeed(state = {}, { limit = 20 } = {}) {
  return normalizeOffscreenWorldState(state?.offscreen_world).steps
    .slice()
    .sort((left, right) => right.at_minutes - left.at_minutes || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(MAX_STEPS, integer(limit, 20))))
    .map((step) => ({
      ...step,
      entries: step.entries.map((entry) => ({ ...entry, label: OFFSCREEN_ENTRY_LABELS[entry.kind] ?? entry.kind })),
    }))
}

/**
 * Карточка летописи из уже подтверждённого события. Строится на сервере, потому
 * что подписи и порядок строк обязаны быть одни и те же у ведущего и у стола.
 */
export function offscreenChronicleEntry(event = {}) {
  if (String(event?.event_type ?? '') !== OFFSCREEN_WORLD_EVENT_TYPE) return null
  const step = safeStep(event?.payload?.step)
  if (!step || !step.lines.length) return null
  return {
    id: `chronicle:${step.id}`,
    speaker: 'system',
    author: OFFSCREEN_CARD_TITLE,
    text: step.lines.join(' '),
    offscreen: {
      title: OFFSCREEN_CARD_TITLE,
      day: step.day,
      at_minutes: step.at_minutes,
      elapsed_minutes: step.elapsed_minutes,
      lines: step.lines,
    },
  }
}
