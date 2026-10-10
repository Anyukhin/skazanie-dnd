import { NARRATOR_PRIORITY, assertNarratorContract } from './deterministic-narration.mjs'
import { BLESSING_CONDITION } from './blessings.mjs'
import { canonicalCombatSpellFor } from './combat-spells.mjs'
import { sceneInteractionNarration, sceneObjectLabelFor } from './scene-interactions.mjs'
import {
  TIME_OF_DAY_CHANGED_EVENT, UNDERGROUND_SCENE_THEMES, WORLD_CLOCK_EVENT_TYPES,
  elapsedMinutesOf, timeOfDayOf, worldClockNarration,
} from './weather.mjs'
import { concentrationEndReasonLabel } from './concentration-end-reasons.mjs'
import {
  Phrasebook, accusativeName, actionPhrase, attackPhrase, confidentAccusative, damagePhrase, downedPhrase,
  encounterEndPhrase, encounterIntroPhrase, hoursLabelRu, joinRu, lowerFirst, movePhrase, savePhrase,
  spellSourceText, stabilizedPhrase, tacticLead, turnEndPhrase, turnStartPhrase,
} from './combat-phrases.mjs'

// Склонение имени живёт в словаре реплик; запасной рассказчик и тесты берут его отсюда.
export { accusativeName }

/**
 * Боевой текст для ленты: удары, состояния, спасброски, ход времени.
 *
 * Жил в `server/index.mjs` до 2026-07-27 и там был непроверяем — функция не
 * экспортировалась, а импорт `index.mjs` поднимает HTTP-слушателя. Из-за этого
 * ветка про концентрацию годами печатала модификаторы врага без проверки на
 * сторону, и записать это можно было только в `known-limitations`.
 *
 * Перенесён сюда вместе с разбором долга `*-narration`: теперь это обычный
 * рассказчик того же контракта, что сцена, торговля и столкновение, и он
 * покрыт тестом.
 *
 * Важно: сюда приходят **сырые** committed events, а не проекция. Поэтому всё,
 * что принадлежит врагу, закрывается здесь вручную — флагом `targetIsEnemy`.
 */
function tacticalActorName(state, id) {
  const expected = String(id || '')
  const actor = [...(state?.players ?? []), ...(state?.enemies ?? []), ...(state?.actors ?? [])]
    .find((candidate) => String(candidate.id ?? candidate.actor_id ?? '') === expected)
  return String(actor?.character || actor?.name || expected || 'Участник')
}

/**
 * Выбывший противник: место в инициативе за ним остаётся — по его ходам
 * считаются сроки наложенных им эффектов, — но рассказывать о его ходе
 * нечего. Плейтест 2026-10-03: убитый хобгоблин каждый раунд «завершал ход».
 * Герой на нуле не выбывший: его ход — спасбросок от смерти.
 */
function defeatedEnemy(state, id) {
  const expected = String(id || '')
  const enemy = (state?.enemies ?? []).find((candidate) => String(candidate.id ?? '') === expected)
  return Boolean(enemy) && Number(enemy.hp) <= 0
}

/**
 * Причина конца боя — служебный код (`enemies_defeated`, `party_defeated`…),
 * а читает её игрок. Плейтест 2026-10-03: «Столкновение завершено: resolved».
 * Незнакомый код не печатается: лучше общее «исход подтверждён», чем латиница.
 */
const ENCOUNTER_END_TEXT = Object.freeze({
  resolved: 'исход подтверждён',
  victory: 'победа',
  enemies_defeated: 'противники повержены',
  party_defeated: 'отряд пал',
  party_incapacitated: 'отряд не может продолжать бой',
  surrendered: 'противник сдался',
  truce: 'стороны заключили перемирие',
  parley: 'стороны договорились',
  fled: 'противник бежал',
})

/**
 * @param {unknown} reason
 * @returns {string}
 */
export function encounterEndText(reason) {
  const code = String(reason ?? '').trim()
  if (Object.hasOwn(ENCOUNTER_END_TEXT, code)) return ENCOUNTER_END_TEXT[/** @type {keyof typeof ENCOUNTER_END_TEXT} */ (code)]
  // Свободный русский текст ведущего (ruling) проходит как есть.
  return /[а-яё]/iu.test(code) && !/[a-z]/iu.test(code) ? code.slice(0, 120) : ENCOUNTER_END_TEXT.resolved
}

/**
 * Длительности политики `post_encounter_recovery` — те же, что в
 * `completeEncounterUnlocked` (`server/autonomous-orchestrator.mjs`): долгий
 * отдых и, если кто-то из выживших лежит на нуле, время прийти в себя до него.
 */
const POST_VICTORY_REST_MINUTES = 480
/** Привал после победы — только по заявке игроков (решение владельца 2026-10-10). */
const POST_VICTORY_REST_DISABLED = true
const POST_VICTORY_STABLE_RECOVERY_MINUTES = 240

/** Причины `DowntimeResolved`, которые пишет политика `post_encounter_recovery`. */
const POST_VICTORY_DOWNTIME_REASONS = new Set(['post_encounter_recovery', 'post_encounter_recovery_after_stabilisation', 'post_defeat_recovery'])

/**
 * Сколько минут отряд проведёт в отдыхе, когда продолжит историю после этой
 * победы; 0 — отдыха не будет. Условие то же, что у политики
 * `post_encounter_recovery` в `completeEncounterUnlocked`
 * (`server/autonomous-orchestrator.mjs`): исход `enemies_defeated` и хотя бы
 * один не погибший участник отряда с ОЗ выше нуля. Политику строка не решает —
 * она лишь называет её заранее.
 *
 * Плейтест 2026-10-04, MC-03: после победы «Продолжим» проматывал 8 часов
 * долгого отдыха, и игрок узнавал об этом только по строке «завершает
 * продолжительный отдых».
 */
function postVictoryRestMinutes(state, outcome) {
  // После победы привала без заявки больше нет (решение владельца
  // 2026-10-10) — строке победы нечего обещать.
  if (POST_VICTORY_REST_DISABLED || String(outcome ?? '') !== 'enemies_defeated') return 0
  const partyIds = new Set((state?.partyMemberIds ?? []).map(String))
  const survivors = (state?.players ?? []).filter((hero) => partyIds.has(String(hero?.id ?? ''))
    && state?.mechanics?.death?.heroes?.[hero.id]?.status !== 'dead')
  if (!survivors.some((hero) => Number(hero?.hp) > 0)) return 0
  return POST_VICTORY_REST_MINUTES
    + (survivors.some((hero) => Number(hero?.hp) === 0) ? POST_VICTORY_STABLE_RECOVERY_MINUTES : 0)
}

/** «1 зм 5 см», «7 мм» — монеты награды словами стола. */
function coinsLabelRu(value) {
  let copper = Math.max(0, Math.trunc(Number(value) || 0))
  const gold = Math.floor(copper / 100)
  copper -= gold * 100
  const silver = Math.floor(copper / 10)
  copper -= silver * 10
  return [gold ? `${gold} зм` : '', silver ? `${silver} см` : '', copper ? `${copper} мм` : ''].filter(Boolean).join(' ')
}

/** «Короткий лук», «Кинжал» (2 шт.) — одноимённые экземпляры склеиваются. */
function rewardItemsList(items) {
  const counts = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const name = String(item?.name ?? '').replace(/\s+/gu, ' ').trim().slice(0, 80)
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + Math.max(1, Math.trunc(Number(item?.quantity) || 1)))
  }
  return [...counts].map(([name, count]) => (count > 1 ? `«${name}» (${count} шт.)` : `«${name}»`))
}

function rewardItemsLabel(items) {
  return joinRu(rewardItemsList(items))
}

/**
 * Сводка награды встречи по `EncounterRewardsDistributed`: кому какие вещи,
 * сколько монет и опыта. Только из payload события — нового события строка не
 * пишет, и повтор «Продолжим» её не удваивает: завершение встречи идемпотентно
 * и во второй раз событий не возвращает.
 *
 * Плейтест 2026-10-04, MC-05: после победы над волком в инвентаре появились
 * короткий лук и стрелы, а откуда — нигде не говорилось. Это доля отряда за
 * победу (`server/encounter-rewards.mjs`), а не вещи с тела.
 */
function encounterRewardLine(payload, state, book, event) {
  const allocations = Array.isArray(payload?.allocations) ? payload.allocations : []
  // «Лира забирает «Короткий лук» и «Стрелы», Бор — «Кинжал» (2 шт.)»: кто что
  // взял, одной фразой, а не таблицей. Слова «доля отряда за победу» остаются:
  // это вещи общей добычи, а не снятое с тела (MC-05).
  const shares = allocations.flatMap((allocation) => {
    const items = rewardItemsList(allocation?.items)
    return items.length ? [{ name: tacticalActorName(state, allocation?.recipient_id), items: joinRu(items) }] : []
  })
  const parts = []
  if (shares.length) {
    const [first, ...rest] = shares
    parts.push([`${first.name} забирает ${first.items}`, ...rest.map((share) => `${share.name} — ${share.items}`)].join('; '))
  }
  const shared = allocations.length > 1 ? ' поровну' : ''
  const coins = coinsLabelRu(allocations.reduce((sum, allocation) => sum + Math.max(0, Number(allocation?.coins_cp) || 0), 0))
  if (coins) parts.push(`монеты${shared} — ${coins}`)
  const xp = allocations.reduce((sum, allocation) => sum + Math.max(0, Math.trunc(Number(allocation?.xp) || 0)), 0)
  if (xp) parts.push(`опыт${shared} — ${xp}`)
  const leftover = rewardItemsLabel(payload?.unassigned?.items)
  if (leftover) parts.push(`всё унести не выходит, пришлось оставить: ${leftover}`)
  if (!parts.length) return ''
  const head = book.pick('reward', ['Доля отряда за победу', 'Добыча делится — доля отряда за победу'], event)
  return `${head}: ${parts.join('; ')}.`
}

function tacticalActorIsEnemy(state, id) {
  const expected = String(id || '')
  return (state?.enemies ?? []).some((candidate) => String(candidate.id ?? candidate.actor_id ?? '') === expected)
}

/** Герой отряда — тот, кто на нуле бросает спасброски от смерти. */
function tacticalActorIsHero(state, id) {
  const expected = String(id || '')
  return Boolean(expected) && (state?.players ?? []).some((candidate) => String(candidate.id ?? candidate.actor_id ?? '') === expected)
}

const COVER_SCENERY_LABELS = Object.freeze({
  altar: 'алтарь', barrel: 'бочку', bed: 'кровать', bookshelf: 'шкаф', bush: 'куст',
  chest: 'сундук', console: 'пульт', crate: 'ящик', fireplace: 'очаг', grave: 'могилу',
  pillar: 'колонну', rock: 'камень', statue: 'статую', table: 'стол', tree: 'дерево', well: 'колодец',
})

const CONDITION_LABELS = Object.freeze({
  blinded: 'ослеплена', frightened: 'испугана', grappled: 'схвачена', incapacitated: 'недееспособна',
  invisible: 'невидима', paralyzed: 'парализована', petrified: 'окаменела', poisoned: 'отравлена',
  prone: 'сбита с ног', restrained: 'опутана', stunned: 'оглушена', unconscious: 'без сознания',
})

/** Названия состояний по книге — термином, без рода: «Кирем — состояние «Опутанный»». */
const MONSTER_HIT_CONDITION_TERMS = Object.freeze({
  blinded: 'Ослеплённый', frightened: 'Испуганный', grappled: 'Схваченный', paralyzed: 'Парализованный',
  poisoned: 'Отравленный', prone: 'Лежащий ничком', restrained: 'Опутанный', stunned: 'Ошеломлённый',
})

const ATTACKER_CONDITION_LABELS = Object.freeze({
  blinded: 'ослеплён', frightened: 'испуган', grappled: 'схвачен', incapacitated: 'недееспособен',
  invisible: 'невидим', paralyzed: 'парализован', petrified: 'окаменел', poisoned: 'отравлен',
  prone: 'сбит с ног', restrained: 'опутан', stunned: 'оглушён', unconscious: 'без сознания',
})

/**
 * Названия видов урона в именительном падеже — для фразы «яд не действует».
 * Точный список защит существа не раскрывается: игрок узнаёт ровно то, что
 * увидел за столом, — что именно этот удар не сработал.
 */
const DAMAGE_TYPE_LABELS = Object.freeze({
  acid: 'Кислота', bludgeoning: 'Дробящий удар', cold: 'Холод', fire: 'Огонь',
  force: 'Силовая волна', lightning: 'Молния', necrotic: 'Некротическая энергия',
  piercing: 'Колющий удар', poison: 'Яд', psychic: 'Психическая атака',
  radiant: 'Свет', slashing: 'Рубящий удар', thunder: 'Грохот',
})


const REACTION_ACTION_LABELS = Object.freeze({
  'opportunity-attack': 'Атака по возможности',
  'readied-attack': 'Подготовленная атака',
  'readied-spell': 'Подготовленное заклинание',
  'cast:shield': 'Щит',
  'uncanny-dodge': 'Невероятное уклонение',
})

export function damageTypeLabel(damageType) {
  return DAMAGE_TYPE_LABELS[String(damageType ?? '').toLowerCase()] ?? 'Этот урон'
}

/** Название заклинания в ёлочках или пусто, если имени нет ни в событии, ни в каталоге. */
function publicSpellLabel(payload) {
  const explicit = String(payload?.spell_name ?? payload?.name ?? '').trim()
  if (explicit && /[А-ЯЁа-яё]/u.test(explicit)) return `«${explicit}»`
  const catalogName = canonicalCombatSpellFor(payload?.spell_id)?.name
  return catalogName ? `«${String(catalogName)}»` : ''
}

function reactionActionLabel(payload) {
  const explicit = [payload?.name, ...(Array.isArray(payload?.action_options) ? payload.action_options.map((option) => option?.name) : [])]
    .map((value) => String(value ?? '').trim())
    .find((value) => value && /[А-ЯЁа-яё]/u.test(value))
  return explicit || REACTION_ACTION_LABELS[String(payload?.action_id ?? '')] || ''
}

function reactionActionText(payload) {
  const label = reactionActionLabel(payload)
  return label ? `реакцию «${label}»` : 'реакцию'
}

/** «реакцией «Щит»» — для «отвечает …». */
function reactionInstrumentalText(payload) {
  const label = reactionActionLabel(payload)
  return label ? `реакцией «${label}»` : 'реакцией'
}

/**
 * Explains why an attack was rolled with advantage or disadvantage.  When both
 * sides contribute they cancel and the roll is ordinary, so naming either one
 * would misdescribe what happened.
 */
function attackConditionReason(payload) {
  const advantage = payload.condition_advantage ?? []
  const disadvantage = payload.condition_disadvantage ?? []
  if ((advantage.length > 0) === (disadvantage.length > 0)) return ''
  const entries = advantage.length ? advantage : disadvantage
  const described = entries.map((entry) => {
    const [side, condition] = String(entry).split(':')
    return side === 'target'
      ? `цель ${CONDITION_LABELS[condition] ?? condition}`
      : `атакующий ${ATTACKER_CONDITION_LABELS[condition] ?? condition}`
  }).join(', ')
  return ` ${advantage.length ? 'с преимуществом' : 'с помехой'} (${described})`
}

/** Сколько строк уезжает в ленту за один ход. */
const MAX_NARRATION_LINES = 8

/**
 * Тот же разбор, но двумя частями: что сделал отряд и что стало с небом.
 *
 * Разделение нужно вызывающему, у которого есть **запасной** рассказчик. Раньше
 * `tacticalNarration(...) || deterministicNarration(...)` читалось как «если
 * боевой рассказчик молчал», но с появлением строки про небо молчать он перестал:
 * шаг Режиссёра, пересёкший 17:00, отдавал в ленту одну фразу про вечер, а
 * описание перехода — «Сцена перемещена из … в …» — пропадало. Небо теперь
 * дописывается **к** запасному тексту, а не вместо него.
 *
 * `options.npcTurns` — ходы существ из планировщика (`turns` у
 * `runNpcTurnScheduler`): их публичная тактика («сокращает дистанцию», «тактика
 * стаи») окрашивает перемещение и первую атаку существа в этом ходе.
 */
export function tacticalNarrationParts(events, state, options = {}) {
  const { main, sky } = tacticalNarrationLines(events, state, options)
  return {
    main: main.slice(0, MAX_NARRATION_LINES).join(' '),
    sky: sky.slice(0, Math.max(0, MAX_NARRATION_LINES - main.length)).join(' '),
  }
}

/**
 * События хода без неба: ровно то, что видит запасной рассказчик.
 *
 * Строку про небо дописывает `tacticalNarrationOr`, и второй её формы в тексте
 * быть не должно. Запасной рассказчик (`qualitativeEventSummary`) описывает
 * смену времени суток тем же самым предложением, поэтому шаг Режиссёра,
 * пересёкший 17:00, отдавал в летопись «наступил вечер» дважды подряд.
 */
function eventsWithoutWorldClock(events) {
  return (events ?? []).filter((event) => !WORLD_CLOCK_EVENT_TYPES.has(event?.event_type))
}

function isAdditionalBeamSpellCast(event) {
  return event?.event_type === 'SpellCast'
    && event?.payload?.economy_consumed === false
    && (
      /^spell-cast:.+:beam:\d+$/u.test(String(event?.event_id ?? ''))
      || /:beam:\d+$/u.test(String(event?.command_id ?? ''))
    )
}

/**
 * Текст хода с запасным вариантом. `fallback` — строка или функция, которую
 * зовут лишь тогда, когда боевому рассказчику сказать про сам ход нечего:
 * запасной рассказчик стоит дорого, и звать его ради выброшенного результата
 * незачем. Функции отдаётся уже очищенный от неба список событий — так забыть
 * про фильтр на очередном месте вызова физически негде.
 */
export function tacticalNarrationOr(events, state, fallback, options = {}) {
  const { main, sky } = tacticalNarrationParts(events, state, options)
  const base = main || String((typeof fallback === 'function' ? fallback(eventsWithoutWorldClock(events)) : fallback) ?? '')
  return [base, sky].filter(Boolean).join(' ')
}

/**
 * События, по которым строка летописи — строка боя. Всё остальное, что
 * приходит маршрутом команд вне боя (осмотр бочки, кости в таверне, молитва),
 * говорит голосом рассказчика: плейтест 2026-10-10 — осмотр бочки подписывался
 * «Система боя».
 */
const COMBAT_VOICE_EVENT_TYPES = new Set([
  'AttackResolved', 'AreaAttackResolved', 'CombatStarted', 'CombatEnded', 'EncounterCreated', 'EncounterEnded',
  'TurnStarted', 'TurnEnded', 'ReactionWindowOpened', 'ReactionWindowClosed', 'HitPointsReducedToZero',
  'DeathSavingThrowRolled', 'LegendaryActionUsed',
])

/**
 * Кто говорит строку хода в летописи: «Система боя» — только в бою или когда
 * сам ход и есть бой; вне боя — «Рассказчик».
 *
 * @param {unknown[]} events
 * @param {any} state
 * @returns {{ speaker: 'system' | 'narrator', author: string }}
 */
export function combatJournalVoice(events, state) {
  const combatLine = Boolean(state?.mechanics?.combat?.active)
    || (Array.isArray(events) ? events : []).some((event) => COMBAT_VOICE_EVENT_TYPES.has(String(/** @type {any} */ (event)?.event_type ?? '')))
  return combatLine ? { speaker: 'system', author: 'Система боя' } : { speaker: 'narrator', author: 'Рассказчик' }
}

/**
 * Где искать находку у предмета и как его назвать в винительном. Ключ —
 * русское имя пропса (`sceneObjectLabelFor`). Предмета нет в таблице — строка
 * остаётся прежней из `sceneInteractionNarration`.
 */
const PROP_PHRASES = Object.freeze({
  'сундук': { inside: 'Под крышкой сундука', accusative: 'сундук' },
  'бочка': { inside: 'Под крышкой бочки', accusative: 'бочку' },
  'ящик': { inside: 'В ящике', accusative: 'ящик' },
  'саркофаг': { inside: 'Под крышкой саркофага', accusative: 'саркофаг' },
  'урна': { inside: 'В урне', accusative: 'урну' },
  'ниша': { inside: 'В нише', accusative: 'нишу' },
  'ковчег': { inside: 'В ковчеге', accusative: 'ковчег' },
  'буфет': { inside: 'В буфете', accusative: 'буфет' },
  'платяной шкаф': { inside: 'В платяном шкафу', accusative: 'платяной шкаф' },
  'корзина': { inside: 'В корзине', accusative: 'корзину' },
  'бочонок': { inside: 'В бочонке', accusative: 'бочонок' },
  'могила': { inside: 'В могиле', accusative: 'могилу' },
  'труп': { inside: 'При теле', accusative: 'тело' },
  'кости': { inside: 'Среди костей', accusative: 'кости' },
  'полка': { inside: 'На полке', accusative: 'полку' },
  'стеллаж': { inside: 'На стеллаже', accusative: 'стеллаж' },
  'телега': { inside: 'В телеге', accusative: 'телегу' },
  'лоток': { inside: 'На лотке', accusative: 'лоток' },
  'сено': { inside: 'В сене', accusative: 'сено' },
  'стойка': { inside: 'За стойкой', accusative: 'стойку' },
  'полка за стойкой': { inside: 'На полке за стойкой', accusative: 'полку за стойкой' },
  'стол': { inside: 'На столе', accusative: 'стол' },
  'алтарь': { inside: 'На алтаре', accusative: 'алтарь' },
  'статуя': { inside: 'У подножия статуи', accusative: 'статую' },
  'руна': { inside: 'У руны', accusative: 'руну' },
  'святилище': { inside: 'В святилище', accusative: 'святилище' },
  'королевский трон': { inside: 'У трона', accusative: 'трон' },
  'завал': { inside: 'Под завалом', accusative: 'завал' },
  'валун': { inside: 'Под валуном', accusative: 'валун' },
  'пень': { inside: 'У пня', accusative: 'пень' },
  'бревно': { inside: 'Под бревном', accusative: 'бревно' },
  'верстовой столб': { inside: 'У верстового столба', accusative: 'верстовой столб' },
  'колонна': { inside: 'У колонны', accusative: 'колонну' },
  'жаровня': { inside: 'У жаровни', accusative: 'жаровню' },
  'костёр': { inside: 'У костра', accusative: 'костёр' },
  'люстра': { inside: 'На люстре', accusative: 'люстру' },
  'сталагмит': { inside: 'У сталагмита', accusative: 'сталагмит' },
})

function scenePropPhrase(state, propId) {
  const expected = String(propId ?? '')
  if (!expected) return null
  const props = Array.isArray(state?.scene?.map?.props) ? state.scene.map.props : []
  const prop = props.find((candidate) => String(candidate?.id ?? '') === expected)
  const label = prop ? String(sceneObjectLabelFor(prop.assetId) ?? '').toLocaleLowerCase('ru') : ''
  const phrase = label ? PROP_PHRASES[/** @type {keyof typeof PROP_PHRASES} */ (label)] : null
  return phrase ? { ...phrase, label } : null
}

function lootNames(loot) {
  return (Array.isArray(loot) ? loot : [])
    .map((item) => lowerFirst(String(item?.name ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120)))
    .filter(Boolean)
}

/**
 * Строка взаимодействия с предметом сцены словами стола: «Под крышкой бочки —
 * боевой посох», «Лира осматривает сундук и замечает ловушку». Приоритет исходов
 * тот же, что у `sceneInteractionNarration`; там, где имени предмета нет или
 * исход уже звучит сценой (шум у замка, знание, ловушка, привал), остаётся
 * прежняя строка.
 */
function sceneInteractionLine(events, state) {
  const fallback = sceneInteractionNarration(events)
  if (!fallback) return ''
  const batch = Array.isArray(events) ? events : []
  if (batch.some((event) => event?.event_type === 'LockpickNoticed'
    || (event?.event_type === 'SceneObjectKnowledgeRevealed' && event?.payload?.text)
    || (event?.event_type === 'DamageApplied' && event?.payload?.reason === 'scene-object-trap'))) return fallback
  const anchor = batch.find((event) => String(event?.event_type ?? '').startsWith('SceneObject') && event?.payload?.prop_id)
  const actor = anchor?.actor_id ? tacticalActorName(state, anchor.actor_id) : 'Герой'
  const granted = batch.find((event) => event?.event_type === 'SceneObjectLootGranted')
  if (granted) {
    const names = lootNames(granted.payload?.loot)
    return names.length ? `${actor} забирает ${joinRu(names)}.` : `${actor} забирает находку.`
  }
  const place = anchor ? scenePropPhrase(state, anchor.payload.prop_id) : null
  const revealed = batch.find((event) => event?.event_type === 'SceneObjectLootRevealed')
  if (revealed) {
    const names = lootNames(revealed.payload?.loot)
    if (!names.length) return fallback
    return `${place?.inside ?? 'Внутри'} — ${joinRu(names)}.`
  }
  if (batch.some((event) => event?.event_type === 'RestCompleted' && event?.payload?.source_prop_id)) return fallback
  if (!place) return fallback
  const changed = [...batch].reverse().find((event) => event?.event_type === 'SceneObjectStateChanged')
  if (changed?.payload?.success === false) {
    return changed.payload.intent === 'lockpick' ? fallback : `${actor} пытается, но ${place.label} не поддаётся.`
  }
  if (changed?.payload?.state === 'open') return changed.payload.intent === 'lockpick' ? fallback : `${actor} открывает ${place.accusative}.`
  if (changed?.payload?.state === 'toppled') return `${actor} опрокидывает ${place.accusative}.`
  if (changed?.payload?.state === 'burning') return `${actor} поджигает ${place.accusative} — огонь занимается.`
  if (changed?.payload?.state === 'taken') return `${actor} забирает содержимое.`
  if (changed?.payload?.state === 'used') return `${actor} использует ${place.accusative}.`
  const inspected = batch.find((event) => event?.event_type === 'SceneObjectInspected')
  if (inspected) {
    if (inspected.payload?.success === false) return `${actor} осматривает ${place.accusative}, но ничего определённого не находит.`
    return inspected.payload?.trap_detected === true
      ? `${actor} осматривает ${place.accusative} и замечает ловушку.`
      : `${actor} осматривает ${place.accusative} — ничего необычного.`
  }
  return fallback
}

/**
 * Обстановка столкновения для вступления: подземелье, ночь, лес, дорога…
 * Берётся из темы сцены, темы встречи и времени суток — того, что уже лежит в
 * состоянии.
 *
 * @returns {import('./combat-phrases.mjs').EncounterSetting}
 */
export function encounterSetting(state, encounter = {}) {
  const sceneTheme = String(state?.scene?.theme ?? state?.scene?.map?.theme ?? '').toLowerCase()
  const encounterTheme = String(encounter?.theme ?? '').toLowerCase()
  if (encounterTheme === 'ambush') return 'ambush'
  if (UNDERGROUND_SCENE_THEMES.has(sceneTheme) || ['crypt', 'cave'].includes(encounterTheme)) return 'underground'
  if (sceneTheme === 'graveyard') return 'graveyard'
  const outdoors = ['forest', 'road', 'settlement', 'graveyard', ''].includes(sceneTheme)
  if (outdoors && state?.mechanics?.world_time && timeOfDayOf(elapsedMinutesOf(state)) === 'night') return 'night'
  if (sceneTheme === 'forest') return 'forest'
  if (sceneTheme === 'road') return 'road'
  if (['settlement', 'building', 'temple'].includes(sceneTheme)) return 'settlement'
  return 'generic'
}

/**
 * Вступление столкновения по `EncounterCreated`: обстановка и состав.
 * Общая точка для боевого рассказчика и для `encounter-narration.mjs`.
 */
export function encounterIntro(event, state) {
  const encounter = event?.payload?.encounter && typeof event.payload.encounter === 'object' ? event.payload.encounter : {}
  const names = (Array.isArray(encounter.enemies) ? encounter.enemies : [])
    .map((enemy) => String(enemy?.name ?? '').replace(/\s+/gu, ' ').trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 12)
  return encounterIntroPhrase(new Phrasebook(), { names, setting: encounterSetting(state, encounter) }, event)
}

/** Тактика существа по ходам планировщика: первая названная на каждого. */
function npcTacticsFrom(turns) {
  const tactics = new Map()
  for (const turn of Array.isArray(turns) ? turns : []) {
    const id = String(turn?.actor_id ?? '')
    const tactic = String(turn?.tactic ?? '')
    if (id && tactic && !tactics.has(id)) tactics.set(id, tactic)
  }
  return tactics
}

function eventTargetId(event) {
  return String(event?.target_ids?.[0] ?? event?.payload?.target_id ?? '')
}

/**
 * Урон, который ложится в строку своего удара: тот же удар (команда) и та же
 * цель, до следующей атаки. Особые случаи — иммунитет, «Охрана от смерти»,
 * сопротивление заговору, проклятый рыцарь, ловушка — остаются своими строками.
 */
function mergeableDamageIndex(events, attackIndex, consumed) {
  const attack = events[attackIndex]
  const targetId = eventTargetId(attack)
  for (let index = attackIndex + 1; index < events.length; index += 1) {
    const candidate = events[index]
    if (candidate?.event_type === 'AttackResolved' || candidate?.event_type === 'AreaAttackResolved') return -1
    if (candidate?.event_type !== 'DamageApplied' || consumed.has(index)) continue
    if (eventTargetId(candidate) !== targetId) continue
    if (attack?.command_id && candidate?.command_id && String(attack.command_id) !== String(candidate.command_id)) continue
    const payload = candidate.payload ?? {}
    if (!(Number(payload.applied_amount) > 0) || payload.immune === true || payload.death_ward_triggered
      || payload.resistance_cantrip_reduction || payload.scenario_ward_text || payload.reason === 'scene-object-trap') return -1
    return index
  }
  return -1
}

function tacticalNarrationLines(events, state, options = {}) {
  const meaningful = []
  const turns = []
  /** Строки про небо: дописываются последними и не вытесняют события хода. */
  const sky = []
  const list = Array.isArray(events) ? events : []
  const book = new Phrasebook()
  // Долгий отдых приходит одной атомарной командой: в ней есть и начало, и
  // подтверждённое завершение. В летописи достаточно итоговой строки; короткий
  // отдых остаётся видимым по одному `RestStarted`, пока герой не завершит его
  // отдельной командой.
  const completedRestActors = new Set(list
    .filter((event) => event?.event_type === 'RestCompleted' && !event?.payload?.source_prop_id)
    .map((event) => String(event?.actor_id ?? '')))
  // Отдых после победы говорит одной строкой за весь отряд — у `DowntimeResolved`
  // политики восстановления; строки «завершает отдых» по каждому герою её
  // только дублировали бы (MC-03).
  const postVictoryRestActors = new Set(list
    .filter((event) => event?.event_type === 'DowntimeResolved' && POST_VICTORY_DOWNTIME_REASONS.has(String(event?.payload?.reason ?? '')))
    .flatMap((event) => (Array.isArray(event?.payload?.participant_ids) ? event.payload.participant_ids : []).map(String)))
  const sceneInteraction = sceneInteractionLine(list, state)
  if (sceneInteraction) meaningful.push(sceneInteraction)
  const partyFailed = list.some((event) => event?.event_type === 'CampaignFailed')
  // Окна, которые закрыл режим реакции героя («сразу» или «никогда»), никто не
  // видел: строка «получает возможность…» описывала бы вопрос, которого не было.
  const windowsByPreference = new Map(list
    .filter((event) => event?.event_type === 'ReactionWindowClosed' && event?.payload?.reaction_preference)
    .map((event) => [String(event.payload.id ?? ''), String(event.payload.reaction_preference)]))
  // Конец встречи уже говорит, что бой окончен: «Бой завершён в раунде N»
  // рядом с ним — та же новость второй раз.
  const encounterEnded = list.some((event) => event?.event_type === 'EncounterEnded')
  const tactics = npcTacticsFrom(options?.npcTurns)
  const tacticLeadUsed = new Set()
  /** Индексы событий, уже рассказанных строкой соседнего события. */
  const consumed = new Set()
  // Атака по возможности: строка «использует реакцию» и строка удара — один
  // поступок. Удар говорит за обоих («бьёт вдогонку»), отдельная строка
  // реакции перед ним только удлиняла ленту (плейтест 2026-10-10).
  const opportunityAttacks = new Set()
  list.forEach((event, index) => {
    if (event?.event_type !== 'CombatActionUsed' || event?.payload?.action_id !== 'opportunity-attack') return
    const attackIndex = list.findIndex((candidate, at) => at > index
      && candidate?.event_type === 'AttackResolved'
      && String(candidate?.actor_id ?? '') === String(event?.actor_id ?? ''))
    if (attackIndex < 0) return
    consumed.add(index)
    opportunityAttacks.add(attackIndex)
  })
  // Подтверждение окна реакции и сама реакция — тоже одна новость.
  list.forEach((event, index) => {
    if (event?.event_type !== 'ReactionWindowClosed' || event?.payload?.accepted !== true || event?.payload?.reaction_preference) return
    // Порядок бывает любым: у «Щита» движок пишет реакцию раньше закрытия окна,
    // и в строке боя стояло «отвечает реакцией «Щит»» дважды (замер 2026-10-10).
    const used = list.some((candidate, at) => at !== index
      && candidate?.event_type === 'CombatActionUsed'
      && (candidate?.payload?.action_type === 'reaction' || candidate?.payload?.reaction_window_id)
      && String(candidate?.actor_id ?? '') === String(event?.actor_id ?? ''))
    if (used) consumed.add(index)
  })
  // Время суток — одной строкой за ход: двенадцать часов отдыха пересекают две
  // границы, и в ленте стояли «наступила ночь» и «светает» подряд. Остаётся
  // последняя смена — то, каким отряд застаёт мир.
  const lastPhaseIndex = list.reduce((found, event, index) => (event?.event_type === TIME_OF_DAY_CHANGED_EVENT ? index : found), -1)
  const lastWeatherIndex = list.reduce((found, event, index) => (
    WORLD_CLOCK_EVENT_TYPES.has(event?.event_type) && event?.event_type !== TIME_OF_DAY_CHANGED_EVENT ? index : found), -1)
  list.forEach((event, index) => {
    const payload = event.payload ?? {}
    if (consumed.has(index)) return
    const actor = tacticalActorName(state, event.actor_id)
    const targetId = event.target_ids?.[0] ?? payload.target_id
    const target = tacticalActorName(state, targetId)
    const targetIsEnemy = tacticalActorIsEnemy(state, targetId)
    if (WORLD_CLOCK_EVENT_TYPES.has(event.event_type)) {
      // Небо описывает сам модуль погоды: строка детерминированная, и второй её
      // формы быть не должно — иначе журнал и подсказка индикатора разошлись бы.
      // Копится она отдельно, потому что дописывается **после** событий хода:
      // сначала что сделал отряд, потом что стало с миром.
      if (index !== lastPhaseIndex && index !== lastWeatherIndex) return
      const line = worldClockNarration(event)
      if (line) sky.push(line)
    } else if (event.event_type === 'EncounterCreated') {
      meaningful.push(encounterIntro(event, state))
    } else if (event.event_type === 'EncounterEnded') {
      // Отдых после победы объявляется в момент победы, а не задним числом:
      // «Продолжим» иначе молча проматывал 8 часов (плейтест 2026-10-04, MC-03).
      const restMinutes = postVictoryRestMinutes(state, payload.outcome ?? payload.reason)
      const restAhead = restMinutes
        // Голосом ведущего, без названия команды: «когда отряд продолжит
        // историю («продолжим»)» читалось как подсказка интерфейса (плейтест
        // 2026-10-10). Сколько продлится привал, игрок по-прежнему знает заранее.
        ? ` Можно перевести дух: дальше отряд встанет на привал и отдохнёт ${hoursLabelRu(restMinutes / 60)} — силы вернутся.`
        : ''
      meaningful.push(`${encounterEndPhrase(book, { endText: encounterEndText(payload.reason ?? payload.outcome) }, event)}${restAhead}`)
    } else if (event.event_type === 'EncounterRewardsDistributed') {
      const line = encounterRewardLine(payload, state, book, event)
      if (line) meaningful.push(line)
    } else if (event.event_type === 'DowntimeResolved' && POST_VICTORY_DOWNTIME_REASONS.has(String(payload.reason ?? ''))) {
      const hours = hoursLabelRu((Number(payload.duration_minutes) || POST_VICTORY_REST_MINUTES) / 60)
      meaningful.push(String(payload.reason) === 'post_defeat_recovery'
        // Поражение без смертей: победители ушли, отряд очнулся и отдохнул (autonomous-orchestrator).
        ? `Отряд приходит в себя после поражения: противники ушли, герои отдыхают ${hours} и восстанавливают силы.`
        : book.pick('victory-rest', [
          `Отряд разбивает лагерь и отдыхает ${hours} — силы восстановлены.`,
          `Привал на ${hours}: раны перевязаны, силы восстановлены.`,
          `После победы отряд отдыхает ${hours} и восстанавливает силы.`,
        ], event))
    } else if (event.event_type === 'CombatStarted') {
      const opening = payload.opening_action
      const firstId = state?.mechanics?.combat?.initiative?.[0]?.actor_id
      const order = opening?.actor_id ? '' : firstId ? ` Ход открывает ${tacticalActorName(state, firstId)}.` : ' Инициатива брошена.'
      meaningful.push(`${book.pick('combat-start', ['Бой начинается.', 'Звенит сталь — бой начался.', 'Схватка началась.'], event)}${order}`)
      // Бой открыт ударом из исследования. Отложенный удар обязан сказать о
      // себе: иначе игрок видит начавшийся бой и не понимает, куда делся замах.
      if (opening?.actor_id) {
        const attacker = tacticalActorName(state, opening.actor_id)
        // Нейтральный NPC после удара — уже противник: имя берётся из боя.
        const victimName = opening.npc_id ? tacticalActorName(state, opening.npc_id) : ''
        const victimAccusative = victimName ? confidentAccusative(victimName) : null
        const victim = victimName ? ` на ${victimAccusative ?? accusativeName(victimName)}` : ''
        meaningful.push(opening.free_strike === true
          ? `${attacker} нападает${victim} вне очереди, пока никто не успел опомниться, — свой ход это не отнимает.`
          : opening.status === 'deferred'
            ? `${attacker} нападает${victim}, но ${tacticalActorName(state, opening.first_actor_id)} успевает раньше: удар придётся повторить в свой ход.`
            : `${attacker} нападает${victim} и открывает бой.`)
      }
      const surprised = (payload.surprised ?? []).map((id) => tacticalActorName(state, id))
      if (surprised.length) meaningful.push(`Застигнуты врасплох: ${surprised.join(', ')} — первый ход они теряют и не могут использовать реакцию.`)
    } else if (event.event_type === 'ReactionWindowOpened' && windowsByPreference.has(String(payload.id ?? ''))) {
      // Ответ уже дан заранее — о нём скажет строка самой реакции.
    } else if (event.event_type === 'ReactionWindowClosed' && payload.reaction_preference) {
      // «Никогда» молчит: отказ без вопроса — не событие боя. «Сразу» описано
      // строкой использованной реакции ниже.
    } else if (event.event_type === 'ReactionWindowOpened') {
      const reactor = tacticalActorName(state, (event.target_ids ?? [])[0] ?? payload.target_id)
      const source = tacticalActorName(state, payload.source_actor_id ?? event.actor_id)
      const reply = reactionInstrumentalText(payload)
      const trigger = String(payload.trigger ?? '')
      meaningful.push(trigger === 'enemy-left-reach'
        ? `${source} выходит из досягаемости — ${reactor} может ответить ${reply}.`
        : trigger === 'spell-cast'
          ? `${source} начинает колдовать — ${reactor} может ответить ${reply}.`
          : `Момент для реакции: ${reactor} может ответить ${reply}.`)
    } else if (event.event_type === 'ReactionWindowClosed') {
      meaningful.push(payload.accepted === true
        ? `${actor} отвечает ${reactionInstrumentalText(payload)}.`
        : payload.accepted === false
          ? book.pick('reaction-declined', [`${actor} не отвечает — реакция остаётся в запасе.`, `${actor} пропускает момент: реакция не использована.`], event)
          : `${actor} пропускает момент для реакции.`)
    } else if (event.event_type === 'SwingResolved') {
      // Раскачка — составной манёвр: проверка уже зафиксирована соседним
      // событием, а это событие сообщает её безопасный для игрока итог. Не
      // повторяем d20, модификатор или СЛ; интерфейс показывает их отдельно.
      meaningful.push(payload.success === true
        ? `${actor} удерживается за люстру и продолжает манёвр.`
        : `${actor} срывается при попытке ухватиться за люстру и падает ничком у опоры; удар не происходит.`)
    } else if (event.event_type === 'ActorMoved' && payload.forced_movement === true && targetId && String(targetId) !== String(event.actor_id ?? '')) {
      // Вынужденное перемещение двигает цель, а не того, кто толкнул или
      // наложил заклинание: раньше хроника писала «Боец перемещается на 5 фт».
      const feet = Math.max(0, Number(payload.distance) || 0)
      meaningful.push(payload.pulled ? `${target} рывком оказывается на ${feet} фт ближе.` : `${target} отлетает на ${feet} фт.`)
    } else if (event.event_type === 'ActorMoved') {
      const tactic = tacticalActorIsEnemy(state, event.actor_id) ? tactics.get(String(event.actor_id ?? '')) : undefined
      meaningful.push(movePhrase(book, { actor, feet: Math.max(0, Number(payload.distance) || 0), tactic, mode: payload.movement_mode }, event))
    } else if (event.event_type === 'MapLevelChanged') {
      // Шаблон, а не вызов модели: смена этажа — уже решённая механика, и
      // Директор увидит её в следующем брифе. Строка идёт тем же путём в
      // журнал, что и остальные системные строки тактического хода.
      const label = String(payload.level_label ?? '').trim() || `этаж ${Number(payload.to_level) || 0}`
      meaningful.push(Number(payload.to_level) > Number(payload.from_level)
        ? `Партия поднимается по лестнице — ${label}.`
        : `Партия спускается по лестнице — ${label}.`)
    } else if (event.event_type === 'DoorLockpicked') {
      // Взломанная дверь называется взломанной, а не выломанной: полотно цело,
      // сорван замок. Летопись стола обязана различать эти два исхода — за
      // ними по-разному судит мир (`break_in` против `destruction`,
      // `server/world-deeds.mjs`).
      meaningful.push(payload.success === true
        ? `${actor} вскрывает замок отмычкой: дверь взломана и открыта.`
        : `${actor} возится с замком двери, но тот не поддаётся.`)
    } else if (event.event_type === 'AttackResolved') {
      // Особый приём объявляется отдельной строкой: иначе он тонет в обычном
      // «атакует — попадание», и стол не замечает, что существо потратило то,
      // чего у него больше нет до следующего броска.
      if (payload.recharge_action === true) meaningful.push(`${actor} пускает в ход «${String(payload.action_name || payload.action_id || 'особый приём')}».`)
      const reason = attackConditionReason(payload)
        + (payload.high_ground === 'higher' ? ' с возвышенности' : payload.high_ground === 'lower' ? ' снизу вверх' : '')
        + (payload.cover ? ` сквозь ${[
          ...(payload.cover_blockers ?? []).map((id) => tacticalActorName(state, id)),
          ...(payload.cover_scenery ?? []).map((feature) => COVER_SCENERY_LABELS[feature] ?? feature),
        ].join(', ') || 'помеху'} (${payload.cover === 'three-quarters' ? 'три четверти укрытия' : 'половинное укрытие'}, +${Number(payload.cover_bonus) || 2} к КД)` : '')
      // «Щит», поднятый реакцией на этот удар, в `armor_class` ещё не входит:
      // движок сравнил бросок с прежним КД и снял попадание. Без поправки
      // строка читалась как «13 против КД 12 — промах».
      const total = Number(payload.total) || 0
      const baseArmorClass = Number(payload.armor_class) || 0
      const shownArmorClass = payload.shielded_by_reaction === true && !payload.hit && total >= baseArmorClass ? baseArmorClass + 5 : baseArmorClass
      const shieldNote = payload.shielded_by_reaction === true ? ' с «Щитом»' : ''
      // Урон этого удара ложится в ту же строку: «бьёт Волка — попадание,
      // 7 урона». Две строки на один удар и были журналом.
      const damageIndex = payload.hit ? mergeableDamageIndex(list, index, consumed) : -1
      const damagePayload = damageIndex >= 0 ? list[damageIndex].payload ?? {} : null
      if (damageIndex >= 0) consumed.add(damageIndex)
      const damage = damagePayload
        ? targetIsEnemy
          ? `, ${Number(damagePayload.applied_amount)} урона`
          : `, ${Number(damagePayload.applied_amount)} урона; ОЗ ${Number(damagePayload.hp_before) || 0} → ${Number(damagePayload.hp_after) || 0}`
        : ''
      const actorId = String(event.actor_id ?? '')
      // Вступление по тактике — изредка, а не в каждом ходе: «Почуяв слабину»
      // в каждой строке читалось шаблоном (замер 2026-10-10). Выбор — хешем
      // события: повтор и replay дают ту же строку.
      const tacticText = tacticalActorIsEnemy(state, actorId) && !tacticLeadUsed.has(actorId) ? tacticLead(tactics.get(actorId)) : ''
      const lead = tacticText ? book.pick('tactic-lead', [tacticText, '', ''], event) : ''
      if (tacticalActorIsEnemy(state, actorId)) tacticLeadUsed.add(actorId)
      meaningful.push(attackPhrase(book, {
        actor,
        target,
        targetIsEnemy,
        payload,
        reason,
        numbers: targetIsEnemy ? '' : `${total} против КД ${shownArmorClass}${shieldNote}`,
        damage,
        opportunity: opportunityAttacks.has(index),
        lead,
      }, event))
      // Качественно, без списков: за столом видно, что удар «не пошёл», а не то,
      // от чего именно существо защищено.
      if (damagePayload?.resistant === true) meaningful.push('Удар словно вязнет — цель сопротивляется такому урону.')
      else if (damagePayload?.vulnerable === true) meaningful.push('Удар приходится по уязвимому месту — рана вдвое тяжелее.')
    } else if (event.event_type === 'NpcItemUsed') {
      // Подпись приходит готовой из закрытой таблицы тактик
      // (`NPC_ITEM_TACTICS`, `server/npc-equipment.mjs`) и намеренно
      // неточная: за столом видно, что гоблин приложился к склянке, а не то,
      // что это было зелье лечения на 2к4 + 2.
      meaningful.push(`${actor} ${String(payload.label || 'пускает в ход своё снаряжение')}.`)
    } else if (event.event_type === 'NpcEquipmentSpent' && payload.reason === 'ammunition' && Number(payload.shots_after) === 0) {
      // Единственное, что стол узнаёт о чужом колчане, — что он опустел, и
      // узнаёт по той же причине, по которой видит промах: это случилось на
      // глазах. Остаток выстрелов не называется никогда.
      meaningful.push(`${actor} тянется за следующим снарядом и находит колчан пустым.`)
    } else if (event.event_type === 'ItemEffectIneffective') {
      const victim = confidentAccusative(target)
      meaningful.push(victim
        ? `${payload.item_name || 'Склянка'} разбивается о ${victim}, но вреда не причиняет.`
        : `${payload.item_name || 'Склянка'} разбивается, но вреда не причиняет (цель — ${target}).`)
    } else if (event.event_type === 'LegendaryActionUsed') {
      // Имя действия приходит из стат-блока и называет поступок, а не цену:
      // «Удар хвостом» стол видит своими глазами, а сколько единиц запаса он
      // стоил — это бухгалтерия, и она уезжает пипсами на карточке, где её
      // читают взглядом, а не считают в уме по тексту.
      meaningful.push(`Вне очереди: ${actor} — «${String(payload.name || 'легендарное действие')}».`)
    } else if (event.event_type === 'LegendaryResistanceUsed') {
      // Самый заметный момент боя с боссом: удавшееся заклинание вдруг не
      // сработало. Промолчать здесь значило бы оставить стол в недоумении —
      // бросок прошёл, а эффекта нет. Причина называется качественно.
      meaningful.push(payload.reason === 'lethal'
        ? `Такой удар валит любого — но ${target} остаётся на ногах: сила, что держит это существо, тратится, но не иссякла.`
        : `${target} стряхивает с себя чары, даже не дрогнув.`)
    } else if (event.event_type === 'LegendaryActionsReset') {
      meaningful.push(`${target} собирается с силами: удары вне очереди снова в запасе.`)
    } else if (event.event_type === 'MonsterAbilityRecharged') {
      // Качественно и без чисел: порог recharge — часть стат-блока, и за столом
      // его не объявляют. Игрок узнаёт ровно то, что видит: приём снова готов.
      meaningful.push(`${target}: «${String(payload.name || payload.action_id || 'особый приём')}» снова наготове.`)
    } else if (event.event_type === 'AreaAttackResolved') {
      meaningful.push(`${actor} бросает ${payload.item_name || 'снаряд'} в область радиусом ${Number(payload.radius_feet) || 0} фт.`)
    } else if (event.event_type === 'CombatActionUsed' && payload.reaction_preference === 'never') {
      // Отказ по режиму «никогда» хроника не пишет.
    } else if (event.event_type === 'CombatActionUsed' && (payload.action_type === 'reaction' || payload.reaction_window_id)) {
      meaningful.push(payload.reaction_preference === 'auto'
        ? `${actor} сразу использует ${reactionActionText(payload)}.`
        : book.pick('reaction-used', [`${actor} использует ${reactionActionText(payload)}.`, `${actor} отвечает ${reactionInstrumentalText(payload)}.`], event))
    } else if (event.event_type === 'CombatActionUsed' && payload.monster_action === true) {
      meaningful.push(`${actor} использует приём «${String(payload.name || 'особая атака')}».`)
    } else if (event.event_type === 'CombatActionUsed' && payload.action_id === 'break-free' && typeof payload.success === 'boolean') {
      // Исход проверки — то, ради чего тратилось действие: без него стол читал
      // «использует «Высвободиться»» и не знал, держат ли путы (плейтест 2026-10-07).
      meaningful.push(payload.success
        ? `${actor} вырывается: путы больше не держат.`
        : `${actor} рвётся из пут, но они держат.`)
    } else if (event.event_type === 'CombatActionUsed') {
      const label = String(payload.name ?? '').trim()
      if (label && /[А-ЯЁа-яё]/u.test(label)) meaningful.push(actionPhrase(book, { actor, actionId: payload.action_id, name: label }, event))
    } else if (['SavingThrowResolved', 'NpcSavingThrowResolved', 'SpellSavingThrowResolved'].includes(event.event_type)) {
      const source = event.event_type === 'SpellSavingThrowResolved' || event.event_type === 'NpcSavingThrowResolved'
        ? spellSourceText(publicSpellLabel(payload))
        : ''
      meaningful.push(savePhrase(book, { target, saved: typeof payload.saved === 'boolean' ? payload.saved : null, source }, event))
    } else if (event.event_type === 'SpellCast' && !isAdditionalBeamSpellCast(event)) {
      const spell = `«${payload.name || payload.spell_id || 'магия'}»`
      meaningful.push(book.pick('spell-cast', [
        `${actor} творит заклинание ${spell}.`,
        `${actor} произносит слова заклинания ${spell}.`,
        `${actor} сплетает чары — ${spell}.`,
      ], event))
    } else if (event.event_type === 'SummonedCreatureCreated') {
      meaningful.push(`${actor} призывает ${payload.summon?.name || 'помощника'}; его ход поставлен сразу после хозяина.`)
    } else if (event.event_type === 'SummonedCreatureDismissed') {
      meaningful.push(`${target} исчезает с поля боя.`)
    } else if (event.event_type === 'EquipmentChanged') {
      meaningful.push(`${actor} экипирует ${payload.item_name || 'оружие'}${payload.turns_spent ? ', затрачивая действие' : ' перед атакой'}.`)
    } else if (event.event_type === 'DamageApplied' && payload.immune === true && Number(payload.raw_amount) > 0 && payload.scenario_ward_text) {
      // Проклятый рыцарь до возвращения головы: удар проходит сквозь пустоту,
      // и он смеётся с подсказкой (`server/scenario-knight.mjs`).
      meaningful.push(String(payload.scenario_ward_text))
    } else if (event.event_type === 'DamageApplied' && payload.immune === true && Number(payload.raw_amount) > 0) {
      meaningful.push(`${damageTypeLabel(payload.damage_type)} не действует на ${target}.`)
    } else if (event.event_type === 'ConditionImmunityResolved') {
      meaningful.push(`${target} не поддаётся: состояние не пристаёт к такому существу.`)
    } else if (event.event_type === 'DamageApplied' && Number(payload.applied_amount) > 0) {
      const amount = Number(payload.applied_amount)
      meaningful.push(targetIsEnemy
        ? payload.death_ward_triggered
          ? `${target} получает ${amount} урона, но Охрана от смерти удерживает цель на ногах.`
          : damagePhrase({ target, amount })
        : payload.death_ward_triggered
          ? `${target} получает ${amount} урона, но Охрана от смерти срабатывает и оставляет 1 ОЗ.`
          : payload.resistance_cantrip_reduction
            ? `Сопротивление уменьшает урон: ${target} получает на ${Number(payload.resistance_cantrip_reduction)} меньше; ОЗ ${Number(payload.hp_before) || 0} → ${Number(payload.hp_after) || 0}.`
            : damagePhrase({ target, amount, hp: `; ОЗ ${Number(payload.hp_before) || 0} → ${Number(payload.hp_after) || 0}` }))
      // Качественно, без списков: за столом видно, что удар «не пошёл», а не то,
      // от чего именно существо защищено.
      if (payload.resistant === true) meaningful.push('Удар словно вязнет — цель сопротивляется такому урону.')
      else if (payload.vulnerable === true) meaningful.push('Удар приходится по уязвимому месту — рана вдвое тяжелее.')
    } else if (event.event_type === 'CreatureKnockedOut') {
      meaningful.push(targetIsEnemy
        ? book.pick('knockout-enemy', [`${target} без чувств — сопротивления больше нет.`, `Оглушающий удар: ${target} без сознания и больше не сопротивляется.`], event)
        : `${target} теряет сознание от оглушающего удара, но остаётся с 1 ОЗ и начинает короткий отдых.`)
    } else if (event.event_type === 'KnockoutEnded') {
      meaningful.push(`${target} приходит в сознание после успешной первой помощи.`)
    } else if (event.event_type === 'RestCompleted' && payload.reason === 'knockout') {
      meaningful.push(`${target} приходит в сознание после завершения короткого отдыха.`)
    } else if (event.event_type === 'RestStarted' && !payload.source_prop_id
      && !completedRestActors.has(String(event.actor_id ?? ''))) {
      meaningful.push(`${actor} начинает ${payload.kind === 'long' ? 'продолжительный' : 'короткий'} отдых.`)
    } else if (event.event_type === 'RestCompleted' && !payload.source_prop_id) {
      if (!(payload.kind === 'long' && postVictoryRestActors.has(String(event.actor_id ?? '')))) {
        meaningful.push(`${actor} завершает ${payload.kind === 'long' ? 'продолжительный' : 'короткий'} отдых.`)
      }
    } else if (event.event_type === 'HitPointsReducedToZero') {
      // Спасброски от смерти бросают только герои. Чудовище на нуле выбывает:
      // плейтест 2026-10-10 — огр «начинал делать спасброски от смерти».
      const side = tacticalActorIsHero(state, targetId) ? 'hero' : targetIsEnemy ? 'enemy' : 'other'
      meaningful.push(downedPhrase(book, { target, side }, event))
    } else if (event.event_type === 'DeathSavingThrowRolled') {
      const outcome = payload.result === 'revived' ? 'натуральная 20 возвращает 1 ОЗ'
        : payload.result === 'stabilized' ? 'кровь остановлена, жизнь вне опасности'
          : payload.result === 'died' ? 'третий провал'
            : payload.success ? 'успех' : 'провал'
      const natural = Number(payload.natural_roll) || 0
      const modifier = Number(payload.modifier) || 0
      const total = Number(payload.total) || natural + modifier
      const rollText = modifier === 0 ? `${natural}` : `${natural} ${modifier > 0 ? '+' : '−'} ${Math.abs(modifier)} = ${total}`
      const auraText = payload.aura_of_protection_bonus ? ` Аура защиты даёт +${Number(payload.aura_of_protection_bonus)}.` : ''
      meaningful.push(`${book.pick('death-save', [
        `${target} делает спасбросок от смерти`,
        `${target} борется за жизнь — спасбросок от смерти`,
        `${target} на грани — спасбросок от смерти`,
      ], event)}: ${rollText} — ${outcome}.${auraText}`)
    } else if (event.event_type === 'ConcentrationSavingThrowResolved') {
      const natural = Number(payload.kept) || 0
      const modifier = Number(payload.modifier) || 0
      const total = Number(payload.total) || natural + modifier
      // Концентрацию проверяет тот, кого ударили, и модификатор здесь — его
      // собственный. У врага это часть stat block, которую продуктовые принципы
      // держат закрытой: игрок видит исход, а не из чего он сложился.
      const rollText = modifier === 0 ? `${natural}` : `${natural} ${modifier > 0 ? '+' : '−'} ${Math.abs(modifier)} = ${total}`
      const auraText = payload.aura_of_protection_bonus ? ` Аура защиты даёт +${Number(payload.aura_of_protection_bonus)}.` : ''
      meaningful.push(targetIsEnemy
        ? `${target} пытается удержать концентрацию — ${payload.saved ? 'успех' : 'провал'}.`
        : `${target} проверяет концентрацию: ${rollText} против СЛ ${Number(payload.difficulty) || 10} — ${payload.saved ? 'успех' : 'провал'}.${auraText}`)
    } else if (event.event_type === 'ConcentrationEnded') {
      const reason = String(payload.reason ?? '')
      meaningful.push(`${target} теряет концентрацию (${concentrationEndReasonLabel(reason)}).`)
    } else if (event.event_type === 'ActionReadied') {
      meaningful.push(`${target} замирает с оружием наготове и ждёт, когда ${String(payload.trigger_label ?? 'сработает выбранный триггер')}.`)
    } else if (event.event_type === 'ReadiedActionExpired') {
      // Про использованную заготовку расскажет сам удар, а вот сгоревшую иначе
      // никто не заметит: игрок просто не поймёт, куда делось действие.
      if (payload.reason === 'concentration-lost') meaningful.push(`${target} теряет сосредоточенность: заготовленное заклинание рассеивается.`)
      else if (payload.reason !== 'used') meaningful.push(payload.spell_id
        ? `${target}: повода так и не случилось — заготовленное заклинание рассеивается.`
        : `${target}: повода так и не случилось — заготовленный удар пропадает.`)
    } else if (event.event_type === 'DeathSaveFailureRecorded') {
      const failures = Number(payload.failure_increment) === 2 ? 'два провала' : 'провал'
      meaningful.push(book.pick('death-save-damage', [
        `${target} получает ${failures} спасброска от смерти из-за урона.`,
        `Новая рана: ${target} получает ${failures} спасброска от смерти.`,
      ], event))
    } else if (event.event_type === 'HeroStabilized') {
      meaningful.push(stabilizedPhrase(book, target, event))
    } else if (event.event_type === 'StableRecoveryScheduled') {
      meaningful.push(`${target} придёт в себя с 1 ОЗ через ${hoursLabelRu(Math.max(1, Number(payload.recovery_hours) || 1))}.`)
    } else if (event.event_type === 'HealingApplied' && payload.reason === 'stable-recovery-after-1d4-hours') {
      meaningful.push(`${target} приходит в сознание с 1 ОЗ после необходимого времени покоя.`)
    } else if (event.event_type === 'HealingApplied' && payload.spell_id === 'aura-of-life') {
      meaningful.push(`Аура жизни возвращает ${target} 1 ОЗ в начале хода.`)
    } else if (event.event_type === 'HealingApplied' && Number(payload.applied_amount) > 0) {
      // Лечение молчало: хроника писала «творит заклинание «Лечащее слово»», и
      // сколько вернулось, игрок искал в листе. Свои ОЗ отряд видит числом,
      // чужие — качественно, как и урон.
      meaningful.push(targetIsEnemy
        ? `${target} восстанавливает силы.`
        : `${target} восстанавливает ${Number(payload.applied_amount)} ОЗ; ОЗ ${Number(payload.hp_before) || 0} → ${Number(payload.hp_after) || 0}.`)
    } else if (event.event_type === 'HitPointMaximumReductionPrevented') {
      meaningful.push(`${target}: аура жизни не даёт уменьшить максимум ОЗ.`)
    } else if (event.event_type === 'HitPointMaximumReduced') {
      meaningful.push(targetIsEnemy ? `${target} слабеет: жизненные силы подточены.` : `Максимум ОЗ ${target} снижается: ${Number(payload.maximum_hp_before) || 0} → ${Number(payload.maximum_hp_after) || 0}.`)
    } else if (event.event_type === 'HitPointMaximumIncreased') {
      // Зеркало снижения — и та же граница видимости: свой предел отряд знает
      // числом, чужой виден только качественно. Событие приносит и текущие ОЗ,
      // но про них рассказывать нечего: «Подмога» поднимает их ровно на ту же
      // прибавку, и второе число повторило бы первое.
      meaningful.push(targetIsEnemy
        ? `${target} держится крепче прежнего.`
        : `Максимум ОЗ ${target} поднимается: ${Number(payload.maximum_hp_before) || 0} → ${Number(payload.maximum_hp_after) || 0}.`)
    } else if (event.event_type === 'HeroDied') {
      meaningful.push(partyFailed
        ? `${target} погибает. Последний герой отряда пал, и история завершилась поражением.`
        : `${target} погибает. Судьбу героя нужно разрешить: воскресить или заменить новым.`)
    } else if (event.event_type === 'HeroResurrected') {
      meaningful.push(`${target} возвращается к жизни с 1 ОЗ.`)
    } else if (event.event_type === 'HeroReplaced') {
      meaningful.push(`${payload.replacement_name || target} присоединяется к группе вместо погибшего героя.`)
    } else if (event.event_type === 'ConditionAdded' && payload.action_id && MONSTER_HIT_CONDITION_TERMS[payload.condition]) {
      // Удар чудовища с последствием: паутина опутывает, укус валит с ног. Без
      // строки стол видел «атакует — попадание» без урона и не понимал, что
      // герой уже не может двигаться (плейтест 2026-10-07).
      meaningful.push(`${target} — состояние «${MONSTER_HIT_CONDITION_TERMS[payload.condition]}».`)
    } else if (event.event_type === 'ConditionAdded' && payload.condition === 'fled') {
      meaningful.push(`${target} отступает и покидает бой.`)
    } else if (event.event_type === 'ConditionAdded' && payload.condition === 'surrendered') {
      meaningful.push(`${target} прекращает сопротивление и сдаётся.`)
    } else if (event.event_type === 'ParleyProposed') {
      // Про отказ и про насмешку расскажет `ParleyRejected`: здесь только сам
      // окрик, иначе одна попытка звучала бы дважды.
      meaningful.push(`${actor} перекрикивает лязг: «Стойте! Поговорим!»`)
    } else if (event.event_type === 'ParleyRejected') {
      meaningful.push(String(payload.taunt || 'Ответа нет — бой продолжается.'))
    } else if (event.event_type === 'TruceEstablished') {
      const truce = payload.truce ?? {}
      meaningful.push(`Оружие опускается: ${String(truce.leader_name || 'предводитель уцелевших')} готов говорить. Перемирие держится, пока его никто не нарушил.`)
    } else if (event.event_type === 'TruceBroken') {
      meaningful.push(payload.broken_by === 'enemies'
        ? 'Противник бьёт под перемирием — уговор разорван, бой возобновляется.'
        : `${actor} бьёт под перемирием. Слово нарушено, и это видели.`)
    } else if (event.event_type === 'ParleySettled') {
      meaningful.push(payload.outcome === 'resume'
        ? 'Переговоры кончились ничем: стороны расходятся по местам, и бой продолжается.'
        : `Уговор заключён: ${String(payload.term_summary || payload.term_label || 'условия приняты')}${Number(payload.tribute_cp) > 0 ? ` Отряду остаётся ${Math.max(0, Number(payload.tribute_cp) || 0)} мм.` : ''}`)
    } else if (event.event_type === 'TavernDiceRoundOpened') {
      // Про ставку сказано в прошедшем времени не для красоты: она уже ушла из
      // кошелька на стол, и обратно её приносит только расчёт.
      meaningful.push(`${String(payload.npc_name || 'Сосед по столу')} мечет кости: выпало ${Number(payload.npc_total) || 0}. ${Math.max(0, Number(payload.stake_cp) || 0)} мм легли на стол — ${actor} свою ставку сделал(а).`)
    } else if (event.event_type === 'TavernDiceRoundResolved') {
      const hero = Number(payload.hero_total) || 0
      const opponent = Number(payload.npc_total) || 0
      const stake = Math.max(0, Number(payload.stake_cp) || 0)
      // Про скандал и разоблачение говорят свои события: здесь только сам
      // раунд, иначе один бросок звучал бы дважды.
      if (payload.outcome === 'win') meaningful.push(`${actor} выбрасывает ${hero} против ${opponent} — банк в ${stake * 2} мм уходит герою.`)
      else if (payload.outcome === 'loss') meaningful.push(`${actor} выбрасывает ${hero} против ${opponent}: ставка в ${stake} мм остаётся на столе.`)
      else if (payload.outcome === 'push') meaningful.push(`Ровно ${hero} у обоих — ставки возвращаются владельцам.`)
      else if (payload.outcome === 'caught') meaningful.push(`${actor} тянется к костям — и руку перехватывают. Ставка потеряна.`)
      else meaningful.push(`${actor} не сводит глаз с чужих рук и раунд не доигрывает.`)
      if (payload.watch_result === 'clean') meaningful.push('Ничего подозрительного: играют честно.')
    } else if (event.event_type === 'TavernDiceRoundCancelled') {
      // У живого движка повод здесь один — сдача. Встал ли герой из-за стола сам
      // или вышел из зала дверью, цена одна: ставка со стола достаётся соседу
      // ровно как при проигрыше, и возврата у неё нет ни одного.
      //
      // Но журналы, написанные до закрепления покрытия, знали два тупика
      // (`opponent-broke`, `patron-ejected`), и выставленному за дверь ставка
      // возвращалась. Редьюсер такие записи честно повторяет — `currency_after`
      // лежит в их payload, — и рассказ обязан идти следом: свернув возврат в
      // «ставку забрал сосед», хроника пересказала бы старую партию неправдой.
      // Ветка ведётся числом самой записи, а не списком поводов: поводы в старых
      // журналах закрыты, а число описывает деньги само.
      const returnedCp = Math.max(0, Number(payload.returned_cp) || 0)
      if (returnedCp > 0) {
        meaningful.push(payload.reason === 'patron-ejected'
          ? `${actor} выставлен(а) за дверь, не ответив на кость: раунд закрыт, и ${returnedCp} мм ставки возвращаются в кошелёк.`
          : `Раунд ${actor} закрылся, не дойдя до ответа: ${returnedCp} мм ставки возвращаются в кошелёк.`)
      } else {
        meaningful.push(`${actor} отодвигает скамью и встаёт, не ответив на кость. ${Math.max(0, Number(payload.forfeited_cp) || 0)} мм со стола забирает ${String(payload.npc_name || 'сосед')}.`)
      }
    } else if (event.event_type === 'TavernCheatCaught') {
      meaningful.push(`Скандал за столом: ${String(payload.npc_name || 'сосед')} во весь голос объявляет героя шулером. Это видели.`)
    } else if (event.event_type === 'TavernCheatExposed') {
      meaningful.push(`${String(payload.npc_name || 'Сосед по столу')} играет краплёными: подмену заметили, и уговор кончен.`)
    } else if (event.event_type === 'TavernPatronEjected') {
      meaningful.push(`${actor} выставлен за дверь: за этим столом ему больше не наливают.`)
    } else if (event.event_type === 'TavernDrinkOrdered') {
      const drinks = Math.max(1, Number(payload.drinks) || 1)
      meaningful.push(Number(payload.social_bonus) > 0
        ? `${actor} берёт кружку (${drinks}-я за вечер) — язык развязывается, разговор идёт легче.`
        : `${actor} берёт ещё одну кружку. Это уже ${drinks}-я.`)
    } else if (event.event_type === 'ShrinePrayerResolved') {
      // Три исхода, и ни один из них ничего не отнимает. Знамение говорит само
      // за себя строкой из закрытой серверной таблицы: додумывать его на ходу
      // нельзя — при replay та же неудача рассказалась бы иначе.
      if (payload.outcome === 'blessed') meaningful.push(`${actor} склоняет голову у святыни, и слова находят ответ: благословение принято.`)
      else if (payload.outcome === 'omen') meaningful.push(`${actor} молится, но ответа нет. ${String(payload.omen || 'Что-то в этом месте отзывается неправильно.')}`)
      else meaningful.push(`${actor} молится у святыни. Ответа нет — только тишина и камень.`)
    } else if (event.event_type === 'NpcBlessingGranted') {
      meaningful.push(`${String(payload.npc_name || 'Служитель')} принимает пожертвование в ${Math.max(0, Number(payload.donation_cp) || 0)} мм и кладёт ладонь на голову героя: благословение дано.`)
    } else if (event.event_type === 'ConditionAdded' && String(payload.source ?? '').startsWith('blessing:')) {
      meaningful.push(`${target} несёт малое благословение: первый же удар пойдёт вернее (+${Math.max(0, Number(payload.attack_bonus) || 0)}), и держится оно до продолжительного отдыха.`)
    } else if (event.event_type === 'ConditionRemoved' && payload.condition === BLESSING_CONDITION && payload.trigger === 'attack') {
      meaningful.push(`Благословение израсходовано этим ударом.`)
    } else if (event.event_type === 'ConditionAdded' && payload.source === 'tavern-drink') {
      meaningful.push(`${target} перебрал(а): всё плывёт, и до отдыха любая проверка идёт с помехой.`)
    } else if (event.event_type === 'CaptiveTaken') {
      const captive = payload.captive ?? {}
      meaningful.push(captive.origin === 'knocked_out'
        ? `${String(captive.name || 'Побеждённый')} связан(а) без сознания и остаётся пленником отряда.`
        : `${String(captive.name || 'Сдавшийся')} сдаётся на милость и остаётся пленником отряда.`)
    } else if (event.event_type === 'CaptiveInterrogated') {
      // Что именно сказал пленный, знает только тот, кто вёл допрос: сам факт
      // приезжает отдельным `KnowledgeRevealed` с видимостью того же игрока.
      meaningful.push(payload.success === true
        ? `${actor} разговорил(а) пленного — тот выдаёт то, что знает.`
        : `${actor} давит на пленного, но тот молчит.`)
    } else if (event.event_type === 'CaptiveFed') {
      meaningful.push('Пленного накормили и напоили.')
    } else if (event.event_type === 'CaptiveNeglected') {
      meaningful.push(`${String(payload.captive_name || 'Пленник')} вторые сутки без еды и держится из последних сил.`)
    } else if (event.event_type === 'CaptiveReleased') {
      meaningful.push(`${actor} разрезает верёвки: пленный уходит живым.`)
    } else if (event.event_type === 'CaptiveHandedOver') {
      meaningful.push(`Пленный передан страже «${String(payload.settlement_name || 'поселения')}»; за него уплачено ${Math.max(0, Number(payload.bounty_cp) || 0)} мм.`)
    } else if (event.event_type === 'CaptiveExecuted') {
      meaningful.push(`${actor} добивает связанного. Этого уже не отменить.`)
    } else if (event.event_type === 'CaptiveMoved') {
      meaningful.push('Пленного уводят с собой.')
    } else if (event.event_type === 'BeastEncountered') {
      meaningful.push(`${String(payload.beast?.name || 'Зверь')} не бросается: ${actor} опускает оружие и делает шаг навстречу.`)
    } else if (event.event_type === 'BeastSoothingResolved') {
      meaningful.push(payload.success === true
        ? (payload.stage_after === 'tamed'
          ? `${String(payload.beast_name || 'Зверь')} подходит сам и больше не смотрит на отряд как на добычу.`
          : `${String(payload.beast_name || 'Зверь')} перестаёт скалиться: ${actor} говорит с ним, и это работает.`)
        : `${String(payload.beast_name || 'Зверь')} пятится и не подпускает: уговор не вышел.`)
    } else if (event.event_type === 'BeastBit') {
      meaningful.push(`${String(payload.beast_name || 'Зверь')} бросается и кусает: ${Math.max(0, Number(payload.amount) || 0)} урона.`)
    } else if (event.event_type === 'BeastFed') {
      meaningful.push(`${actor} протягивает ${String(payload.item_name || 'паёк')} — и ${String(payload.beast_name || 'зверь')} берёт еду с руки.`)
    } else if (event.event_type === 'BeastTamed') {
      // Прямо в строке сказано, чего спутник не делает: за столом это снимает
      // единственный вопрос, который иначе задают в первом же бою.
      meaningful.push(`${String(payload.beast_name || 'Зверь')} идёт с отрядом. В строй он не встанет, но и один больше не останется.`)
    } else if (event.event_type === 'BeastMoved') {
      meaningful.push(`${String(payload.beast_name || 'Зверь')} трусит следом за отрядом.`)
    } else if (event.event_type === 'BeastScaredThreat') {
      meaningful.push(String(payload.line || `${String(payload.beast_name || 'Зверь')} отгоняет мелкую тварь.`))
    } else if (event.event_type === 'CombatEnded') {
      if (!encounterEnded) {
        meaningful.push(book.pick('combat-end', [
          `Бой завершён в раунде ${Number(payload.round) || 1}.`,
          `Схватка окончена — раунд ${Number(payload.round) || 1}.`,
        ], event))
      }
    } else if (event.event_type === 'TurnEnded' && payload.auto_skip_reason === 'turn-timeout') {
      // Пропуск по часам — событие для стола, а не служебная строка: игрок
      // должен понять, почему за него ничего не сделано.
      meaningful.push(`${actor}: время хода вышло, ход пропущен.`)
    } else if (event.event_type === 'TurnEnded') {
      if (!defeatedEnemy(state, event.actor_id)) turns.push(turnEndPhrase(book, actor, event))
    } else if (event.event_type === 'TurnStarted') {
      if (!defeatedEnemy(state, targetId)) turns.push(turnStartPhrase(book, target, Number(payload.round) || 1, event))
    }
  })
  // Небо дописывается последним и в порядке приоритета не участвует: сначала
  // отряд, потом мир вокруг него. На ходу, где кроме смены времени суток не
  // случилось ничего (долгий отдых, переход по карте), строка про небо остаётся
  // единственной — и это ровно та строка, которой смену видно в летописи.
  return { main: meaningful.length ? meaningful : turns, sky }
}

function tacticalNarration(events, state, options = {}) {
  const { main, sky } = tacticalNarrationParts(events, state, options)
  return [main, sky].filter(Boolean).join(' ')
}

/** Типы событий, про которые этот рассказчик умеет говорить. */
export const COMBAT_NARRATION_EVENT_TYPES = Object.freeze(new Set([
  'ActionReadied', 'ActorMoved', 'AreaAttackResolved', 'AttackResolved', 'SwingResolved',
  'BeastBit', 'BeastEncountered', 'BeastFed', 'BeastMoved',
  'BeastScaredThreat', 'BeastSoothingResolved', 'BeastTamed',
  'CaptiveExecuted', 'CaptiveFed', 'CaptiveHandedOver', 'CaptiveInterrogated',
  'CaptiveMoved', 'CaptiveNeglected', 'CaptiveReleased', 'CaptiveTaken',
  'CombatEnded', 'CombatStarted', 'ConcentrationEnded', 'ConcentrationSavingThrowResolved',
  'ConditionAdded', 'ConditionImmunityResolved', 'CreatureKnockedOut', 'DamageApplied', 'DeathSaveFailureRecorded',
  'DeathSavingThrowRolled', 'DowntimeResolved', 'EncounterCreated', 'EncounterEnded', 'EncounterRewardsDistributed', 'EquipmentChanged',
  'HealingApplied', 'HeroDied', 'HeroReplaced', 'HeroResurrected',
  'HeroStabilized', 'HitPointMaximumIncreased', 'HitPointMaximumReduced', 'HitPointMaximumReductionPrevented', 'HitPointsReducedToZero',
  'ItemEffectIneffective', 'LegendaryActionUsed', 'LegendaryActionsReset', 'LegendaryResistanceUsed',
  'MonsterAbilityRecharged', 'NpcBlessingGranted',
  'NpcEquipmentSpent', 'NpcItemUsed',
  'CombatActionUsed', 'NpcSavingThrowResolved', 'ReactionWindowClosed', 'ReactionWindowOpened', 'SavingThrowResolved', 'SpellSavingThrowResolved',
  'DoorLockpicked', 'LockpickNoticed',
  'KnockoutEnded', 'MapLevelChanged', 'ParleyProposed', 'ParleyRejected', 'ParleySettled',
  'ReadiedActionExpired', 'RestCompleted', 'RestStarted', 'ShrinePrayerResolved', 'SpellCast',
  'SceneObjectCheckResolved', 'SceneObjectEffectApplied', 'SceneObjectInspected', 'SceneObjectLootRevealed',
  'SceneObjectKnowledgeRevealed', 'SceneObjectLootGranted', 'SceneObjectOperated',
  'SceneObjectStateChanged',
  'StableRecoveryScheduled', 'SummonedCreatureCreated', 'SummonedCreatureDismissed',
  'TavernCheatCaught', 'TavernCheatExposed',
  'TavernDiceRoundCancelled', 'TavernDiceRoundOpened', 'TavernDiceRoundResolved',
  'TavernDrinkOrdered', 'TavernPatronEjected',
  'TimeOfDayChanged', 'TruceBroken', 'TruceEstablished', 'TurnEnded',
  'TurnStarted', 'WeatherChanged',
]))

export function hasCombatNarrationEvent(events) {
  return (Array.isArray(events) ? events : []).some((event) => COMBAT_NARRATION_EVENT_TYPES.has(String(event?.event_type ?? '')))
}

export { tacticalNarration as combatNarration }

/**
 * Объявлен по общему контракту, но **намеренно не зарегистрирован** в реестре
 * `deterministic-narration.mjs`. Реестром пользуется `game-orchestrator`, а
 * боевой текст живёт в другом потоке — маршруты `server/index.mjs` зовут его
 * напрямую. Зарегистрировать его значило бы молча перехватить у оркестратора
 * ходы, которые сейчас уходят Рассказчику; такое решение принимает владелец, а
 * не разбор долга. Форма готова: включение — одна строка.
 */
export const combatNarrator = Object.freeze(assertNarratorContract({
  id: 'combat',
  priority: NARRATOR_PRIORITY.combat,
  // v2: варианты реплик по идентификатору события, урон в строке удара,
  // тактика существа, вступление столкновения (`server/combat-phrases.mjs`).
  promptVersion: 'combat-narrator/v2',
  provider: 'deterministic-combat',
  matches: hasCombatNarrationEvent,
  narrate: (events, state) => tacticalNarration(events, state) || null,
}))
