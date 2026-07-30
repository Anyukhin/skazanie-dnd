import { interpretResolvedPartyDecision } from './scene-architect.mjs'
import { knownWorldLore, retrieveKnownWorldMemory, worldMemoryForViewer } from './world-memory.mjs'
import { campaignConceptForAgent } from './agent-context.mjs'

/**
 * Роли и — только там, где роль действительно исполняет модель — версионированный
 * контракт промпта. Роль без `prompt_id` исполняется детерминированно, кодом:
 * `worldkeeper` — это `answerKnownLore` ниже, `game_master` — Rules Engine.
 * Промпты для них удалены 2026-07-26, потому что их никто не загружал.
 */
export const AGENT_ROLES = Object.freeze({
  worldkeeper: { id: 'worldkeeper', purpose: 'Лор, память мира и знания героя' },
  director: { id: 'director', prompt_id: 'director/v1', purpose: 'Темп, развилки, групповые решения и переходы сцен' },
  game_master: { id: 'game_master', purpose: 'Правила, проверки, кубики и игровые инструменты' },
  narrator: { id: 'narrator', prompt_id: 'narrator/v4', purpose: 'Финальное повествование из подтверждённых результатов' },
  map_architect: { id: 'map_architect', prompt_id: 'map_architect/v3', purpose: 'Динамическая архитектура новой локации и игровой карты' },
  action_adjudicator: { id: 'action_adjudicator', prompt_id: 'action_adjudicator/v1', purpose: 'Разбор свободного действия: чем судить задумку и чего она стоит' },
})

const LORE_REQUEST = /(?:лор|легенд|предани|истори[яию]|что\s+(?:я|мы)\s+зна|кто\s+так|что\s+так|расскажи\s+(?:мне\s+)?(?:о|об|про)|помню\s+ли)/iu
const DIRECTOR_REQUEST = /(?:покида|уходим|маршрут|куда\s+дальше|голосован|вместе\s+реш|цель\s+достиг|следующ\w*\s+локац|\[РЕШЕНИЕ ГРУППЫ\])/iu
const DIRECTION_REQUEST = /(?:куда\s+(?:нам\s+)?(?:идти|пойти|уходить|направляться|двигаться)(?:\s+дальше|\s+отсюда|\s+по\s+заданию)?|куда\s+по\s+заданию|что\s+делать\s+дальше)/iu
const FATE_REQUEST = /(?:пусть|пускай|давайте|может)\s+(?:решит|определит|бросим)\s+(?:кубик|кость)|кубик\s+судьбы/iu
const RULES_REQUEST = /(?:правил|можно\s+ли|провер|брос|куб|атак|урон|заклин|спасброс|инициатив|класс\s+брони)/iu
const EXIT_REQUEST = /(?:предлагаю\s+)?(?:покинуть|уйти\s+из|выбраться\s+из|уходим\s+из)\s+(?:этого\s+)?(?:подземель\w*|локац\w*|мест\w*|город\w*|деревн\w*|лес\w*|чащ\w*|порт\w*|замок\w*|лагер\w*|храм\w*|пещер\w*|руин\w*|архив\w*|здани\w*|район\w*|улиц\w*)/iu

export function selectAgentRole(action) {
  const text = String(action || '').normalize('NFKC')
  if (DIRECTOR_REQUEST.test(text) || FATE_REQUEST.test(text)) return 'director'
  if (LORE_REQUEST.test(text)) return 'worldkeeper'
  if (RULES_REQUEST.test(text)) return 'game_master'
  return 'director'
}

export function roleAllowsWorldTools(role) {
  return role !== 'worldkeeper'
}

export function proposeAgentInteraction(action, state = {}) {
  const text = String(action || '').normalize('NFKC')
  if (!text || /^\s*\[РЕШЕНИЕ ГРУППЫ\]/iu.test(text) || state.agentInteraction) return null
  if (FATE_REQUEST.test(text)) {
    return {
      type: 'roll',
      title: 'Кубик решает путь отряда',
      description: 'Рассказчик предлагает доверить развилку общему серверному d20. Этот бросок не расходует действие героя.',
      options: ['Отряд идёт дальше', 'Отряд остаётся и ищет другой путь'],
      difficulty: 11,
      resolutionPrompt: 'Продолжи историю по результату общего броска и при уходе открой следующую сцену.',
    }
  }
  if (EXIT_REQUEST.test(text)) {
    const destination = text.match(/(?:отправиться|пойти|идти|направиться)\s+(?:в|на|к)\s+([^,.!?;:]+)/iu)?.[1]
      ?.replace(/\s+/gu, ' ').trim().slice(0, 120)
    const knownFrom = String(state.scene?.location || state.scene?.title || '').replace(/\s+/gu, ' ').trim().slice(0, 120)
    const from = knownFrom || 'подземелья'
    const leaveOption = destination
      ? knownFrom ? `Уходим из «${from}» и идём в ${destination}` : `Уходим из подземелья и идём в ${destination}`
      : knownFrom ? `Покинуть «${from}»` : 'Покинуть подземелье'
    return {
      type: 'vote',
      title: knownFrom ? `Покинуть «${from}»?` : 'Покинуть подземелье?',
      description: 'Маршрут меняет судьбу всей группы, поэтому Режиссёр просит большинство героев принять решение вместе.',
      options: [leaveOption, 'Остаться и исследовать дальше'],
      resolutionPrompt: 'Исполни решение большинства. Если отряд уходит, бесшовно открой следующую локацию.',
    }
  }
  return null
}

export function answerKnownLore(action, state = {}, options = {}) {
  const asksDirection = DIRECTION_REQUEST.test(String(action || '').normalize('NFKC'))
  if (!asksDirection && selectAgentRole(action) !== 'worldkeeper') return null
  const adventure = state.adventure ?? {}
  const campaignPremise = campaignConceptForAgent(state)
  const scene = state.scene ?? {}
  const visibleMemory = options.viewer
    ? worldMemoryForViewer(state.worldMemory, options.viewer)
    : state.worldMemory
  const worldFacts = options.viewer
    ? retrieveKnownWorldMemory(state.worldMemory, {
        viewer: options.viewer,
        query: action,
        atMinutes: state.mechanics?.world_time?.elapsed_minutes,
      })
    : knownWorldLore(visibleMemory, action)
  const activeQuest = (visibleMemory?.quests ?? []).find((quest) => quest?.status === 'active')
  const questObjective = activeQuest?.objectives?.[0] || activeQuest?.summary || ''
  if (asksDirection) {
    const location = String(scene.location || scene.title || 'текущая локация')
    const objective = String(scene.objective || adventure.currentHook || questObjective || '').trim()
    const hasNamedDestination = /(?:отправиться|путь|дорога|маршрут|следовать|идти)\s+(?:в|на|к)\s+[^,.!?;:]+/iu.test(objective)
    const narration = hasNamedDestination
      ? `Из подтверждённых сведений направление связано с текущей задачей: ${objective}. Сейчас отряд находится здесь: ${location}.`
      : `Подтверждённый пункт назначения пока не открыт. Текущая задача: ${objective || 'исследовать обстановку и найти новую зацепку'}. Отряд находится здесь: ${location}. Сначала нужно осмотреть место, поговорить со свидетелями или найти запись, которая откроет конкретный маршрут.`
    return {
      narration,
      effects: { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null },
      provider: 'AgentWorldkeeper',
      agent_context: { campaign_premise: campaignPremise },
      model: 'campaign-memory',
      turn_consumed: false,
      action_kind: 'free',
    }
  }
  const facts = []
  for (const fact of worldFacts) {
    const subject = fact.entity?.name ? `${fact.entity.name}: ` : ''
    facts.push(subject + String(fact.summary || fact.object || fact.predicate))
  }
  if (activeQuest?.title) facts.push(`Active quest "${activeQuest.title}": ${questObjective || 'objective pending'}`)
  if (adventure.currentHook) facts.push(String(adventure.currentHook))
  if (scene.objective) facts.push('Сейчас с этим связана цель: ' + String(scene.objective))
  const history = Array.isArray(adventure.history) ? adventure.history.slice(-3) : []
  for (const chapter of history) {
    if (chapter?.outcome) facts.push(String(chapter.outcome))
  }
  const visited = Array.isArray(adventure.visitedLocations) ? adventure.visitedLocations.filter(Boolean).slice(-4) : []
  if (visited.length) facts.push('Отряд уже бывал здесь: ' + visited.join(', '))
  const narration = facts.length
    ? 'Из того, что уже известно героям: ' + [...new Set(facts)].join('. ') + '. Скрытых сведений сверх этой памяти у героя пока нет.'
    : 'В общей памяти отряда пока нет подтверждённых сведений об этом. Герой может расспросить свидетеля, изучить записи или исследовать место — сам вопрос не расходует ход.'
  return {
    narration,
    effects: { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null },
    provider: 'AgentWorldkeeper',
    agent_context: { campaign_premise: campaignPremise },
    model: 'campaign-memory',
    turn_consumed: false,
    action_kind: 'free',
  }
}


function resolvePartyDecisionLegacy(action, state = {}) {
  const text = String(action || '').normalize('NFKC')
  if (!/^\s*\[\u0420\u0415\u0428\u0415\u041D\u0418\u0415 \u0413\u0420\u0423\u041F\u041F\u042B\]/iu.test(text)) return null
  const card = state.agentInteraction ?? {}
  const selected = Array.isArray(card.options) ? card.options.find((item) => item?.id === card.resolvedOptionId)?.label : ''
  const decision = String(selected || text)
  if (!/(?:\u043F\u043E\u043A\u0438\u043D\u0443\u0442\u044C|\u0443\u0439\u0442\u0438|\u0438\u0434[\u0451\u0435]\u0442\s+\u0434\u0430\u043B\u044C\u0448\u0435|\u0432\u044B\u0431\u0440\u0430\u0442\u044C\u0441\u044F)/iu.test(decision)) {
    return { type: 'narration', narration: '\u0413\u0440\u0443\u043F\u043F\u0430 \u043F\u0440\u0438\u043D\u044F\u043B\u0430 \u0440\u0435\u0448\u0435\u043D\u0438\u0435: ' + decision + '.' }
  }
  const from = String(state.scene?.location || state.scene?.title || '\u043F\u043E\u0434\u0437\u0435\u043C\u0435\u043B\u044C\u044F')
  const chapter = Math.max(1, Number(state.adventure?.chapter) || 1) + 1
  return { type: 'scene', sceneArgs: {
    title: '\u0413\u043B\u0430\u0432\u0430 ' + chapter + ' \u00B7 \u0417\u0430 \u043F\u0440\u0435\u0434\u0435\u043B\u0430\u043C\u0438 \u043F\u043E\u0434\u0437\u0435\u043C\u0435\u043B\u044C\u044F',
    location: '\u0422\u0440\u043E\u043F\u0430 \u043F\u043E\u0434 \u043F\u0435\u043F\u0435\u043B\u044C\u043D\u044B\u043C \u043D\u0435\u0431\u043E\u043C',
    objective: '\u041F\u043E\u043D\u044F\u0442\u044C, \u043A\u0443\u0434\u0430 \u0432\u0435\u0434\u0443\u0442 \u0441\u0432\u0435\u0436\u0438\u0435 \u0441\u043B\u0435\u0434\u044B',
    transition: '\u041F\u043E \u0440\u0435\u0448\u0435\u043D\u0438\u044E \u0433\u0440\u0443\u043F\u043F\u044B \u0433\u0435\u0440\u043E\u0438 \u043F\u043E\u043A\u0438\u0434\u0430\u044E\u0442 \u00AB' + from + '\u00BB, \u0430 \u043A\u0430\u0440\u0442\u0430 \u0440\u0430\u0441\u0442\u0432\u043E\u0440\u044F\u0435\u0442\u0441\u044F \u0432 \u043D\u043E\u0432\u043E\u043C \u043C\u0430\u0440\u0448\u0440\u0443\u0442\u0435.',
    arrival: '\u0417\u0430 \u0432\u043E\u0440\u043E\u0442\u0430\u043C\u0438 \u043E\u0442\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u043F\u0435\u043F\u0435\u043B\u044C\u043D\u0430\u044F \u0442\u0440\u043E\u043F\u0430 \u0441 \u043D\u0435\u0447\u0435\u043B\u043E\u0432\u0435\u0447\u0435\u0441\u043A\u0438\u043C\u0438 \u0441\u043B\u0435\u0434\u0430\u043C\u0438.',
    hook: '\u0421\u043B\u0435\u0434\u044B \u0432\u0435\u0434\u0443\u0442 \u043A \u043E\u0433\u043D\u044F\u043C \u043D\u0430 \u0433\u043E\u0440\u0438\u0437\u043E\u043D\u0442\u0435', theme: '\u0434\u043E\u0440\u043E\u0433\u0430', danger: '\u0441\u0440\u0435\u0434\u043D\u044F\u044F',
    outcome: '\u041E\u0442\u0440\u044F\u0434 \u043F\u043E\u043A\u0438\u043D\u0443\u043B \u00AB' + from + '\u00BB \u043F\u043E \u0440\u0435\u0448\u0435\u043D\u0438\u044E \u0431\u043E\u043B\u044C\u0448\u0438\u043D\u0441\u0442\u0432\u0430.',
  } }
}

export function resolvePartyDecision(action, state = {}) {
  const interpretation = interpretResolvedPartyDecision(action, state)
  if (!interpretation) return null
  if (interpretation.kind === 'move') {
    return { type: 'scene_request', decision: interpretation.decision, destinationHint: interpretation.destinationHint }
  }
  if (interpretation.kind === 'stay') {
    const direction = String(state.adventure?.currentHook || state.scene?.objective || 'неисследованный проход').replace(/\s+/g, ' ').trim().slice(0, 160)
    return {
      type: 'narration',
      narration: `Остаться в текущей локации — решение группы. Конкретное направление исследования: ${direction}.`,
    }
  }
  return {
    type: 'narration',
    narration: `Группа приняла решение: ${interpretation.decision}.`,
  }
}
