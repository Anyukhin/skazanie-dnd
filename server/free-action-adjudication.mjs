import { createHash } from 'node:crypto'

import { DIFFICULTY_CLASSES } from './adjudicator.mjs'
import { findActor, skillProficiencyForActor } from './rules-engine.mjs'
import {
  LOOT_CONTAINER_REACH_FEET,
  lootContainerList,
  lootContainerReachFor,
  lootContainersInScene,
  lootItemForViewer,
} from './loot-containers.mjs'

/**
 * Серверное судейство свободного действия — то, что живой ведущий решает в уме.
 *
 * Разделение обязанностей жёсткое: модель может предложить только смысл действия и
 * категорию из перечисления, а режим разрешения, число СЛ и последствие выбирает
 * сервер. Модуль детерминированный и без вызовов LLM, как `campaign-loop-policy.mjs`.
 */

const clean = (value, maximum = 300) => String(value ?? '')
  .normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)

export const PLAUSIBILITY_LEVELS = Object.freeze(['trivial', 'plausible', 'strenuous', 'impossible_without_means'])
export const RISK_LEVELS = Object.freeze(['none', 'minor', 'serious', 'deadly'])
export const RESOLUTION_MODES = Object.freeze(['auto_success', 'check', 'counter_offer'])
export const FREE_ACTION_SKILLS = Object.freeze([
  'acrobatics', 'animal-handling', 'arcana', 'athletics', 'deception',
  'history', 'insight', 'intimidation', 'investigation', 'medicine', 'nature',
  'perception', 'performance', 'persuasion', 'religion', 'sleight-of-hand',
  'stealth', 'survival',
])
export const FREE_ACTION_PROFICIENCY_LEVELS = Object.freeze(['none', 'proficient', 'expertise'])
export const FREE_ACTION_CONSEQUENCE_TYPES = Object.freeze(['time', 'noise', 'exposure', 'lost_opportunity'])

const inEnum = (values, value, fallback) => (values.includes(String(value)) ? String(value) : fallback)
const canonicalSkill = (value) => {
  const normalized = clean(value, 60).toLocaleLowerCase('en').replace(/_/gu, '-')
  return inEnum(FREE_ACTION_SKILLS, normalized, 'perception')
}

/**
 * Шаг 3 брифа: ведущий не требует броска, когда на кону ничего нет. Незапертую дверь
 * открывают без кубика — это правило, а не срезание угла.
 */
export function resolutionModeFor({ plausibility, risk } = {}) {
  const level = inEnum(PLAUSIBILITY_LEVELS, plausibility, 'plausible')
  const stake = inEnum(RISK_LEVELS, risk, 'minor')
  if (level === 'impossible_without_means') return { mode: 'counter_offer', difficulty_category: null, difficulty: null }
  if (stake === 'none' && (level === 'trivial' || level === 'plausible')) {
    return { mode: 'auto_success', difficulty_category: null, difficulty: null }
  }
  const category = level === 'trivial'
    ? 'easy'
    : level === 'strenuous' || stake === 'deadly'
      ? 'hard'
      : 'medium'
  return { mode: 'check', difficulty_category: category, difficulty: DIFFICULTY_CLASSES[category] }
}

/**
 * Шаг 1 брифа, детерминированная половина. Модель, когда она доступна, предлагает те же
 * поля из тех же перечислений; здесь они выводятся из текста без вызова LLM, чтобы игра
 * оставалась играбельной без ключа.
 *
 * Подход определяет характеристику: «запугиваю силой» — это Запугивание от Силы, поэтому
 * характеристика и навык выбираются независимо друг от друга.
 */
const APPROACH_PATTERNS = Object.freeze([
  { test: /(подпира|баррикад|завал|подпер|держ\w+\s+двер)/iu, ability: 'str', skill: 'athletics', plausibility: 'plausible', risk: 'minor', obstacle: 'дверь' },
  { test: /(взлам|выбива|выломать|ломаю)/iu, ability: 'str', skill: 'athletics', plausibility: 'strenuous', risk: 'serious', obstacle: 'преграда' },
  { test: /(поджиг|зажиг|подпал|факел\w*\s+к)/iu, ability: 'dex', skill: 'sleight-of-hand', plausibility: 'plausible', risk: 'serious', obstacle: 'огонь' },
  { test: /(крад|тих\w+|незамет|прячусь|скрыва)/iu, ability: 'dex', skill: 'stealth', plausibility: 'plausible', risk: 'minor', obstacle: 'наблюдатели' },
  { test: /(запуг|угрож|пригрож)/iu, ability: 'cha', skill: 'intimidation', plausibility: 'plausible', risk: 'minor', obstacle: 'собеседник' },
  { test: /(убежда|уговар|догова|прош\w+\s+помощ)/iu, ability: 'cha', skill: 'persuasion', plausibility: 'plausible', risk: 'minor', obstacle: 'собеседник' },
  { test: /(обман|вру|соврать|притвор)/iu, ability: 'cha', skill: 'deception', plausibility: 'plausible', risk: 'minor', obstacle: 'собеседник' },
  { test: /(крич|зову|окликa|подзыва)/iu, ability: 'cha', skill: 'persuasion', plausibility: 'plausible', risk: 'minor', obstacle: 'окружающие' },
  { test: /(осматр|разгляд|изуча|ищу\s+след|обыск)/iu, ability: 'wis', skill: 'perception', plausibility: 'trivial', risk: 'none', obstacle: 'обстановка' },
  { test: /(вспомина|припомин|знаю\s+ли|что\s+известно)/iu, ability: 'int', skill: 'history', plausibility: 'trivial', risk: 'none', obstacle: 'память' },
  { test: /(залез|взбира|караб|подтягива)/iu, ability: 'str', skill: 'athletics', plausibility: 'strenuous', risk: 'serious', obstacle: 'высота' },
  { test: /(?<![\p{L}\p{M}])(?:вс|с|за|пере|под|вы|при|от)?прыг|(?<![\p{L}\p{M}])(?:прыж|соскоч|перескоч)/iu, ability: 'dex', skill: 'acrobatics', plausibility: 'strenuous', risk: 'serious', obstacle: 'разрыв' },
])

/**
 * Приведение прочтения к контракту. Отдельная функция, потому что тот же контракт
 * обязан выдержать и предложение модели: перечисления одни и те же, а незнакомое
 * значение молча заменяется безопасным, а не доходит до движка.
 */
export function normalizeFreeActionReading(input = {}, fallbackText = '') {
  const value = clean(fallbackText, 1_000)
  return {
    goal_summary: clean(input.goal_summary, 200) || value.slice(0, 200),
    approach_summary: clean(input.approach_summary, 200) || value.slice(0, 200),
    ability: inEnum(['str', 'dex', 'con', 'int', 'wis', 'cha'], input.ability, 'wis'),
    skill: canonicalSkill(input.skill),
    plausibility: inEnum(PLAUSIBILITY_LEVELS, input.plausibility, 'plausible'),
    risk: inEnum(RISK_LEVELS, input.risk, 'minor'),
    obstacle: clean(input.obstacle, 120) || value.slice(0, 120),
    required_means: [...new Set((Array.isArray(input.required_means) ? input.required_means : [])
      .map((entry) => clean(entry, 160)).filter(Boolean))].slice(0, 4),
    // Цена хода и эффект проверяются каталогом `improvised-effects.mjs`;
    // здесь достаточно не пропустить мусор дальше.
    action_cost: inEnum(['action', 'bonus_action', 'free'], input.action_cost, 'action'),
    effect: clean(input.effect, 40) || 'none',
    effect_target: clean(input.effect_target, 120),
    hazard: clean(input.hazard, 40),
    // Предмет обстановки для `topple_prop`/`ignite_prop`. Здесь только форма:
    // существует ли такой предмет на карте, решает привязка к состоянию ниже.
    prop_id: clean(input.prop_id, 120),
    target_id: clean(input.target_id, 120),
    item_id: clean(input.item_id, 120),
    proficiency: inEnum(FREE_ACTION_PROFICIENCY_LEVELS, input.proficiency, 'none'),
    consequence_type: inEnum(FREE_ACTION_CONSEQUENCE_TYPES, input.consequence_type, 'time'),
    source: clean(input.source, 60) || 'deterministic-default',
  }
}

export function interpretFreeAction(text = '') {
  const value = clean(text, 1_000)
  const match = APPROACH_PATTERNS.find((pattern) => pattern.test.test(value)) ?? null
  const consequenceType = ['stealth', 'deception'].includes(match?.skill)
    ? 'exposure'
    : ['persuasion', 'intimidation'].includes(match?.skill)
      ? 'lost_opportunity'
      : /(крич|лома|выбива|поджиг|зажиг)/iu.test(value)
        ? 'noise'
        : 'time'
  return normalizeFreeActionReading({
    ability: match?.ability,
    skill: match?.skill,
    plausibility: match?.plausibility,
    risk: match?.risk,
    obstacle: match?.obstacle,
    // Детерминированная таблица механических следствий не назначает: она не
    // понимает, что именно в сцене можно опрокинуть. Это работа агента.
    effect: 'none',
    consequence_type: consequenceType,
    source: match ? 'deterministic-pattern' : 'deterministic-default',
  }, value)
}

/** Проверка согласованной заявки до расходования зарегистрированной кости. */
export function assertFreeActionConfirmation(context, text, stateVersion) {
  if (context?.kind !== 'free_action' || context.action_fingerprint !== digest(clean(text, 1_000)) || !context.reading) {
    const error = new Error('Бросок не относится к согласованной заявке. Отправьте действие ещё раз, чтобы согласовать проверку.')
    error.code = 'ROLL_CONTEXT_MISMATCH'
    throw error
  }
  if (!Number.isSafeInteger(context.state_version) || context.state_version !== stateVersion) {
    const error = new Error('Обстановка изменилась после предложения. Отправьте действие ещё раз: ведущий заново проверит цену и последствия.')
    error.code = 'STATE_VERSION_CONFLICT'
    throw error
  }
}

function normalizedWords(value) {
  return clean(value, 1_000).toLocaleLowerCase('ru').replace(/ё/gu, 'е')
    .match(/\p{L}[\p{L}\p{M}0-9-]*/gu) ?? []
}

function wordStem(value) {
  const word = String(value ?? '').toLocaleLowerCase('ru').replace(/ё/gu, 'е')
  if (!/^[а-я]{3,}$/u.test(word)) return word
  for (const suffix of ['иями', 'ями', 'ами', 'ого', 'ему', 'ому', 'ыми', 'ими', 'ах', 'ях', 'ой', 'ей', 'ом', 'ем', 'а', 'я', 'у', 'ю', 'е', 'ы', 'и']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length)
  }
  return word
}

function mentionsReference(text, values) {
  const message = normalizedWords(text)
  return (Array.isArray(values) ? values : []).some((value) => {
    const words = normalizedWords(value)
    return words.length > 0 && words.every((word) => message.some((candidate) => (
      candidate === word || wordStem(candidate) === wordStem(word)
    )))
  })
}

function currentSocialActors(state) {
  const location = clean(state?.scene?.location, 180).toLocaleLowerCase('ru')
  return (state?.social?.npcs ?? []).filter((npc) => {
    const npcLocation = clean(npc?.location, 180).toLocaleLowerCase('ru')
    return npc?.available !== false && (!location || !npcLocation || location === npcLocation)
  })
}

function referenceNames(actor) {
  return [
    actor?.id,
    actor?.name,
    actor?.character,
    actor?.label,
    actor?.role,
    ...(Array.isArray(actor?.aliases) ? actor.aliases : []),
    ...(Array.isArray(actor?.tags) ? actor.tags.filter((tag) => !String(tag).includes(':')) : []),
  ].map((value) => clean(value, 160)).filter(Boolean)
}

function itemReferenceNames(item) {
  return [item?.id, item?.catalog_id, item?.name, item?.label]
    .map((value) => clean(value, 160)).filter(Boolean)
}

function actionTargets(state) {
  return [...new Map([
    ...(state?.players ?? []),
    ...(state?.actors ?? []),
    ...(state?.enemies ?? []),
    ...currentSocialActors(state),
  ].map((actor) => [String(actor?.id ?? ''), actor]).filter(([id]) => id)).values()]
}

/**
 * Модель может назвать только ID из переданного брифа. Сервер повторно
 * связывает их с текущим состоянием, выводит отсутствующие ссылки из текста и
 * всегда перезаписывает уровень владения значением из листа героя.
 */
export function bindFreeActionReadingToState(state = {}, actorId = '', text = '', input = {}) {
  const reading = normalizeFreeActionReading(input, text)
  // Предмет обстановки живёт в авторитетной карте сцены, а не в списке
  // участников: сверяется он отдельно и по тому же принципу — назван моделью,
  // но существует ли он, решает сервер.
  const sceneProps = Array.isArray(state?.scene?.map?.props) ? state.scene.map.props : []
  const boundPropId = sceneProps.some((prop) => String(prop?.id ?? '') === reading.prop_id) ? reading.prop_id : ''
  const targets = actionTargets(state).filter((actor) => String(actor?.id) !== String(actorId))
  const allowedTarget = targets.find((actor) => String(actor?.id) === reading.target_id) ?? null
  const mentionedTargets = allowedTarget ? [allowedTarget] : targets.filter((actor) => mentionsReference(text, referenceNames(actor)))
  const actor = findActor(state, actorId)
  const inventory = Array.isArray(actor?.inventory) ? actor.inventory : []
  const allowedItem = inventory.find((item) => String(item?.id) === reading.item_id) ?? null
  const mentionedItems = allowedItem ? [allowedItem] : inventory.filter((item) => mentionsReference(text, itemReferenceNames(item)))
  const proficiency = skillProficiencyForActor(actor, reading.skill)
  const ambiguities = [
    ...(mentionedTargets.length > 1 ? ['target_id'] : []),
    ...(mentionedItems.length > 1 ? ['item_id'] : []),
  ]
  return {
    ...reading,
    prop_id: boundPropId,
    target_id: mentionedTargets.length === 1 ? String(mentionedTargets[0].id) : '',
    item_id: mentionedItems.length === 1 ? String(mentionedItems[0].id) : '',
    proficiency: proficiency.expertise ? 'expertise' : proficiency.proficient ? 'proficient' : 'none',
    proficiency_bonus: proficiency.bonus,
    reference_ambiguities: ambiguities,
  }
}

const DIFFICULTY_ORDER = Object.freeze(['easy', 'medium', 'hard'])

/**
 * СЛ остаётся серверной: модель сообщает только смысл/риск. Контекст сдвигает
 * категорию максимум на одну ступень за каждую подтверждённую причину.
 */
export function contextualResolutionFor(state = {}, actorId = '', reading = {}, text = '') {
  const base = resolutionModeFor(reading)
  if (base.mode !== 'check') return { ...base, difficulty_factors: [] }
  let index = DIFFICULTY_ORDER.indexOf(base.difficulty_category)
  const factors = []
  const actor = findActor(state, actorId)
  const item = (actor?.inventory ?? []).find((entry) => String(entry?.id) === String(reading.item_id ?? ''))
  if (item) {
    index -= 1
    factors.push('confirmed_item')
  }
  const hasCover = reading.skill === 'stealth'
    && /(телег|бочк|укрыт|занавес|тень|колонн|ящик)/iu.test(text)
    && (state?.scene?.map?.props?.length > 0 || state?.scene?.cells?.length > 0)
  if (hasCover) {
    index -= 1
    factors.push('scene_cover')
  }
  if (state?.mechanics?.combat?.active) {
    index += 1
    factors.push('combat_pressure')
  }
  const environmentalPressure = `${text} ${state?.scene?.mood ?? ''}`
  if (/(шторм|бур[яе]|пожар|обвал|скольз|темнот|дым|хаос|движущ)/iu.test(environmentalPressure)) {
    index += 1
    factors.push('environmental_pressure')
  }
  if (/(незаперт|прост\w+\s+задач|без\s+спешк|много\s+времен)/iu.test(text)) {
    index -= 1
    factors.push('favorable_conditions')
  }
  const difficulty_category = DIFFICULTY_ORDER[Math.max(0, Math.min(DIFFICULTY_ORDER.length - 1, index))]
  return {
    ...base,
    difficulty_category,
    difficulty: DIFFICULTY_CLASSES[difficulty_category],
    difficulty_factors: factors,
  }
}

const TRANSFER_GIVE = /(?<![\p{L}\p{M}])(переда\p{L}*|отда\p{L}*|даю|дам|вруча\p{L}*|give|hand)(?![\p{L}\p{M}])/iu
const TRANSFER_TAKE = /(?<![\p{L}\p{M}])(беру|возьму|забира\p{L}*|получа\p{L}*|take|get)(?![\p{L}\p{M}])/iu
const INVENTORY_NOUN = /(предмет|вещ|вер[её]в|меч|кинжал|лук|факел|зель|ключ|карта|свиток|па[её]к|ration|rope|item)/iu

function partyActors(state, actorId) {
  return (state?.players ?? []).filter((actor) => String(actor?.id) !== String(actorId))
}

function mentionedPartyActors(state, actorId, text, requestedId = '') {
  const candidates = partyActors(state, actorId)
  const requested = candidates.find((actor) => String(actor?.id) === String(requestedId ?? ''))
  if (requested) return [requested]
  const mentioned = candidates.filter((actor) => mentionsReference(text, referenceNames(actor)))
  if (mentioned.length) return mentioned
  return /(?:товарищ|союзник|другому\s+герою|напарник)/iu.test(text) && candidates.length === 1 ? candidates : []
}

function mentionedInventoryItems(inventory, text, requestedId = '') {
  const requested = (inventory ?? []).find((item) => String(item?.id) === String(requestedId ?? ''))
  if (requested) return [requested]
  return (inventory ?? []).filter((item) => mentionsReference(text, itemReferenceNames(item)))
}

/**
 * Возвращает существующую авторитетную TransferItem либо уточнение. Чужой
 * инвентарь никогда не становится actor_id команды от лица запрашивающего
 * игрока: «беру у товарища» требует действия владельца вещи.
 */
export function resolveInventoryTransfer(state = {}, actorId = '', text = '', reading = {}) {
  const give = TRANSFER_GIVE.test(text)
  const take = TRANSFER_TAKE.test(text)
  if (!give && !take) return null
  const actor = findActor(state, actorId)
  if (!actor) return { status: 'clarification', narration: 'Герой для передачи предмета не найден.' }
  const targets = mentionedPartyActors(state, actorId, text, reading.target_id)
  const ownItems = mentionedInventoryItems(actor.inventory ?? [], text, reading.item_id)
  if (!ownItems.length && !INVENTORY_NOUN.test(text)) return null
  if (targets.length !== 1) {
    return {
      status: 'clarification',
      narration: targets.length > 1
        ? `Уточните получателя: подходят ${targets.map((target) => target.character ?? target.name ?? target.id).join(', ')}.`
        : 'Уточните, какому герою нужно передать предмет.',
    }
  }
  const target = targets[0]
  if (take && !give) {
    const sourceItems = mentionedInventoryItems(target.inventory ?? [], text)
    return {
      status: 'clarification',
      narration: sourceItems.length === 1
        ? `Эта вещь принадлежит герою ${target.character ?? target.name ?? target.id}. Передачу должен подтвердить её владелец своим действием.`
        : sourceItems.length > 1
          ? 'У владельца найдено несколько подходящих вещей. Пусть он явно укажет, что передаёт.'
          : 'У указанного героя нет однозначно названного предмета для передачи.',
    }
  }
  if (ownItems.length !== 1) {
    return {
      status: 'clarification',
      narration: ownItems.length > 1
        ? `Уточните предмет: подходят ${ownItems.map((item) => item.name ?? item.id).join(', ')}.`
        : 'У героя нет однозначно названного предмета для передачи.',
    }
  }
  if (state?.mechanics?.combat?.active) {
    return { status: 'clarification', narration: 'Передавать предметы между инвентарями во время боя нельзя.' }
  }
  const item = ownItems[0]
  if (item.equipped) return { status: 'clarification', narration: 'Сначала снимите передаваемый предмет.' }
  if (item.attuned_to) return { status: 'clarification', narration: 'Сначала разорвите настройку с передаваемым предметом.' }
  const requestedQuantity = Number(/(?:^|\s)(\d{1,3})(?=\s|$)/u.exec(text)?.[1] ?? 1)
  const available = Math.max(1, Number(item.quantity) || 1)
  if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > available) {
    return { status: 'clarification', narration: `Доступное количество предмета: ${available}.` }
  }
  return {
    status: 'command',
    command: {
      command_type: 'TransferItem',
      actor_id: String(actorId),
      recipient_id: String(target.id),
      item_id: String(item.id),
      quantity: requestedQuantity,
    },
    narration: `${actor.character ?? actor.name ?? actor.id} передаёт ${item.name ?? 'предмет'} герою ${target.character ?? target.name ?? target.id}.`,
  }
}

/**
 * «Обчищаю карманы торговца», «залезаю в кошель стражнику», «тяну кошелёк».
 *
 * Ветка обязана стоять **до** обыска трупа: у того в шаблоне уже есть слово
 * «карман», и без этого порядка живой купец разбирался бы как тело. Пустой
 * список слов здесь не годится — «карман» в паре с живым человеком читается
 * однозначно, а в паре с телом остаётся обыском.
 */
const PICKPOCKET_PHRASE = /(?:обчищ\p{L}*|обчист\p{L}*|очищ\p{L}*|шар\p{L}*|лез\p{L}*|залез\p{L}*|тян\p{L}*|крад\p{L}*|ворую|своро\p{L}*|срез\p{L}*|стащ\p{L}*|стян\p{L}*|подрез\p{L}*)[^.!?]{0,80}(?:карман\p{L}*|кошел\p{L}*|мошн\p{L}*|кошель)|(?:карман\p{L}*|кошел\p{L}*|мошн\p{L}*)[^.!?]{0,80}(?:обчищ\p{L}*|обчист\p{L}*|срез\p{L}*|стащ\p{L}*|стян\p{L}*|подрез\p{L}*)/iu

/**
 * Карманная кража свободной фразой.
 *
 * Контракт арбитра расширять не пришлось: `sleight_of_hand` уже есть в списке
 * навыков (`action_adjudicator/v3.txt`), а `target_id` он и так называет.
 * Не хватало **маршрута**: прочтение приходило честное, но разрешалось общей
 * проверкой навыка с абстрактной ценой провала — то есть без кармана, без
 * свидетелей и без розыска. Здесь заявка переводится в ту же команду, что
 * приходит из меню NPC, и дальше обе идут одним путём.
 */
export function resolvePickpocket(state = {}, actorId = '', text = '', reading = {}) {
  const looksLikeTheft = PICKPOCKET_PHRASE.test(text) || String(reading?.skill ?? '') === 'sleight-of-hand'
  if (!looksLikeTheft) return null
  const requested = clean(reading?.target_id, 120)
  const npcs = currentSocialActors(state)
  const named = npcs.filter((npc) => String(npc.id) === requested
    || mentionsReference(text, referenceNames(npc)))
  // Кража у своих не разбирается вовсе: у отряда нет карманов друг для друга, и
  // честнее сказать это словами, чем молча судить проверкой навыка.
  const party = (state?.players ?? []).filter((hero) => mentionsReference(text, referenceNames(hero)))
  if (!named.length && party.length) {
    return { status: 'clarification', narration: 'У своих не крадут: обчистить можно только чужой карман.' }
  }
  if (!PICKPOCKET_PHRASE.test(text)) return null
  if (named.length !== 1) {
    return {
      status: 'clarification',
      narration: named.length > 1
        ? `Уточните, чей карман: подходят ${named.map((npc) => npc.name ?? npc.id).join(', ')}.`
        : 'Уточните, у кого именно вы хотите обчистить карман.',
    }
  }
  if (state?.mechanics?.combat?.active === true) {
    return { status: 'clarification', narration: 'Посреди боя карманов не чистят.' }
  }
  const npc = named[0]
  return {
    status: 'command',
    command: { command_type: 'PickpocketNpc', actor_id: String(actorId), npc_id: String(npc.id) },
    narration: `Рука тянется к чужому кошельку: ${npc.name ?? npc.id}.`,
  }
}

const CORPSE_SEARCH = /(?:обыск\p{L}*|провер\p{L}*|осматр\p{L}*|ищ\p{L}*)[^.!?]{0,80}(?:труп|тел[оаеу]|останки|карман)|(?:труп|тел[оаеу]|останки|карман)[^.!?]{0,80}(?:обыск\p{L}*|провер\p{L}*|осматр\p{L}*|ищ\p{L}*)/iu

/**
 * Как фраза называет вид контейнера. Таблица работает в одну сторону: названный
 * вид **сужает** выбор и вправе не совпасть ни с чем — сказавшему «обыскиваю
 * тело» нельзя подсунуть мешок брошенного, — а неназванный ничего не запрещает.
 */
const LOOT_KIND_WORDS = Object.freeze({
  // «Тело» кончается здесь и не продолжается: без границы слова `тел[оаеу]\p{L}*`
  // считал телом всякую телегу.
  corpse: /(?:труп\p{L}*|тел[оаеу](?![\p{L}\p{M}])|телами|останк\p{L}*|павш\p{L}*|мертвец\p{L}*|убит\p{L}*)/iu,
  captive: /(?:пленн\p{L}*|сдавш\p{L}*|связанн\p{L}*)/iu,
  abandoned: /(?:брошенн\p{L}*|оставленн\p{L}*|откуп\p{L}*)/iu,
  cache: /(?:схрон\p{L}*|тайник\p{L}*|заначк\p{L}*)/iu,
})

/** Столько предметов помещается в устный ответ; остальное считается числом. */
const MAX_SPOKEN_LOOT_ITEMS = 8

/**
 * Имена, которыми фраза может назвать контейнер: своё и павшего.
 *
 * Имя контейнера начинается с вида («Тело: Разбойник»), поэтому в список идёт и
 * хвост после двоеточия: «обыскиваю разбойника» — та же заявка, что и
 * «обыскиваю тело разбойника».
 */
function lootContainerReferenceNames(state, container) {
  const sources = new Set([container.source_enemy_id, ...container.source_enemy_ids].filter(Boolean).map(String))
  const enemyNames = (state?.enemies ?? [])
    .filter((enemy) => sources.has(String(enemy?.id ?? '')))
    .flatMap((enemy) => referenceNames(enemy))
  const name = clean(container.name, 160)
  const subject = name.includes(': ') ? name.slice(name.indexOf(': ') + 2) : ''
  return [name, subject, ...enemyNames].filter(Boolean)
}

/**
 * Контейнеры яруса, которые могла иметь в виду фраза. Отбор идёт от узкого к
 * широкому: явная цель прочтения, затем имя из фразы, затем названный вид.
 * Пустой ответ означает «фраза говорила не об этом», а не «здесь пусто».
 */
function lootContainersNamedBy(state, text, reading, containers) {
  const requested = clean(reading?.target_id, 120)
  // Прочтение назвало конкретного актора — значит, речь о нём одном, и пустой
  // ответ здесь означает «контейнера у него нет», а не «поищем кого-нибудь ещё».
  if (requested) {
    return containers.filter((container) => container.source_enemy_id === requested
      || container.source_enemy_ids.includes(requested))
  }
  const named = containers.filter((container) => mentionsReference(text, lootContainerReferenceNames(state, container)))
  if (named.length) return named
  const kinds = Object.keys(LOOT_KIND_WORDS).filter((kind) => LOOT_KIND_WORDS[kind].test(text))
  return kinds.length ? containers.filter((container) => kinds.includes(container.kind)) : containers
}

/**
 * Кого из названных фраза имела в виду.
 *
 * Ближе — значит вероятнее: стоящий над телом и сказавший «обыскиваю тело»
 * говорит именно про него. Но ничья расстоянием — это неоднозначность, а не
 * повод выбрать по алфавиту: между двумя телами под ногами выбирает игрок, и
 * `null` здесь означает «нужно уточнение».
 */
function nearestLootContainer(state, hero, containers) {
  const measured = containers.map((container) => ({ container, ...lootContainerReachFor(state, hero, container) }))
  const within = measured.filter((entry) => entry.reachable)
  const pool = within.length ? within : measured
  const distance = (entry) => entry.distance_feet ?? Number.POSITIVE_INFINITY
  const [first, second] = [...pool].sort((left, right) => distance(left) - distance(right)
    || left.container.id.localeCompare(right.container.id))
  if (!first) return null
  return second && distance(second) === distance(first) ? null : first
}

/** Содержимое словами. Вид — тот же `lootItemForViewer`, что отдаёт панель. */
function spokenLootContents(container) {
  const items = container.items.map((item) => lootItemForViewer(item))
  const spoken = items.slice(0, MAX_SPOKEN_LOOT_ITEMS)
    .map((item) => (item.quantity > 1 ? `${item.name} (${item.quantity})` : item.name))
    .join(', ')
  const rest = items.length - Math.min(items.length, MAX_SPOKEN_LOOT_ITEMS)
  return { items, summary: rest > 0 ? `${spoken} и ещё ${rest}` : spoken }
}

/**
 * Ответ про один найденный контейнер — тот же, что даёт панель, только словами.
 *
 * Содержимое отдаётся ровно по тому же условию, по которому его отдаёт карточка
 * (`lootContainersForViewer`): герой дотянулся. Дальше пяти футов ответ честно
 * зовёт подойти и **называет** контейнер — его имя игрок и так видит в панели,
 * поэтому нового здесь не открывается. Взятия не происходит ни в одном случае:
 * осмотр бесплатен, а набор выдаёт команда обыска.
 */
function lootContainerAnswer(state, hero, container) {
  const { reachable: withinReach, distance_feet: distanceFeet } = lootContainerReachFor(state, hero, container)
  const common = {
    status: 'clarification',
    server_owned_contents: container.status === 'available',
    corpse_id: String(container.source_enemy_id || container.source_enemy_ids[0] || ''),
    loot_container_id: container.id,
    loot_container_kind: container.kind,
    loot_container_name: container.name,
    ...(distanceFeet == null ? {} : { distance_feet: distanceFeet }),
  }
  if (container.status !== 'available') {
    return { ...common, narration: `${container.name}: здесь уже всё сняли, контейнер добычи пуст.` }
  }
  if (!withinReach) {
    return {
      ...common,
      narration: `${container.name}: отсюда не дотянуться${distanceFeet == null ? '' : ` — идти ещё ${distanceFeet} фт`}.`
        + ` Обыскивают в пределах ${LOOT_CONTAINER_REACH_FEET} футов: подойдите вплотную, и я скажу, что там.`,
    }
  }
  const { items, summary } = spokenLootContents(container)
  // Цену обыска называет тот же признак, которым её решает правило
  // (`validateLootContainerCommand`): смотреть бесплатно всегда, а вот забрать
  // посреди боя стоит действия — и узнать об этом игрок обязан до, а не после.
  const combat = state?.mechanics?.combat?.active === true
  return {
    ...common,
    narration: `${container.name}: ${summary}. Забрать нужное можно через панель добычи — набор выдаёт сервер,`
      + ` и выдумывать находку я не стану.${combat ? ' В бою обыск стоит действия; смотреть — бесплатно.' : ''}`,
    loot_items: items,
    loot_action_cost: combat ? 'action' : null,
  }
}

/**
 * Обыск контейнера добычи свободной фразой.
 *
 * Путь у кнопки и у фразы один: контейнеры берутся тем же `lootContainersInScene`
 * (значит, с тем же ярусом), досягаемость — той же меркой, содержимое — тем же
 * bounded-видом. Событий здесь не рождается вовсе: осмотр бесплатен и хода не
 * стоит, а взять набор можно только командой обыска.
 *
 * `null` означает «фраза не про здешние контейнеры» — разбираться будет прежняя
 * ветка ниже.
 */
function resolveLootContainerSearch(state, hero, text, reading) {
  const inScene = lootContainersInScene(state, { includeEmptied: true })
  if (!inScene.length) return null
  const candidates = lootContainersNamedBy(state, text, reading, inScene)
  if (!candidates.length) return null
  // Полный контейнер интереснее обобранного: пустой становится ответом только
  // тогда, когда другого фраза не назвала.
  const available = candidates.filter((container) => container.status === 'available')
  const pool = available.length ? available : candidates
  const chosen = nearestLootContainer(state, hero, pool)
  if (!chosen) {
    return {
      status: 'clarification',
      narration: `Уточните, что именно обыскивает герой: рядом ${pool.map((container) => container.name).join(', ')}.`,
      server_owned_contents: available.length > 0,
    }
  }
  return lootContainerAnswer(state, hero, chosen.container)
}

/**
 * Пока у тела нет явного server-owned контейнера, поиск не подменяется
 * проверкой Внимательности и не создаёт выдуманную добычу.
 *
 * Отказ обязан говорить правду о **конкретном** теле. С появлением инвентарей
 * противников (`server/enemy-loadouts.mjs`) у трупа гуманоида есть авторитетное
 * содержимое — оружие, боеприпасы, изредка расходник и карман медяков, — и
 * ответ «у этого тела нет заданного сервером содержимого» стал бы ложью:
 * состояние говорит одно, рассказчик другое. Поэтому источников содержимого
 * здесь три, и все три учитываются: `loadout` существа, а также исторические
 * `search_contents` / `corpse_contents` объектов сцены.
 *
 * Настоящая добыча разбирается **до** этого: контейнеры волны 3
 * (`resolveLootContainerSearch` выше) — и есть тот авторитетный путь, ради
 * которого писался прежний отказ. Ниже остаётся ровно то, до чего он не
 * дотянулся: тело без контейнера и тело, оставшееся на другом ярусе.
 */
export function resolveCorpseSearch(state = {}, actorId = '', text = '', reading = {}) {
  if (!CORPSE_SEARCH.test(text)) return null
  const hero = (state?.players ?? []).find((player) => String(player?.id ?? '') === String(actorId)) ?? null
  const containerAnswer = resolveLootContainerSearch(state, hero, text, reading)
  if (containerAnswer) return containerAnswer
  const corpses = [
    ...(state?.enemies ?? []).filter((actor) => actor?.alive === false || Number(actor?.hp ?? 1) <= 0),
    ...(state?.entities ?? []).filter((entity) => ['corpse', 'body', 'remains'].includes(String(entity?.kind ?? ''))),
  ]
  const requested = corpses.find((corpse) => String(corpse?.id) === String(reading.target_id ?? ''))
  const mentioned = requested ? [requested] : corpses.filter((corpse) => mentionsReference(text, referenceNames(corpse)))
  const candidates = mentioned.length ? mentioned : corpses.length === 1 ? corpses : []
  if (candidates.length !== 1) {
    return {
      status: 'clarification',
      narration: candidates.length > 1
        ? `Уточните, чьё тело обыскивает герой: ${candidates.map((corpse) => corpse.name ?? corpse.id).join(', ')}.`
        : 'Укажите конкретное тело, которое герой хочет обыскать.',
      server_owned_contents: false,
    }
  }
  const corpse = candidates[0]
  const loadout = corpse?.loadout && typeof corpse.loadout === 'object' && !Array.isArray(corpse.loadout)
    ? corpse.loadout
    : null
  const carried = (Array.isArray(loadout?.items) ? loadout.items.length : 0) > 0
    || Number(loadout?.purse_cp) > 0
  const contents = Array.isArray(corpse?.search_contents) ? corpse.search_contents
    : Array.isArray(corpse?.corpse_contents) ? corpse.corpse_contents
      : null
  // Контейнер добычи, заведённый той же фиксацией, что и смерть
  // (`server/loot-containers.mjs`). Сюда доходят два случая, до которых отбор по
  // фразе не дотянулся: контейнер этого тела назван другим видом («оружие
  // пленного» на заявку «обыскиваю тело») — и контейнер, оставшийся на другом
  // ярусе. Первый разбирается тем же ответом, что и панель; второй обязан
  // сказать правду про место, а не отрицать содержимое.
  const container = lootContainerList(state)
    .find((entry) => entry.source_enemy_id === String(corpse.id ?? '')
      || entry.source_enemy_ids.includes(String(corpse.id ?? '')))
  if (container) {
    const here = lootContainersInScene(state, { includeEmptied: true })
      .some((entry) => entry.id === container.id)
    if (here) return { ...lootContainerAnswer(state, hero, container), corpse_id: String(corpse.id ?? '') }
    return {
      status: 'clarification',
      narration: `Добыча с этого тела осталась на другом ярусе (${container.name}): обыскать её можно, вернувшись туда.`,
      server_owned_contents: container.status === 'available',
      corpse_id: String(corpse.id ?? ''),
      loot_container_id: container.id,
    }
  }
  return {
    status: 'clarification',
    narration: carried
      ? 'На теле действительно есть снаряжение, но контейнера добычи у него не заведено: взять его сейчас нельзя. Я не буду ни выдумывать находку, ни бросать проверку вместо неё.'
      : contents
        ? 'У тела есть описанное содержимое, но оно ещё не оформлено как авторитетный контейнер. Нужна отдельная серверная команда извлечения.'
        : 'У этого тела нет заданного сервером содержимого. Я не буду выдумывать находку или бросать проверку вместо неё.',
    server_owned_contents: carried || Array.isArray(contents),
    corpse_id: String(corpse.id ?? ''),
  }
}

function actorMeans(state = {}, actorId = '') {
  const actor = (state.players ?? []).find((entry) => String(entry?.id) === String(actorId)) ?? null
  const inventory = Array.isArray(actor?.inventory) ? actor.inventory : []
  const ids = new Set()
  for (const item of inventory) {
    for (const value of [item?.id, item?.catalog_id, item?.name]) if (value) ids.add(clean(value, 160).toLocaleLowerCase('ru'))
  }
  for (const key of ['knownSpellIds', 'preparedSpellIds', 'selectedFeatureIds', 'classSkillProficiencies']) {
    for (const value of actor?.[key] ?? []) if (value) ids.add(clean(value, 160).toLocaleLowerCase('ru'))
  }
  return ids
}

/**
 * Шаг 2 брифа: сверка заявленных средств с миром. Это единственное честное место
 * сказать «такого у героя нет» — до броска и до расхода хода.
 */
export function verifyMeans(state = {}, actorId = '', requiredMeans = []) {
  const available = actorMeans(state, actorId)
  const required = [...new Set((Array.isArray(requiredMeans) ? requiredMeans : [])
    .map((value) => clean(value, 160)).filter(Boolean))]
  const missing = required.filter((value) => !available.has(value.toLocaleLowerCase('ru')))
  return { satisfied: missing.length === 0, required, missing }
}

/**
 * Шаг 5 брифа: провал не означает «ничего не произошло». Каталог серверный и
 * ограниченный — модель выбирает уровень риска, но не сочиняет последствие.
 *
 * Автоматический урон за провал импровизации намеренно не реализован: он требует
 * настоящей модели опасностей, иначе наказание окажется произвольным. Уровень `deadly`
 * поэтому даёт самое тяжёлое из неуронных последствий и отмечается отдельно.
 */
const FAIL_FORWARD = Object.freeze({
  none: Object.freeze({ minutes: 5, advances_quest_clock: false, summary: 'Попытка отняла немного времени и ничего не изменила в обстановке.' }),
  minor: Object.freeze({ minutes: 10, advances_quest_clock: false, summary: 'Попытка сорвалась и наделала шума: место перестало быть спокойным.' }),
  serious: Object.freeze({ minutes: 20, advances_quest_clock: true, summary: 'Неудача дорого обошлась: положение осложнилось, и события пошли своим ходом.' }),
  deadly: Object.freeze({ minutes: 30, advances_quest_clock: true, escalates: true, summary: 'Риск оправдался худшим образом: опасность стала явной и близкой.' }),
})

const CONSEQUENCE_SUMMARIES = Object.freeze({
  time: 'Попытка отняла время, а ситуация успела измениться.',
  noise: 'Попытка выдала героя шумом и привлекла нежелательное внимание.',
  exposure: 'Герой раскрыл своё положение и потерял безопасную возможность.',
  lost_opportunity: 'Собеседник или обстоятельства больше не дают прежней возможности.',
})

export function failForwardFor(risk = 'minor', consequenceType = 'time') {
  const stake = inEnum(RISK_LEVELS, risk, 'minor')
  const type = inEnum(FREE_ACTION_CONSEQUENCE_TYPES, consequenceType, 'time')
  return {
    risk: stake,
    consequence_type: type,
    ...FAIL_FORWARD[stake],
    summary: `${CONSEQUENCE_SUMMARIES[type]} ${FAIL_FORWARD[stake].summary}`,
  }
}

/**
 * Шаг 4 брифа: ставки объявляются до броска. Живой ведущий говорит «Атлетика, СЛ 15;
 * сорвёшься — потеряешь время и наделаешь шума» прежде, чем кубик брошен.
 */
export function stakesFor({
  ability = '',
  skill = '',
  resolution = {},
  risk = 'minor',
  proficiency = 'none',
  consequence_type = 'time',
} = {}) {
  if (resolution.mode !== 'check') return null
  const consequence = failForwardFor(risk, consequence_type)
  return {
    ability: clean(ability, 20),
    skill: canonicalSkill(skill),
    proficiency: inEnum(FREE_ACTION_PROFICIENCY_LEVELS, proficiency, 'none'),
    difficulty: resolution.difficulty,
    difficulty_category: resolution.difficulty_category,
    difficulty_factors: [...new Set(Array.isArray(resolution.difficulty_factors) ? resolution.difficulty_factors.map((factor) => clean(factor, 60)).filter(Boolean) : [])].slice(0, 8),
    consequence_type: consequence.consequence_type,
    on_failure: consequence.summary,
    policy: 'free-action-stakes-v2',
  }
}

// Русские подписи d20-проверок для карточки броска и журнала. Идентификаторы
// характеристик и навыков остаются английскими (правило репозитория), подпись
// собирается на сервере — клиент показывает её как есть.
export const ABILITY_LABELS_RU = Object.freeze({
  str: 'Сила', dex: 'Ловкость', con: 'Телосложение', int: 'Интеллект', wis: 'Мудрость', cha: 'Харизма',
})
export const SKILL_LABELS_RU = Object.freeze({
  'acrobatics': 'Акробатика', 'animal-handling': 'Уход за животными', 'arcana': 'Магия', 'athletics': 'Атлетика',
  'deception': 'Обман', 'history': 'История', 'insight': 'Проницательность', 'intimidation': 'Запугивание',
  'investigation': 'Расследование', 'medicine': 'Медицина', 'nature': 'Природа', 'perception': 'Восприятие',
  'performance': 'Выступление', 'persuasion': 'Убеждение', 'religion': 'Религия', 'sleight-of-hand': 'Ловкость рук',
  'stealth': 'Скрытность', 'survival': 'Выживание',
})

export function d20CheckLabel({ kind = 'check', ability = null, skill = null } = {}) {
  const abilityName = ABILITY_LABELS_RU[String(ability ?? '').toLocaleLowerCase('en')] ?? null
  if (kind === 'save') return abilityName ? `Спасбросок: ${abilityName}` : 'Спасбросок'
  const skillName = SKILL_LABELS_RU[String(skill ?? '').toLocaleLowerCase('en').replace(/_/gu, '-')] ?? null
  if (skillName && abilityName) return `${abilityName} (${skillName})`
  return skillName ?? (abilityName ? `Проверка: ${abilityName}` : 'Проверка')
}

/**
 * Шаг 6 брифа: живой ведущий не разрешает перекатывать ту же попытку, пока
 * обстоятельства не изменились. Отпечаток берётся от героя, подхода и препятствия.
 */
export function attemptFingerprint({ actorId = '', approach = '', obstacle = '' } = {}) {
  return digest({
    actor: clean(actorId, 120),
    approach: clean(approach, 300).toLocaleLowerCase('ru'),
    obstacle: clean(obstacle, 300).toLocaleLowerCase('ru'),
  })
}

/** Отпечаток обстановки: пока он не сменился, повтор того же подхода бессмыслен. */
export function situationFingerprint(state = {}) {
  return digest({
    location: clean(state.scene?.location, 180),
    objective: clean(state.scene?.objective, 300),
    revealed: (state.scene?.cells ?? []).filter((cell) => cell.revealed === true).length,
    combat: Boolean(state.mechanics?.combat?.active),
    round: Number(state.mechanics?.combat?.round) || 0,
    elapsed: Number(state.mechanics?.world_time?.elapsed_minutes) || 0,
  })
}

/**
 * Ищет уже проваленную попытку с тем же подходом в неизменившейся обстановке.
 * Возвращает найденную запись или null.
 */
export function previousFailedAttempt(state = {}, fingerprint = '') {
  const situation = situationFingerprint(state)
  return (state.rulings ?? []).find((ruling) => {
    const provenance = ruling?.provenance ?? {}
    return provenance.attempt_fingerprint === fingerprint
      && provenance.situation_fingerprint === situation
      && ruling.outcome === 'failure'
  }) ?? null
}
