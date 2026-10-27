// @ts-check
/**
 * Авторские диалоги кампании — разговор с вариантами ответа, как в BG3.
 *
 * Зачем. Прогон «Асстоханских равнин» без модели (2026-10-12) показал, что
 * разговор — главный разрыв: король Арес на первый же вопрос о поручении
 * отвечал «Больше мне сказать нечего», и все реплики собеседников были
 * отписками. Принцип 8 (`docs/product-principles.md`): у каждого собеседника
 * авторской кампании — авторский диалог, кампания проходится без модели.
 *
 * Данные — `data/campaign-dialogues-v1.json`. Диалог привязан к собеседнику
 * сценария (`npc_id`) и к сценарию (`scenario_id`): в кампании без сценария
 * диалогов нет. Вариант — тема или реплика героя (`label`) и ответ
 * собеседника (`reply`); у варианта могут быть:
 *
 * - `requires` — условия показа: флаги разговора (`flags`, а `flags_none` —
 *   флаги, которых быть не должно), найденные тайны сценария (`clues_any`,
 *   `clues_all`);
 * - `group` — группа вариантов, из которой герой выбирает один: «каждый
 *   задаёт Древу один вопрос»;
 * - `check` — проверка навыка с СЛ; исход — `success`/`failure`, у каждого
 *   свой ответ. Попытка одна на героя: после неё вариант для него закрыт;
 * - `sets` — флаги, которые открывает вариант. Флаги общие для отряда и для
 *   всех разговоров кампании: понятое у одного собеседника открывает путь у
 *   другого («король что-то скрывает» → архивист показывает журнал);
 * - `reveal` — тайна сценария (id из карточки места), которую собеседник
 *   рассказывает; `reveal_topic` — тайна исходной ситуации мира по её теме
 *   (`opening.secrets` шаблона: у них нет стабильного id, есть тема). Тайна
 *   с наградой (`grants_catalog_id`, оберег Ломара) отдаёт и предмет — один
 *   раз: находка той же тайны поиском второго не выдаёт;
 * - `action` — сюжетная команда, которую вариант исполняет тем же путём, что
 *   и фраза («берём кошель короля»): `ReceiveScenarioPurse`,
 *   `ChooseScenarioArmoryItem` (раз на героя), `ReturnKnightHead` (голова
 *   перед рыцарем), `ReleaseCursedKnight` (упокоение),
 *   `ResolveScenarioInformant` (судьба осведомителя: `informant_id`,
 *   `choice`) и `NegotiateScenarioTreaty` (договор с драконом). Упокоение,
 *   перевербовка и договор бросают проверку сами: `check` варианта называет
 *   навык и СЛ для окна, а исход берётся из их броска. Вариант с командой
 *   показан, только пока команда его примет: голова — когда загадка разгадана
 *   и голова ещё не возвращена, упокоение — когда голова перед рыцарем и герой
 *   этой ночью ещё не пробовал, судьба осведомителя — пока она не решена,
 *   договор — когда правда о походе раскрыта и герой ещё не пробовал;
 * - `ends` — вариант закрывает окно разговора.
 *
 * Модуль — лист: читает состояние и данные, событий не создаёт. Команду и
 * события исполняет Rules Engine; прогресс разговора (флаги и попытки) —
 * в состоянии, его пишет редьюсер.
 */
import { readFileSync } from 'node:fs'

import { campaignScenario, scenarioClueFactId, scenarioFoundClueIds, scenarioInformantRules, scenarioLocationId, scenarioTreatyRules } from './campaign-scenario.mjs'
import { scenarioKnightRiddleSolved, scenarioKnightState, scenarioNightIndex } from './scenario-knight.mjs'

export const DIALOGUES_SCHEMA_VERSION = 1
/** Команда игрока: выбрать вариант разговора. */
export const DIALOGUE_COMMAND_TYPE = 'ChooseDialogueOption'
/** Событие выбранного варианта: ответ собеседника и прогресс разговора. */
export const DIALOGUE_EVENT = 'DialogueOptionChosen'
/** Провенанс: авторский диалог — политика проекта, а не правило редакции. */
export const DIALOGUE_POLICY_ID = 'skazanie:authored-dialogue-v1'
const DIALOGUES_URL = new URL('../data/campaign-dialogues-v1.json', import.meta.url)
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u
const DIALOGUE_SKILLS = new Set(['persuasion', 'deception', 'intimidation', 'insight', 'history', 'religion', 'arcana', 'performance', 'medicine'])
const DIALOGUE_ACTIONS = new Set(['ReceiveScenarioPurse', 'ChooseScenarioArmoryItem', 'ReturnKnightHead', 'ReleaseCursedKnight', 'ResolveScenarioInformant', 'NegotiateScenarioTreaty'])
const INFORMANT_CHOICES = new Set(['expose', 'release', 'turn'])

/**
 * Бросает ли команда проверку сама: тогда вариант задаёт навык, а исход — её
 * бросок. Упокоение рыцаря, договор и перевербовка осведомителя.
 * @param {{ command_type: string, choice?: string }} action
 */
export function dialogueActionChecks(action) {
  return action.command_type === 'ReleaseCursedKnight' || action.command_type === 'NegotiateScenarioTreaty'
    || (action.command_type === 'ResolveScenarioInformant' && action.choice === 'turn')
}

/** @param {unknown} value @param {number} [maximum] */
const clean = (value, maximum = 240) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)

/** @param {string} message @returns {never} */
function invalid(message) {
  throw new Error(`Диалоги кампании: ${message}`)
}

/**
 * @typedef {object} DialogueOutcome
 * @property {string} reply
 * @property {string[]} sets
 * @property {string} reveal тайна сценария по id
 * @property {string} reveal_topic тайна исходной ситуации по теме
 */

/**
 * @typedef {object} DialogueOption
 * @property {string} id
 * @property {string} label
 * @property {{ flags: string[], flags_none: string[], clues_any: string[], clues_all: string[] }} requires
 * @property {string} group
 * @property {{ skill: string, dc: number } | null} check
 * @property {DialogueOutcome} success исход без проверки — тоже здесь
 * @property {DialogueOutcome | null} failure
 * @property {{ command_type: string, catalog_id?: string, informant_id?: string, choice?: string } | null} action
 * @property {boolean} ends
 */

/**
 * @typedef {object} Dialogue
 * @property {string} id
 * @property {string} scenario_id
 * @property {string} npc_id
 * @property {string} greeting
 * @property {DialogueOption[]} options
 */

/** @param {unknown} value @param {string} where */
function ids(value, where) {
  if (value == null) return []
  if (!Array.isArray(value)) invalid(`${where}: ожидается список`)
  return value.map((entry) => {
    const id = clean(entry, 80)
    if (!ID_PATTERN.test(id)) invalid(`${where}: id «${id}»`)
    return id
  })
}

/** @param {any} raw @param {string} where @returns {DialogueOutcome} */
function outcome(raw, where) {
  const reply = clean(raw?.reply, 1_200)
  if (!reply) invalid(`${where}: нет ответа`)
  const reveal = raw?.reveal == null ? '' : clean(raw.reveal, 80)
  if (reveal && !ID_PATTERN.test(reveal)) invalid(`${where}: тайна «${reveal}»`)
  const revealTopic = raw?.reveal_topic == null ? '' : clean(raw.reveal_topic, 200)
  if (reveal && revealTopic) invalid(`${where}: одна тайна на исход — reveal или reveal_topic`)
  return { reply, sets: ids(raw?.sets, `${where}.sets`), reveal, reveal_topic: revealTopic }
}

/** @param {any} raw @param {string} where @returns {DialogueOption} */
function option(raw, where) {
  const id = clean(raw?.id, 80)
  if (!ID_PATTERN.test(id)) invalid(`${where}: id варианта «${id}»`)
  const label = clean(raw?.label, 200)
  if (!label) invalid(`${where}.${id}: нет реплики героя`)
  const requires = {
    flags: ids(raw?.requires?.flags, `${where}.${id}.requires.flags`),
    flags_none: ids(raw?.requires?.flags_none, `${where}.${id}.requires.flags_none`),
    clues_any: ids(raw?.requires?.clues_any, `${where}.${id}.requires.clues_any`),
    clues_all: ids(raw?.requires?.clues_all, `${where}.${id}.requires.clues_all`),
  }
  let check = null
  if (raw?.check != null) {
    const skill = clean(raw.check.skill, 40)
    const dc = Number(raw.check.dc)
    if (!DIALOGUE_SKILLS.has(skill)) invalid(`${where}.${id}: навык «${skill}»`)
    if (!Number.isInteger(dc) || dc < 5 || dc > 30) invalid(`${where}.${id}: СЛ ${raw.check.dc}`)
    check = { skill, dc }
  }
  if (check && (!raw?.success || !raw?.failure)) invalid(`${where}.${id}: у проверки нужны success и failure`)
  if (!check && (raw?.success || raw?.failure)) invalid(`${where}.${id}: success/failure — только у проверки`)
  const success = check ? outcome(raw.success, `${where}.${id}.success`) : outcome(raw, `${where}.${id}`)
  const failure = check ? outcome(raw.failure, `${where}.${id}.failure`) : null
  let action = null
  if (raw?.action != null) {
    const commandType = clean(raw.action.command_type, 60)
    if (!DIALOGUE_ACTIONS.has(commandType)) invalid(`${where}.${id}: команда «${commandType}»`)
    const catalogId = clean(raw.action.catalog_id, 120)
    if (commandType === 'ChooseScenarioArmoryItem' && !catalogId) invalid(`${where}.${id}: не указан предмет оружейной`)
    const informantId = commandType === 'ResolveScenarioInformant' ? clean(raw.action.informant_id, 80) : ''
    const choice = commandType === 'ResolveScenarioInformant' ? clean(raw.action.choice, 20) : ''
    if (commandType === 'ResolveScenarioInformant' && (!ID_PATTERN.test(informantId) || !INFORMANT_CHOICES.has(choice))) {
      invalid(`${where}.${id}: осведомитель «${informantId}» и решение «${choice}»`)
    }
    action = { command_type: commandType, ...(catalogId ? { catalog_id: catalogId } : {}), ...(informantId ? { informant_id: informantId, choice } : {}) }
    if (dialogueActionChecks(action) && !check) invalid(`${where}.${id}: команда «${commandType}» бросает проверку — нужен check с навыком`)
    if (!dialogueActionChecks(action) && check) invalid(`${where}.${id}: команда и проверка в одном варианте не поддержаны`)
  }
  const group = raw?.group == null ? '' : clean(raw.group, 80)
  if (group && !ID_PATTERN.test(group)) invalid(`${where}.${id}: группа «${group}»`)
  return { id, label, requires, group, check, success, failure, action, ends: raw?.ends === true }
}

/**
 * Проверяет и замораживает каталог диалогов. Ошибка данных — исключение при
 * загрузке: сломанный диалог не должен всплыть посреди вечера.
 *
 * @param {any} raw
 * @returns {Dialogue[]}
 */
export function normalizeDialogues(raw) {
  if (raw?.schema_version !== DIALOGUES_SCHEMA_VERSION) invalid(`schema_version ${raw?.schema_version}`)
  if (!Array.isArray(raw.dialogues)) invalid('нет списка dialogues')
  const seen = new Set()
  /** @type {Dialogue[]} */
  const dialogues = raw.dialogues.map((/** @type {any} */ entry, /** @type {number} */ index) => {
    const id = clean(entry?.id, 80)
    if (!ID_PATTERN.test(id) || seen.has(id)) invalid(`диалог ${index}: id «${id}»`)
    seen.add(id)
    const scenarioId = clean(entry?.scenario_id, 80)
    const npcId = clean(entry?.npc_id, 80)
    if (!ID_PATTERN.test(scenarioId) || !ID_PATTERN.test(npcId)) invalid(`${id}: scenario_id и npc_id обязательны`)
    const greeting = clean(entry?.greeting, 1_200)
    if (!greeting) invalid(`${id}: нет приветствия`)
    if (!Array.isArray(entry?.options) || !entry.options.length) invalid(`${id}: нет вариантов`)
    const options = entry.options.map((/** @type {any} */ raw) => option(raw, id))
    const optionIds = new Set()
    for (const item of options) {
      if (optionIds.has(item.id)) invalid(`${id}: вариант «${item.id}» повторяется`)
      optionIds.add(item.id)
    }
    return Object.freeze({ id, scenario_id: scenarioId, npc_id: npcId, greeting, options: Object.freeze(options) })
  })
  // Флаги общие для всех разговоров сценария: требуемый флаг должен ставить
  // хотя бы один вариант какого-нибудь диалога того же сценария.
  for (const dialogue of dialogues) {
    const setFlags = new Set(dialogues.filter((entry) => entry.scenario_id === dialogue.scenario_id)
      .flatMap((entry) => entry.options.flatMap((/** @type {DialogueOption} */ item) => [...item.success.sets, ...(item.failure?.sets ?? [])])))
    for (const item of dialogue.options) {
      for (const flag of [...item.requires.flags, ...item.requires.flags_none]) if (!setFlags.has(flag)) invalid(`${dialogue.id}.${item.id}: флаг «${flag}» никто не ставит`)
    }
  }
  return dialogues
}

/** @type {readonly Dialogue[]} */
export const DIALOGUES = Object.freeze(normalizeDialogues(JSON.parse(readFileSync(DIALOGUES_URL, 'utf8'))))

/**
 * Диалог собеседника в этой кампании или `null`: только у кампании со
 * сценарием, к которому он написан.
 *
 * @param {any} state
 * @param {unknown} npcId
 * @returns {Dialogue | null}
 */
export function dialogueFor(state, npcId) {
  const scenario = campaignScenario(state)
  const id = clean(npcId, 120)
  if (!scenario || !id) return null
  return DIALOGUES.find((entry) => entry.scenario_id === scenario.id && entry.npc_id === id) ?? null
}

/**
 * Прогресс разговора в состоянии: флаги отряда и попытки героев. Пишет его
 * только редьюсер по событию `DialogueOptionChosen`.
 *
 * @param {any} state
 * @param {string} dialogueId
 * @returns {{ flags: string[], chosen: Record<string, string[]>, attempted: Record<string, string[]> }}
 */
export function dialogueProgress(state, dialogueId) {
  const entry = state?.dialogues?.[dialogueId]
  return {
    flags: Array.isArray(entry?.flags) ? entry.flags.map(String) : [],
    chosen: entry?.chosen && typeof entry.chosen === 'object' ? entry.chosen : {},
    attempted: entry?.attempted && typeof entry.attempted === 'object' ? entry.attempted : {},
  }
}

/**
 * Флаги отряда по всем разговорам кампании.
 *
 * @param {any} state
 * @returns {Set<string>}
 */
export function dialogueFlags(state) {
  const registry = state?.dialogues && typeof state.dialogues === 'object' ? state.dialogues : {}
  return new Set(Object.values(registry).flatMap((entry) => (Array.isArray(entry?.flags) ? entry.flags.map(String) : [])))
}

/**
 * Факт памяти мира, который раскрывает исход: тайна сценария по id или тайна
 * исходной ситуации по теме. Пустая строка — раскрывать нечего или такой
 * тайны в этой кампании нет.
 *
 * @param {any} state
 * @param {{ reveal?: string, reveal_topic?: string } | null | undefined} result
 * @returns {string}
 */
export function dialogueRevealFactId(state, result) {
  const facts = Array.isArray(state?.worldMemory?.facts) ? state.worldMemory.facts : []
  if (result?.reveal) {
    const scenario = campaignScenario(state)
    const factId = scenario ? scenarioClueFactId(scenario, result.reveal) : ''
    return factId && facts.some((/** @type {any} */ fact) => fact?.id === factId) ? factId : ''
  }
  if (result?.reveal_topic) {
    const topic = clean(result.reveal_topic, 200)
    const fact = facts.find((/** @type {any} */ entry) => {
      if (entry?.predicate !== 'gm_secret') return false
      try { return clean(JSON.parse(String(entry.object ?? '{}'))?.topic, 200) === topic } catch { return false }
    })
    return fact ? String(fact.id) : ''
  }
  return ''
}

/**
 * Тайны, награду за которые уже выдал разговор: находка той же тайны поиском
 * второй предмет не выдаёт.
 *
 * @param {any} state
 * @returns {Set<string>}
 */
export function dialogueGrantedFactIds(state) {
  const registry = state?.dialogues && typeof state.dialogues === 'object' ? state.dialogues : {}
  return new Set(Object.values(registry).flatMap((entry) => (Array.isArray(entry?.granted) ? entry.granted.map(String) : [])))
}

/**
 * Знает ли отряд этот факт: его рассказали (журнал знания) или нашли поиском.
 *
 * @param {any} state
 * @param {string} factId
 */
function factKnownToParty(state, factId) {
  if (!factId) return false
  const memory = state?.worldMemory ?? {}
  return (Array.isArray(memory.knowledge_revealed) ? memory.knowledge_revealed : []).some((/** @type {any} */ entry) => String(entry?.fact_id) === factId)
    || (Array.isArray(memory.facts) ? memory.facts : []).some((/** @type {any} */ fact) => fact?.predicate === 'discovery' && String(fact.supersedes_fact_id ?? '') === factId)
}

/**
 * Выполнены ли условия показа варианта.
 *
 * @param {any} state
 * @param {Dialogue} dialogue
 * @param {DialogueOption} item
 */
export function dialogueOptionUnlocked(state, dialogue, item) {
  const flags = dialogueFlags(state)
  const clues = scenarioFoundClueIds(state)
  if (!item.requires.flags.every((flag) => flags.has(flag))) return false
  if (item.requires.flags_none.some((flag) => flags.has(flag))) return false
  if (item.requires.clues_all.length && !item.requires.clues_all.every((clue) => clues.has(clue))) return false
  if (item.requires.clues_any.length && !item.requires.clues_any.some((clue) => clues.has(clue))) return false
  return true
}

/**
 * Открыта ли сюжетная команда варианта для героя. Кошель и вещь оружейной —
 * раз на героя; команды рыцаря — по его правилам (`server/scenario-knight.mjs`):
 * вариант не обещает того, от чего команда откажет.
 *
 * @param {any} state
 * @param {DialogueOption} item
 * @param {string} hero
 * @param {{ chosen: Record<string, string[]> }} progress
 */
function dialogueActionOpen(state, item, hero, progress) {
  const type = item.action?.command_type
  if (type === 'ReturnKnightHead' || type === 'ReleaseCursedKnight') {
    const knight = scenarioKnightState(state)
    if (!knight || knight.released) return false
    if (type === 'ReturnKnightHead') return !knight.head_returned && scenarioKnightRiddleSolved(state)
    return knight.head_returned && !knight.attempts.includes(`${hero}:${scenarioNightIndex(state)}`)
  }
  if (type === 'ResolveScenarioInformant') {
    const informant = scenarioInformantRules(state).find((entry) => entry.id === item.action?.informant_id)
    if (!informant?.revealed || scenarioLocationId(state) !== informant.location_id) return false
    if (state?.scenario_attention?.informants?.[informant.id]) return false
    return !(item.action?.choice === 'turn' && (state?.scenario_attention?.informant_turn_failed ?? []).includes(informant.id))
  }
  if (type === 'NegotiateScenarioTreaty') {
    const rules = scenarioTreatyRules(state)
    if (!rules || rules.concluded || !rules.truth_revealed || scenarioLocationId(state) !== rules.boss_location_id) return false
    return !(state?.scenario_attention?.treaty?.attempts ?? []).map(String).includes(hero)
  }
  // Кошель и вещь оружейной — раз на героя, каким бы путём он их ни взял:
  // фразой, другим вариантом или этим.
  const taken = type === 'ReceiveScenarioPurse' ? state?.scenario_attention?.purse_paid
    : type === 'ChooseScenarioArmoryItem' ? state?.scenario_attention?.armory_taken : null
  if ((Array.isArray(taken) ? taken : []).map(String).includes(hero)) return false
  return !(progress.chosen[item.id] ?? []).includes(hero)
}

/**
 * Варианты, которые видит герой: открытые условием и ещё не исчерпанные.
 * Проверку герой пробует один раз; вариант с открытой тайной после её
 * раскрытия не нужен; сюжетная команда после исполнения этим героем — тоже.
 * Уже заданный вопрос остаётся, но помечен `asked`, как серый пункт в BG3.
 *
 * @param {any} state
 * @param {unknown} npcId
 * @param {unknown} heroId
 * @returns {{ greeting: string, options: Array<{ id: string, label: string, check?: { skill: string, dc: number }, asked: boolean, ends: boolean }> } | null}
 */
export function dialogueOptionsFor(state, npcId, heroId) {
  const dialogue = dialogueFor(state, npcId)
  if (!dialogue) return null
  const hero = clean(heroId, 120)
  const progress = dialogueProgress(state, dialogue.id)
  const options = dialogue.options
    .filter((item) => dialogueOptionUnlocked(state, dialogue, item))
    .filter((item) => !(item.check && !item.action && (progress.attempted[item.id] ?? []).includes(hero)))
    // Из группы герой выбирает один вариант: остальные для него закрыты.
    .filter((item) => !(item.group && dialogue.options.some((other) => other.group === item.group && other.id !== item.id
      && (progress.chosen[other.id] ?? []).includes(hero))))
    // Рассказанное второй раз не спрашивают: тайну успеха отряд уже знает.
    .filter((item) => !factKnownToParty(state, dialogueRevealFactId(state, item.success)))
    .filter((item) => !item.action || dialogueActionOpen(state, item, hero, progress))
    .map((item) => ({
      id: item.id,
      label: item.label,
      ...(item.check ? { check: { ...item.check } } : {}),
      asked: (progress.chosen[item.id] ?? []).length > 0,
      ends: item.ends,
    }))
  return { greeting: dialogue.greeting, options }
}

/**
 * Реестр разговоров в состоянии: `{ [dialogue_id]: { flags, chosen, attempted } }`.
 * Выводится из журнала событием `DialogueOptionChosen`, поэтому replay сходится.
 *
 * @param {unknown} value
 * @returns {Record<string, { flags: string[], chosen: Record<string, string[]>, attempted: Record<string, string[]>, granted: string[] }>}
 */
export function normalizeDialogueState(value) {
  /** @type {Record<string, { flags: string[], chosen: Record<string, string[]>, attempted: Record<string, string[]>, granted: string[] }>} */
  const result = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  /** @param {unknown} map */
  const lists = (map) => Object.fromEntries(Object.entries(map && typeof map === 'object' && !Array.isArray(map) ? map : {})
    .map(([key, heroes]) => [clean(key, 80), [...new Set((Array.isArray(heroes) ? heroes : []).map((hero) => clean(hero, 120)).filter(Boolean))]])
    .filter(([key]) => key))
  for (const [dialogueId, entry] of Object.entries(value)) {
    const id = clean(dialogueId, 80)
    if (!id || !entry || typeof entry !== 'object') continue
    result[id] = {
      flags: [...new Set((Array.isArray(entry.flags) ? entry.flags : []).map((/** @type {unknown} */ flag) => clean(flag, 80)).filter(Boolean))],
      chosen: lists(entry.chosen),
      attempted: lists(entry.attempted),
      granted: [...new Set((Array.isArray(entry.granted) ? entry.granted : []).map((/** @type {unknown} */ factId) => clean(factId, 200)).filter(Boolean))],
    }
  }
  return result
}

/**
 * Свёртка события выбранного варианта: флаги отряда, кто выбирал вариант и
 * кто уже пробовал его проверку.
 *
 * @param {unknown} value
 * @param {any} event
 */
export function applyDialogueEvent(value, event) {
  const state = normalizeDialogueState(value)
  if (event?.event_type !== DIALOGUE_EVENT) return state
  const payload = event.payload ?? {}
  const dialogueId = clean(payload.dialogue_id, 80)
  const optionId = clean(payload.option_id, 80)
  const hero = clean(payload.hero_id, 120)
  if (!dialogueId || !optionId || !hero) return state
  const entry = state[dialogueId] ?? { flags: [], chosen: {}, attempted: {}, granted: [] }
  const granted = clean(payload.granted_fact_id, 200)
  const sets = (Array.isArray(payload.sets) ? payload.sets : []).map((/** @type {unknown} */ flag) => clean(flag, 80)).filter(Boolean)
  state[dialogueId] = {
    flags: [...new Set([...entry.flags, ...sets])],
    chosen: { ...entry.chosen, [optionId]: [...new Set([...(entry.chosen[optionId] ?? []), hero])] },
    attempted: payload.check ? { ...entry.attempted, [optionId]: [...new Set([...(entry.attempted[optionId] ?? []), hero])] } : entry.attempted,
    granted: granted ? [...new Set([...entry.granted, granted])] : entry.granted,
  }
  return state
}

/**
 * Разговоры сцены для зрителя: у каких собеседников здесь есть авторский
 * диалог и какие варианты видит его герой. Вне боя и только у тех, кто стоит
 * в сцене и виден отряду. Сам реестр разговоров (`dialogues`) наружу не идёт.
 *
 * @param {any} state
 * @param {{ playerId?: unknown }} [viewer]
 * @returns {Record<string, { greeting: string, options: Array<{ id: string, label: string, check?: { skill: string, dc: number }, asked: boolean, ends: boolean }> }>}
 */
export function sceneDialoguesForViewer(state, { playerId = '' } = {}) {
  /** @type {Record<string, any>} */
  const result = {}
  if (state?.mechanics?.combat?.active || !campaignScenario(state)) return result
  /** @param {unknown} value */
  const place = (value) => clean(value, 180).toLocaleLowerCase('ru')
  const here = place(state?.scene?.location)
  for (const npc of Array.isArray(state?.social?.npcs) ? state.social.npcs : []) {
    if (!npc || npc.available === false || place(npc.location) !== here) continue
    // Закрытый собеседник виден отряду, пока стоит в сцене (`reveal_on_presence`,
    // как в `npcSocialForViewer`): рыцарь в полночь.
    if (npc.visibility && !['party', 'public'].includes(String(npc.visibility)) && npc.reveal_on_presence !== true) continue
    if (state?.npc_world?.vitals?.[npc.id]?.alive === false) continue
    const view = dialogueOptionsFor(state, npc.id, playerId)
    if (view) result[String(npc.id)] = view
  }
  return result
}

const CHECK_SKILL_LABELS = Object.freeze({
  persuasion: 'Убеждение', deception: 'Обман', intimidation: 'Запугивание', insight: 'Проницательность',
  history: 'История', religion: 'Религия', arcana: 'Магия', performance: 'Выступление', medicine: 'Медицина',
})

/**
 * Строка летописи об исходе проверки в разговоре — та же форма, что у
 * свободной реплики собеседнику («Проверка «Убеждение»: успех (19).»).
 *
 * @param {{ skill?: unknown, success?: unknown, total?: unknown } | null | undefined} check
 */
export function dialogueCheckLine(check) {
  if (!check) return ''
  const skill = clean(check.skill, 40)
  // Только собственный ключ: навык `constructor` печатается как есть, а не исходником функции.
  const label = (Object.hasOwn(CHECK_SKILL_LABELS, skill) ? CHECK_SKILL_LABELS[/** @type {keyof typeof CHECK_SKILL_LABELS} */ (skill)] : undefined) ?? skill
  const total = Number(check.total)
  return `Проверка «${label}»: ${check.success === true ? 'успех' : 'провал'}${Number.isFinite(total) ? ` (${total})` : ''}.`
}
