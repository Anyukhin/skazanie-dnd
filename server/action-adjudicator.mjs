import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  FREE_ACTION_CONSEQUENCE_TYPES,
  FREE_ACTION_ACTIVITY_KINDS,
  FREE_ACTION_DURATION_CLASSES,
  FREE_ACTION_PROFICIENCY_LEVELS,
  bindFreeActionReadingToState,
  normalizeFreeActionReading,
  harmlessFreeActionReading,
  interpretFreeAction,
  hasRecognizedFreeActionApproach,
  contextualResolutionFor,
  d20CheckLabel,
  explainActionCheck,
  resolveHazardContact,
  verifyMeans,
  resolveExplorationCommand,
} from './free-action-adjudication.mjs'
import { ENVIRONMENT_HAZARD_IDS, IMPROVISED_EFFECT_IDS, scenePropIntentFor } from './improvised-effects.mjs'
import { hazardPropCells, igniteDefinitionFor, sceneHazardVerbsFor, toppleDefinitionFor } from './scene-hazards.mjs'
import { sceneInteractionCatalogEntry } from './scene-interactions.mjs'
import { buildDataOnlyContext } from './security.mjs'
import { cellAt, deserializeTacticalMap } from './tactical-map.mjs'
import { campaignStateForViewer } from './viewer-projection.mjs'
import { npcSocialForViewer } from './npc-social.mjs'

/**
 * Арбитр свободного действия. Единственная роль модели здесь — **понять
 * задумку**: какой характеристикой и навыком её судить, насколько она вообще
 * возможна, чем игрок рискует и чего это стоит в бою.
 *
 * Модель не бросает кубики, не выбирает СЛ, не описывает исход и не может
 * назначить эффект вне закрытого списка. Всё, что она вернула, проходит через
 * `normalizeFreeActionReading` и каталог `improvised-effects.mjs`; при любой
 * ошибке, таймауте или отсутствии ключа предложение молча заменяется
 * детерминированным прочтением, и игра продолжается.
 */
const prompt = readFileSync(fileURLToPath(new URL('../prompts/action_adjudicator/v6.txt', import.meta.url)), 'utf8')

const clean = (value, maximum = 240) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const list = (value) => Array.isArray(value) ? value : []

/** Лист героя в том объёме, который нужен для выбора кубика, и не шире. */
function heroBrief(state, actorId) {
  const hero = (state?.players ?? []).find((actor) => String(actor?.id) === String(actorId)) ?? {}
  const sheet = hero.characterSheet ?? {}
  return {
    id: String(hero.id ?? actorId),
    name: clean(hero.character ?? hero.name, 80),
    role: clean(hero.role, 80),
    abilities: sheet.abilities ?? hero.abilities ?? {},
    skill_proficiencies: list(hero.classSkillProficiencies).map((entry) => clean(entry, 60)),
    skill_expertise: [
      ...list(hero.skillExpertiseIds),
      ...list(hero.expertiseSkillIds),
      ...list(hero.skillExpertise),
      ...list(hero.expertiseSkills),
    ].map((entry) => clean(entry, 60)).slice(0, 20),
    prepared_spells: list(hero.preparedSpellIds).map((entry) => clean(entry, 60)).slice(0, 20),
    known_spells: list(hero.knownSpellIds).map((entry) => clean(entry, 60)).slice(0, 20),
    features: list(hero.selectedFeatureIds).map((entry) => clean(entry, 60)).slice(0, 20),
    inventory: list(hero.inventory).map((item) => ({
      id: clean(item?.id, 120), name: clean(item?.name, 80), equipped: item?.equipped === true,
    })).slice(0, 30),
    speed: Number(hero.speed) || 30,
  }
}

/** Кто на поле. Без этого модель не может назвать корректный `effect_target`. */
function participantsBrief(state, actorId = '') {
  const position = (actor) => (Number.isFinite(Number(actor?.x)) ? { x: Number(actor.x), y: Number(actor.y) } : null)
  const location = clean(state?.scene?.location, 180).toLocaleLowerCase('ru')
  const social = npcSocialForViewer(state.social, { state, playerId: actorId, isPartyMember: true }).npcs.filter((actor) => {
    const actorLocation = clean(actor?.location, 180).toLocaleLowerCase('ru')
    return actor?.available !== false && (!location || !actorLocation || location === actorLocation)
  })
  return [
    ...(state?.players ?? []).map((actor) => ({ id: String(actor.id), name: clean(actor.character ?? actor.name, 80), role: clean(actor.role, 80), aliases: [], side: 'party', at: position(actor) })),
    ...(state?.actors ?? []).map((actor) => ({ id: String(actor.id), name: clean(actor.name, 80), role: clean(actor.role, 80), aliases: [], side: 'party', at: position(actor) })),
    ...(campaignStateForViewer(state, { role: 'player' }, actorId)?.enemies ?? []).filter((actor) => actor?.alive !== false && Number(actor?.hp ?? 1) > 0)
      .map((actor) => ({ id: String(actor.id), name: clean(actor.name, 80), role: clean(actor.role, 80), aliases: [], side: 'enemy', at: position(actor) })),
    ...social.map((actor) => ({
      id: String(actor.id),
      name: clean(actor.name, 80),
      role: clean(actor.role, 80),
      aliases: (actor.tags ?? []).map((entry) => clean(entry, 60)).filter((entry) => entry && !entry.includes(':')).slice(0, 8),
      side: 'npc',
      at: position(actor),
    })),
  ].filter((actor, index, all) => all.findIndex((candidate) => candidate.id === actor.id) === index).slice(0, 24)
}

/**
 * Позиция героя так же, как её видит движок: авторитетная запись
 * `mechanics.positions` первична, поле `players[].x/y` — фолбэк для сцен без
 * боя, где расстановку никто не заводил. Иначе в бою бриф считал расстояния от
 * начальной клетки листа, а не от той, где герой стоит на самом деле.
 */
function heroPosition(state, actorId) {
  const id = String(actorId)
  const stored = state?.mechanics?.positions?.[id]
  const hero = (state?.players ?? []).find((actor) => String(actor?.id) === id) ?? null
  const x = Math.floor(Number(stored?.x ?? hero?.x))
  const y = Math.floor(Number(stored?.y ?? hero?.y))
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

/**
 * Раскрытие клетки по авторитетной карте — тот же вопрос, что решает
 * `viewer-projection.mjs`, вырезая нераскрытые пропсы из проекции игрока.
 * Карта здесь авторитетная, поэтому спрашивать про раскрытие обязан сам бриф.
 *
 * Экспортируется ради второго читателя того же состояния: разбор свободной
 * фразы про реквизит (`autonomous-orchestrator.mjs`) обязан отвечать на вопрос
 * о раскрытии ровно так же, иначе «осмотреть сундук» стало бы дешёвым оракулом
 * по неразведанной части карты.
 *
 * @param {Record<string, any> | null | undefined} state
 * @returns {(prop: Record<string, any> | null | undefined) => boolean}
 */
export function revealedPropPredicate(state) {
  const serialized = state?.scene?.map
  if (!serialized || typeof serialized !== 'object') return () => false
  let map = null
  try {
    map = deserializeTacticalMap(serialized)
  } catch {
    // Карту, которую не разобрать, движок тоже не исполнит: пустой список
    // честнее выдуманного.
    return () => false
  }
  const revealedAt = (x, y) => cellAt(map, x, y)?.revealed === true
  return (prop) => !['gm_only', 'npc_private'].includes(String(prop?.visibility ?? prop?.interaction?.visibility ?? '').toLowerCase())
    && prop?.revealed !== false
    && hazardPropCells(prop).some((cell) => revealedAt(cell.x, cell.y))
}

/**
 * Предметы обстановки, с которыми движок действительно умеет работать.
 *
 * Без этого списка «поджигаю сено» превращалось в одноразовый импровизированный
 * урон: модель не знала идентификатора пропса и назвать его не могла. Список
 * строится из авторитетной карты сцены и справочника опасностей, поэтому в него
 * не попадает ни один предмет, которому движок откажет по каталогу.
 *
 * Из авторитетной карты берётся и раскрытие: предмет в неразведанной части
 * подземелья в брифе не появляется, иначе арбитр назвал бы игроку стеллаж за
 * закрытой дверью — тот самый, который проекция карты от него прячет.
 *
 * Скрытого здесь нет: id, русское имя, состояние, доступные глаголы и клетка —
 * ровно то, что игрок и так видит на доске.
 */
function scenePropsBrief(state, actorId) {
  const at = heroPosition(state, actorId)
  const revealed = revealedPropPredicate(state)
  const props = Array.isArray(state?.scene?.map?.props) ? state.scene.map.props : []
  return props
    .flatMap((prop) => {
      const id = clean(prop?.id, 120)
      const verbs = sceneHazardVerbsFor(prop?.assetId)
      if (!id || !verbs.length || !sceneInteractionCatalogEntry(prop?.assetId)) return []
      if (!revealed(prop)) return []
      const name = toppleDefinitionFor(prop?.assetId)?.mass || igniteDefinitionFor(prop?.assetId)?.what || ''
      const cell = hazardPropCells(prop)[0] ?? null
      return [{
        id,
        name: clean(name, 80),
        state: clean(state?.mechanics?.scene_interactions?.[id]?.state || prop?.state, 40) || 'idle',
        verbs,
        at: cell,
        distance_feet: at && cell ? Math.max(Math.abs(cell.x - at.x), Math.abs(cell.y - at.y)) * 5 : null,
      }]
    })
    // Ближнее — первым: досягаемость всё равно проверит движок, но выбирать
    // модели проще из упорядоченного списка, а порядок обязан быть устойчивым.
    .sort((left, right) => (left.distance_feet ?? 10_000) - (right.distance_feet ?? 10_000) || left.id.localeCompare(right.id))
    .slice(0, 12)
}

function economyBrief(state, actorId) {
  const combat = state?.mechanics?.combat
  if (!combat?.active) return { in_combat: false }
  const economy = combat.action_economy?.[String(actorId)] ?? {}
  return {
    in_combat: true,
    round: Number(combat.round) || 1,
    action_available: economy.action !== false,
    bonus_action_available: economy.bonus_action !== false,
    movement_spent_feet: Number(economy.movement_spent) || 0,
  }
}

function questionActionText(question) {
  return clean(question, 1_000)
    .replace(/^(?:а\s+если|если|можно\s+ли|могу\s+ли|что\s+если|что\s+будет\s*,?\s*если)\s+(?:(?:мне|я)\s+)?/iu, '')
    .replace(/^открыть\s+/iu, 'Открываю ')
    .replace(/^закрыть\s+/iu, 'Закрываю ')
    .replace(/^подойти\s+/iu, 'Подхожу ')
    .replace(/(?<![\p{L}\p{M}])врежусь(?![\p{L}\p{M}])/iu, 'врезаюсь')
    .replace(/[?]+$/u, '')
}

function directContactQuestion(state, actorId, text) {
  const reading = bindFreeActionReadingToState(state, actorId, text, interpretFreeAction(text))
  if (/(?<![\p{L}\p{M}])не\s+(?:сяду|сажусь|врежусь|врезаюсь|касаюсь|наступаю|трогаю)(?![\p{L}\p{M}])/iu.test(text)) {
    return {
      reading,
      narration: 'Если герой не касается опасности, этот вопрос не выполняет контакт и не наносит урон. Сейчас это только вопрос.',
    }
  }
  const contact = resolveHazardContact(state, actorId, text, reading)
  if (!contact || !['contact', 'unavailable'].includes(contact.status)) return null
  if (contact.status === 'unavailable') {
    return { reading, narration: `${contact.reason} Сейчас это только вопрос: урон не применяется.` }
  }
  const wall = String(contact.source?.kind ?? '').startsWith('wall-')
  const damageLabel = contact.damage_type === 'fire'
    ? 'огненный'
    : contact.damage_type === 'bludgeoning' ? 'дробящий' : 'соответствующий'
  const burnNote = contact.damage_type === 'fire' ? ' Акробатика не отменяет ожог.' : ''
  return {
    reading,
    narration: `${wall ? 'При ударе о стену' : 'При прямом контакте с этой опасностью'} герой получит ${damageLabel} урон.${burnNote} Сейчас это только вопрос: действие не выполнено.`,
  }
}

export function adjudicationBrief(state, actorId, text, dialogue = {}) {
  return {
    player_action: clean(text, 1_000),
    ...(dialogue.recent?.length || dialogue.action ? { dialogue: {
      request_kind: dialogue.request_kind ?? 'action',
      action: clean(dialogue.action, 1_000),
      recent: (dialogue.recent ?? []).slice(-6).map(entry => ({ question: clean(entry.question, 500), answer: clean(entry.answer, 800) })),
    } } : {}),
    hero: heroBrief(state, actorId),
    scene: {
      title: clean(state?.scene?.title, 120),
      location: clean(state?.scene?.location, 120),
      mood: clean(state?.scene?.mood, 160),
      objective: clean(state?.scene?.objective, 160),
    },
    participants: participantsBrief(state, actorId),
    scene_props: scenePropsBrief(state, actorId),
    turn_economy: economyBrief(state, actorId),
    allowed: {
      effects: [...IMPROVISED_EFFECT_IDS],
      hazards: [...ENVIRONMENT_HAZARD_IDS],
      proficiency_levels: [...FREE_ACTION_PROFICIENCY_LEVELS],
      consequence_types: [...FREE_ACTION_CONSEQUENCE_TYPES],
      activity_kinds: [...FREE_ACTION_ACTIVITY_KINDS],
      duration_classes: [...FREE_ACTION_DURATION_CLASSES],
    },
  }
}

export class ActionAdjudicator {
  constructor({ llmClient = null, timeoutMs = 9_000 } = {}) {
    this.llmClient = llmClient
    this.timeoutMs = timeoutMs
  }

  /**
   * Возвращает прочтение задумки. Никогда не бросает: отказ модели — это
   * возврат к детерминированной таблице, а не сломанный ход.
   */
  async read(state, actorId, text, fallbackReading, dialogue = {}) {
    const harmless = harmlessFreeActionReading(state, actorId, text)
    if (harmless) return bindFreeActionReadingToState(state, actorId, text, harmless)
    if (!this.llmClient?.completeJson) return bindFreeActionReadingToState(state, actorId, text, fallbackReading)
    try {
      const result = await this.llmClient.completeJson({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: buildDataOnlyContext({ free_action_brief: adjudicationBrief(state, actorId, text, dialogue) }) },
        ],
        temperature: 0.2,
        maxTokens: 700,
      }, { timeoutMs: this.timeoutMs })
      const reading = normalizeFreeActionReading({ ...result, source: 'agent-adjudicator' }, text)
      // Модель могла назвать эффект, которого нет в каталоге. Оставлять такой
      // ключ нельзя: дальше он всё равно превратится в «ничего не произошло»,
      // но в трассе выглядел бы как решение агента.
      if (!IMPROVISED_EFFECT_IDS.includes(reading.effect)) reading.effect = 'none'
      if (reading.hazard && !ENVIRONMENT_HAZARD_IDS.includes(reading.hazard)) reading.hazard = ''
      const participantIds = new Set(participantsBrief(state, actorId).map((entry) => entry.id))
      if (reading.effect_target && !participantIds.has(reading.effect_target)) reading.effect_target = ''
      // Предмет обстановки — только из переданного списка и только с тем
      // глаголом, который у него действительно есть. Иначе «поджигаю бочку с
      // порохом» превратилось бы в поджог придуманной бочки.
      const propsById = new Map(scenePropsBrief(state, actorId).map((entry) => [entry.id, entry]))
      const propIntent = scenePropIntentFor(reading.effect)
      const namedProp = propsById.get(reading.prop_id) ?? null
      if (!namedProp || !propIntent || !namedProp.verbs.includes(propIntent)) reading.prop_id = ''
      if (propIntent && !reading.prop_id) reading.effect = 'none'
      return bindFreeActionReadingToState(state, actorId, text, reading)
    } catch {
      return bindFreeActionReadingToState(state, actorId, text, {
        ...fallbackReading,
        source: `${fallbackReading.source}-after-agent-error`,
      })
    }
  }

  /** Обсуждение способа использует тот же арбитраж, но не исполняет команды. */
  async discuss(state, actorId, question, { action = '', recent = [], check = null } = {}) {
    if (check) {
      const proposal = check.proposal
      const terms = proposal ? ` Цена попытки: ${clean(proposal.cost, 240)}. При успехе: ${clean(proposal.on_success, 400)} При провале: ${clean(proposal.on_failure, 400)}` : ''
      return { narration: `${explainActionCheck(check)} Текущее предложение: ${check.label}, СЛ ${check.difficulty}.${terms} Способ можно изменить до броска.` }
    }
    const hypothetical = questionActionText(question)
    const exploration = resolveExplorationCommand(state, actorId, hypothetical)
    if (exploration) return { narration: exploration.status === 'command'
      ? `${exploration.narration} Можно выполнить: «${hypothetical}». Подтвердите этот способ или измените его; пока ничего не выполнено.`
      : exploration.narration,
      ...(exploration.status === 'command' ? { proposed_action: hypothetical } : {}),
    }
    const directContact = directContactQuestion(state, actorId, hypothetical)
    if (directContact) return directContact
    const fallback = interpretFreeAction(question)
    const reading = await this.read(state, actorId, question, fallback, { action, recent, request_kind: 'question' })
    const means = verifyMeans(state, actorId, reading.required_means)
    if (!means.satisfied) return { narration: `Для этого способа пока не подтверждены средства: ${means.missing.join(', ')}. Можно выбрать имеющуюся вещь или описать другой способ. Вопрос ничего не расходует.`, reading }
    const resolution = contextualResolutionFor(state, actorId, reading, question)
    if (resolution.mode === 'counter_offer') return { narration: 'Обычной проверки здесь недостаточно: назовите заклинание, предмет или способность, которые дают нужную возможность. После этого можно обсудить безопасный способ.', reading }
    const uncertain = String(reading.source).startsWith('deterministic-default') && !hasRecognizedFreeActionApproach(question)
    if (uncertain) {
      const props = scenePropsBrief(state, actorId).slice(0, 3).map(prop => prop.name).join(', ')
      return { narration: `Чтобы оценить этот вариант, уточним, чем герой действует и какой результат ему нужен.${action ? ` Сохраняю исходную заявку: «${clean(action, 300)}».` : ''}${props ? ` Из доступной обстановки можно использовать: ${props}.` : ''} Вопрос ничего не расходует.`, reading }
    }
    const label = d20CheckLabel({ kind: 'check', ability: reading.ability, skill: reading.skill })
    return {
      narration: resolution.mode === 'auto_success'
        ? 'Если речь только о безопасном жесте с имеющейся вещью, он удаётся без броска. Если вы хотите изменить обстановку или повлиять на кого-то, назовите эту цель отдельно.'
        : `${explainActionCheck(reading)} Предварительно подходит ${label}. До действия проверим цель, средства и условия; затем вы увидите ставку и сможете согласиться или изменить способ.`,
      reading,
    }
  }
}
