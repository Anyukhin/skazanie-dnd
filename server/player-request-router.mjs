import { interpretResolvedPartyDecision } from './scene-architect.mjs'
import { abandonableQuest, detectPartyExitRequest, exitContextFromState, travelDestinationIsPlace } from './party-exit-intent.mjs'
import { knownWorldLore, retrieveKnownWorldMemory, worldMemoryForViewer } from './world-memory.mjs'
import { campaignConceptForAgent } from './agent-context.mjs'
import { isSceneObservationRequest } from './intent-parser.mjs'
import { sceneObjectLabelFor } from './scene-interactions.mjs'

/**
 * Роли и — только там, где роль действительно исполняет модель — версионированный
 * контракт промпта. Роль без `prompt_id` исполняется детерминированно, кодом:
 * `worldkeeper` — это `answerKnownLore` ниже, `game_master` — Rules Engine.
 * Промпты для них удалены 2026-07-26, потому что их никто не загружал.
 *
 * `prompt_id` — строка либо список, если у роли есть варианты контракта. У
 * Режиссёра их два: вариант выбирается режимом импровизации кампании
 * (`improv_mode`) в момент вызова, а не импортом, поэтому одной строкой роль
 * описать нельзя.
 */
export const PLAYER_REQUEST_ROLES = Object.freeze({
  worldkeeper: { id: 'worldkeeper', purpose: 'Лор, память мира и знания героя' },
  director: { id: 'director', prompt_id: ['director/v4_story', 'director/v4_chaos'], purpose: 'Темп, развилки, групповые решения и переходы сцен' },
  game_master: { id: 'game_master', purpose: 'Правила, проверки, кубики и игровые инструменты' },
  narrator: { id: 'narrator', prompt_id: 'narrator/v11', purpose: 'Финальное повествование из подтверждённых результатов' },
  map_architect: { id: 'map_architect', prompt_id: 'map_architect/v6', purpose: 'Динамическая архитектура новой локации и игровой карты' },
  action_adjudicator: { id: 'action_adjudicator', prompt_id: 'action_adjudicator/v8', purpose: 'Разбор свободного действия: маршрут заявки, цель, средство, применимый навык и цена провала' },
})

const LORE_REQUEST = /(?:лор|легенд|предани|истори[яию]|что\s+(?:я|мы)\s+(?:уже\s+|вообще\s+)?зна|кто\s+так|что\s+так|расскажи\s+(?:мне\s+)?(?:о|об|про)|помню\s+ли)/iu
const DIRECTOR_REQUEST = /(?:покида|уходим|маршрут|куда\s+дальше|голосован|вместе\s+реш|цель\s+достиг|следующ\w*\s+локац|\[РЕШЕНИЕ ГРУППЫ\]|\[ГЛОБАЛЬНАЯ КАРТА\])/iu
const DIRECTION_REQUEST = /(?:куда\s+(?:нам\s+)?(?:идти|пойти|уходить|направляться|двигаться)(?:\s+дальше|\s+отсюда|\s+по\s+заданию)?|куда\s+по\s+заданию|что\s+делать\s+дальше|^(?:(?:а|и|ну)\s+)*что\s+(?:теперь|дальше)\s*\??$)/iu
const FATE_REQUEST = /(?:пусть|пускай|давайте|может)\s+(?:решит|определит|бросим)\s+(?:кубик|кость)|кубик\s+судьбы/iu
const RULES_REQUEST = /(?:правил|можно\s+ли|провер|брос|куб|атак|урон|заклин|спасброс|инициатив|класс\s+брони)/iu
// «Рассказываю Марте свою историю» — реплика собеседнику, а не вопрос о лоре,
// хотя слово «история» в ней есть.
const NPC_SPEECH_REQUEST = /(?<![\p{L}\p{M}])(?:спрашиваю|спросим|расспрашиваю|расспросим|говорю|говорим|обращаюсь|обращаемся|прошу|просим|рассказываю|рассказываем|разговариваю|беседую|узнаю\s+у|интересуюсь\s+у)(?![\p{L}\p{M}])/iu
const VISIBLE_SCENE_LIMIT = 8

const visibleText = (value, maximum = 160) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
/** Законченное предложение без двойной точки: «…у мытни.. В видимой части». */
const asSentence = (value, maximum = 400) => {
  const text = visibleText(value, maximum).replace(/[\s.!?…;,:]+$/u, '')
  return text ? `${text.charAt(0).toLocaleUpperCase('ru')}${text.slice(1)}.` : ''
}

/**
 * NPC, которых герой видит в текущей сцене. `scene_npcs` — проекция
 * присутствующих; профиль из `social.npcs` даёт роль и открытое описание,
 * только если он открыт отряду и стоит в этом же месте.
 */
function presentSceneNpcs(state = {}) {
  const location = visibleText(state.scene?.location, 160).toLocaleLowerCase('ru')
  const profiles = (Array.isArray(state.social?.npcs) ? state.social.npcs : [])
    .filter((npc) => ['party', 'public'].includes(String(npc?.visibility ?? 'party')) && npc?.available !== false)
  const present = Array.isArray(state.scene_npcs)
    ? state.scene_npcs.filter((npc) => npc?.alive !== false)
    : []
  const byId = new Map(profiles.map((npc) => [String(npc.id), npc]))
  const fromScene = present.map((npc) => ({ ...byId.get(String(npc.id)), ...npc, public_summary: byId.get(String(npc.id))?.public_summary ?? '' }))
  const sceneIds = new Set(fromScene.map((npc) => String(npc.id)))
  const fromProfiles = profiles.filter((npc) => !sceneIds.has(String(npc.id))
    && location && visibleText(npc.location, 160).toLocaleLowerCase('ru') === location)
  return [...fromScene, ...fromProfiles].filter((npc) => visibleText(npc?.name, 80))
}

const RU_WORD_STEM = (word) => String(word ?? '').toLocaleLowerCase('ru').replace(/ё/gu, 'е').slice(0, Math.max(3, Math.min(5, String(word ?? '').length - 1)))

function mentionedNpc(text, npcs) {
  const words = String(text ?? '').toLocaleLowerCase('ru').replace(/ё/gu, 'е').split(/[^\p{L}-]+/u).filter((word) => word.length >= 3)
  const scored = npcs.map((npc) => {
    const parts = visibleText(npc.name, 80).split(/\s+/u).filter((part) => part.length >= 3)
    const hits = parts.filter((part) => words.some((word) => word.startsWith(RU_WORD_STEM(part)))).length
    return { npc, hits }
  }).filter((entry) => entry.hits > 0).sort((left, right) => right.hits - left.hits)
  return scored[0]?.npc ?? null
}

const NPC_WHO_QUESTION = /^(?:а\s+|и\s+|ну\s+)?кто\s+(?:так(?:ой|ая|ие)|это|она|он)(?![\p{L}\p{M}])/iu
const WEATHER_QUESTION = /(?<![\p{L}\p{M}])(?:погод\p{L}*|дожд\p{L}*\s+(?:ли|ещ[её])|небо|ветер|холодно|тепло|жарко)(?![\p{L}\p{M}])/iu
const TIME_QUESTION = /(?<![\p{L}\p{M}])(?:который\s+час|сколько\s+(?:сейчас\s+)?времени|какое\s+(?:сейчас\s+)?время|время\s+суток|сейчас\s+(?:утро|день|вечер|ночь)|какой\s+(?:сейчас\s+)?день)(?![\p{L}\p{M}])/iu
const PRESENCE_QUESTION = /^(?:а\s+|и\s+|ну\s+)?(?:есть\s+ли\s+(?:тут|здесь|рядом)?|тут\s+есть|здесь\s+есть|где\s+(?:тут|здесь)\s+(?:можно|есть))\s*(.*)$/iu
const HYPOTHETICAL_QUESTION = /^(?:а\s+)?(?:что\s+(?:будет|если|случится)|а\s+если|можно\s+ли|могу\s+ли|сможет\s+ли|если\s+я|если\s+мы|получится\s+ли|выйдет\s+ли|как\s+(?:мне|нам)\s+)/iu

/**
 * Вопрос ведущему за столом, который не является заявкой: погода, час, «кто
 * это», «есть ли тут стража», «сколько стоит переправа». Живой мастер
 * отвечает на него сразу и не превращает его в проверку. Отвечаем только тем,
 * что отряду известно; чего нет в памяти — честно «не знаете» и подсказка,
 * у кого из присутствующих спросить. Модель не зовётся.
 *
 * @param {string} action
 * @param {Record<string, any>} state
 * @param {{ actorId?: string, worldClock?: any }} [options]
 */
export function answerTableQuestion(action, state = {}, { actorId = '', worldClock = null } = {}) {
  const text = visibleText(action, 400)
  if (!text || HYPOTHETICAL_QUESTION.test(text)) return null
  const reply = (narration, model) => ({
    narration,
    effects: { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null },
    provider: 'AgentWorldkeeper', model, turn_consumed: false, action_kind: 'free',
  })
  const npcs = presentSceneNpcs(state)
  if (NPC_WHO_QUESTION.test(text)) {
    const npc = mentionedNpc(text, npcs)
    if (npc) {
      const role = visibleText(npc.role, 120)
      const summary = asSentence(npc.public_summary, 300)
      return reply([`${visibleText(npc.name, 80)}${role ? ` — ${role.charAt(0).toLocaleLowerCase('ru')}${role.slice(1)}` : ''}.`, summary].filter(Boolean).join(' '), 'npc-public-profile')
    }
  }
  const clock = worldClock
  if (clock && (TIME_QUESTION.test(text) || WEATHER_QUESTION.test(text))) {
    const parts = []
    if (TIME_QUESTION.test(text)) parts.push(`Сейчас ${visibleText(clock.time_of_day_label, 40).toLocaleLowerCase('ru') || 'день'}, около ${visibleText(clock.clock, 10)}.`)
    if (WEATHER_QUESTION.test(text)) {
      parts.push(clock.indoors
        ? `Вы под крышей; снаружи — ${visibleText(clock.weather_label, 60).toLocaleLowerCase('ru')}.`
        : asSentence(clock.weather_summary || clock.weather_label, 200))
    }
    return reply(parts.filter(Boolean).join(' '), 'world-clock')
  }
  const presence = PRESENCE_QUESTION.exec(text)
  const subject = visibleText(presence?.[1] ?? '', 120).replace(/[?!.]+$/u, '')
  const informed = npcs.filter((npc) => visibleText(npc.role, 120))
  // Имя в именительном падеже: склонять чужие имена сервер не умеет, а «у
  // Клара Вельм» режет слух сильнее, чем перечисление.
  const askWho = informed.length
    ? ` Знать могут здесь: ${informed.slice(0, 2).map((npc) => `${visibleText(npc.name, 80)} — ${visibleText(npc.role, 80).toLocaleLowerCase('ru')}`).join('; ')}.`
    : ' Можно осмотреться или расспросить местных.'
  if (presence && subject) {
    const mentioned = npcs.find((npc) => RU_WORD_STEM(subject) && visibleText(`${npc.role} ${npc.name}`, 200).toLocaleLowerCase('ru').replace(/ё/gu, 'е').includes(RU_WORD_STEM(subject)))
    if (mentioned) return reply(`Да: ${visibleText(mentioned.name, 80)} — ${visibleText(mentioned.role, 120).toLocaleLowerCase('ru')}.`, 'visible-scene')
    return reply(`Пока на глаза не попадается.${askWho}`, 'visible-scene')
  }
  if (/\?\s*$/u.test(text) || /^(?:а\s+)?(?:сколько|где|когда|куда|откуда|какой|какая|какое|какие|кто|что|почему|зачем)(?![\p{L}\p{M}])/iu.test(text)) {
    return reply(`Этого вы пока не знаете.${askWho}`, 'unknown-to-party')
  }
  return null
}

function visibleSceneActorLabels(state = {}) {
  const actors = [
    ...(Array.isArray(state.scene_npcs) ? state.scene_npcs : []),
    ...(Array.isArray(state.enemies) ? state.enemies : []),
  ]
  const labels = []
  for (const actor of actors) {
    if (actor?.alive === false) continue
    const name = visibleText(actor?.name ?? actor?.character, 80)
    if (!name) continue
    const role = visibleText(actor?.role, 60)
    const label = role ? `${name} — ${role.charAt(0).toLocaleLowerCase('ru')}${role.slice(1)}` : name
    if (!labels.includes(label)) labels.push(label)
    if (labels.length >= VISIBLE_SCENE_LIMIT) break
  }
  return labels
}

function visibleScenePropLabels(state = {}) {
  const props = Array.isArray(state?.scene?.map?.props) ? state.scene.map.props : []
  const ranked = props.flatMap((prop, index) => {
    if (['broken', 'destroyed'].includes(String(prop?.state ?? ''))) return []
    const label = visibleText(sceneObjectLabelFor(prop?.assetId), 60)
    return label ? [{ label, pointOfInterest: prop?.interaction?.pointOfInterest === true, index }] : []
  }).sort((left, right) => Number(right.pointOfInterest) - Number(left.pointOfInterest) || left.index - right.index)
  const labels = []
  for (const entry of ranked) {
    if (labels.includes(entry.label)) continue
    labels.push(entry.label)
    if (labels.length >= VISIBLE_SCENE_LIMIT) break
  }
  return labels
}

/**
 * Ответ на вопрос о видимой части текущей сцены.
 *
 * `state` здесь уже должен быть viewer-проекцией: карта оставляет только
 * раскрытые предметы, а `scene_npcs` — только присутствующих видимых NPC.
 * Поэтому helper не читает авторитетную карту, ID или содержимое реквизита.
 */
export function answerVisibleScene(action, state = {}) {
  if (!isSceneObservationRequest(action)) return null
  const locationOnly = /^где\s/iu.test(visibleText(action))
  const scene = state.scene ?? {}
  const location = visibleText(scene.location || scene.title, 160)
  const title = visibleText(scene.title, 160)
  const mood = visibleText(scene.mood, 160)
  const actors = visibleSceneActorLabels(state)
  const props = visibleScenePropLabels(state)
  // Ответ ведущего, а не опись: место, его настроение, кто рядом и что вокруг.
  const sentences = []
  if (locationOnly) {
    if (location) sentences.push(`Сейчас вы здесь: ${location}.`)
    else if (title) sentences.push(`Сейчас вы здесь: ${title}.`)
  } else {
    if (location || title) sentences.push(asSentence(location || title))
    if (mood) sentences.push(asSentence(mood, 200))
    if (actors.length) sentences.push(`Рядом ${actors.length === 1 ? 'тот, кого видно сразу' : 'те, кого видно сразу'}: ${actors.join('; ')}.`)
    if (props.length) sentences.push(`Вокруг: ${props.join(', ')}.`)
    if (!actors.length && !props.length) sentences.push('Ничего примечательного на виду нет.')
  }
  if (!sentences.length) sentences.push('Текущее место пока не названо.')
  return {
    narration: sentences.join(' '),
    effects: { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null },
    provider: 'AgentWorldkeeper',
    model: 'visible-scene',
    turn_consumed: false,
    action_kind: 'free',
  }
}

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

/** Подпись варианта голосования обрезается сервером до 100 знаков. */
const PARTY_OPTION_LIMIT = 100

/**
 * Подпись варианта «уйти и бросить задание».
 *
 * Пункт назначения берётся в кавычки намеренно: подпись читает тот же словарь
 * ухода, которым она была предложена, и «Каменный Град» без кавычек местом не
 * опознаётся — в списке мест есть «город», но нет каждого названия мира. При
 * нехватке места режется название задания, а не маршрут: маршрут решает, куда
 * попадёт отряд, а название — только украшение подписи.
 *
 * @param {string} questTitle
 * @param {string} destination
 * @returns {string}
 */
function abandonLabel(questTitle, destination) {
  // Кавычки-ёлочки в подписи значащие: по ним разбирается пункт назначения.
  // Чужая «ёлочка» внутри названия закрыла бы кавычку не там, где нужно.
  const plain = (value) => String(value ?? '').replace(/[«»]/gu, '').trim()
  const place = plain(destination).slice(0, 60)
  const lead = place ? `Уходим в «${place}» и бросаем задание` : 'Уходим отсюда и бросаем задание'
  const room = PARTY_OPTION_LIMIT - lead.length - ' «»'.length
  const title = plain(questTitle)
  const fitted = title.length > room ? `${title.slice(0, Math.max(1, room - 1)).trimEnd()}…` : title
  return `${lead} «${fitted}»`
}

export function proposeAgentInteraction(action, state = {}) {
  const text = String(action || '').normalize('NFKC')
  if (!text || /^\s*\[РЕШЕНИЕ ГРУППЫ\]/iu.test(text) || state.agentInteraction) return null
  if (FATE_REQUEST.test(text)) {
    return {
      type: 'roll',
      title: 'Кубик решает путь отряда',
      description: 'Пусть решает кубик: один d20 на весь отряд, 11 и выше — идёте дальше. Ход героя это не тратит.',
      options: ['Отряд идёт дальше', 'Отряд остаётся и ищет другой путь'],
      difficulty: 11,
      resolutionPrompt: 'Продолжи историю по результату общего броска и при уходе открой следующую сцену.',
    }
  }
  // Индивидуальная фраза о дальнем пути предлагает решение всей группе.
  // Тактическое «подхожу к Мире» сюда не попадает: нужен явно названный путь
  // или сопровождение и пункт назначения, который узнаёт общий словарь мест.
  const accompanied = /^(?:иду|следую|отправляюсь)\s+(?:рядом\s+с|вместе\s+с|за)\s+/iu.test(text)
    && !/не\s+(?:покида|уход|выход)/iu.test(text)
  const destination = accompanied ? /(?:\sк|\sв|\sна)\s+([^,.;!?]+?)(?=\s+(?:и|чтобы|затем)\s|[,.!?;]|$)/iu.exec(text)?.[1] : ''
  // Известные точки карты и имена присутствующих: «Иду в Каменный Град» — уход
  // без родового слова, «иду к Марте» — шаг к собеседнику, а не из сцены.
  const exitContext = exitContextFromState(state)
  const exit = detectPartyExitRequest(text, exitContext)
    ?? (destination ? detectPartyExitRequest(`Отправиться к ${destination}`, exitContext) : null)
  if (exit) {
    const destination = exit.destination
    const knownFrom = String(state.scene?.location || state.scene?.title || '').replace(/\s+/gu, ' ').trim().slice(0, 120)
    const from = knownFrom || 'подземелья'
    const leaveOption = destination
      ? knownFrom ? `Уходим из «${from}» и идём в ${destination}` : `Уходим из подземелья и идём в ${destination}`
      : knownFrom ? `Покинуть «${from}»` : 'Покинуть подземелье'
    // Отказ от задания — третий вариант того же голосования, а не отдельная
    // карточка: уйти, не закрыв нить, и уйти, отказавшись от неё, — это один и
    // тот же разговор за столом, и разводить его на два голосования незачем.
    // Подпись несёт название задания только для игрока; какое задание закрыть,
    // сервер выбирает сам через `abandonableQuest` в момент исполнения.
    const quest = abandonableQuest(state)
    const abandonOption = quest ? abandonLabel(quest.title, destination) : ''
    return {
      type: 'vote',
      title: knownFrom ? `Покинуть «${from}»?` : 'Покинуть подземелье?',
      description: 'Маршрут меняет судьбу всей группы, поэтому Режиссёр просит большинство героев принять решение вместе.',
      options: [leaveOption, ...(abandonOption ? [abandonOption] : []), 'Остаться и исследовать дальше'],
      resolutionPrompt: 'Исполни решение большинства. Если отряд уходит, бесшовно открой следующую локацию.',
      ...(exit.destinationLocationId ? { destinationLocationId: exit.destinationLocationId } : {}),
    }
  }
  return null
}

/**
 * Карточка ухода по маршруту, который назвал судья свободных действий
 * (`route: travel`, контракт action_adjudicator/v7). Модель здесь только
 * подсказала, что заявка — переход; пункт назначения проверяется тем же
 * словарём мест, что и фраза игрока, а карточка — та же, что у узнанной по
 * словам фразы ухода. Отличие одно: и за столом из одного героя открывается
 * голосование, а не мгновенный переход, — решение, понятое моделью, игрок
 * подтверждает сам.
 *
 * @param {{ route?: string, destination?: string }|null} hint
 * @param {Record<string, any>} [state]
 */
export function proposeRoutedTravel(hint, state = {}) {
  if (hint?.route !== 'travel' || state.agentInteraction) return null
  const destination = String(hint.destination ?? '').replace(/[«»]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 80)
  if (!travelDestinationIsPlace(destination, exitContextFromState(state))) return null
  const card = proposeAgentInteraction(destination ? `Отправляемся в «${destination}»` : 'Уходим отсюда', state)
  if (card?.type !== 'vote') return null
  return {
    ...card,
    description: 'Ведущий понял заявку как переход в другое место. Маршрут меняет судьбу всей группы, поэтому его подтверждают голосованием — даже за столом из одного героя.',
  }
}

const OWN_KNOWLEDGE_REQUEST = /(?:что\s+я\s+зна\p{L}*|что\s+я\s+помню|помню\s+ли\s+я)\s+(?:о|об|про)\s+(.+)$/iu

/**
 * «Что я знаю о пропавшем брате?» — ответ из предыстории самого героя.
 * Это знание персонажа, которое игрок сам написал; память мира о нём молчит.
 */
function heroBackstoryAnswer(action, state = {}, actorId = '') {
  const match = OWN_KNOWLEDGE_REQUEST.exec(visibleText(action, 400))
  if (!match) return null
  const hero = (Array.isArray(state.players) ? state.players : []).find((entry) => String(entry?.id) === String(actorId))
  const backstory = visibleText(hero?.backstory, 600)
  if (!hero || !backstory) return null
  const topic = match[1].toLocaleLowerCase('ru').replace(/ё/gu, 'е').split(/[^\p{L}]+/u).filter((word) => word.length >= 4)
  const lowered = backstory.toLocaleLowerCase('ru').replace(/ё/gu, 'е')
  if (!topic.some((word) => lowered.includes(RU_WORD_STEM(word)))) return null
  const name = visibleText(hero.character || hero.name, 80)
  return {
    narration: `${name} знает это по себе: ${backstory.charAt(0).toLocaleLowerCase('ru')}${backstory.slice(1).replace(/[.!?…]+$/u, '')}. Больше ничего наверняка — остальное придётся выяснять здесь.`,
    effects: { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null },
    provider: 'AgentWorldkeeper', model: 'hero-backstory', turn_consumed: false, action_kind: 'free',
  }
}

export function answerKnownLore(action, state = {}, options = {}) {
  const visibleScene = answerVisibleScene(action, state)
  if (visibleScene) return visibleScene
  // Вопрос внутри реплики адресован собеседнику. Даже неизвестный NPC должен
  // пройти обычный разбор с уточнением цели, а не исчезнуть за справкой о мире.
  if (NPC_SPEECH_REQUEST.test(String(action || '').normalize('NFKC'))) return null
  const asksDirection = DIRECTION_REQUEST.test(String(action || '').normalize('NFKC'))
  if (!asksDirection && selectAgentRole(action) !== 'worldkeeper') return null
  // «Кто такая Клара?» — открытый профиль присутствующего, а не свалка памяти.
  const whoAnswer = NPC_WHO_QUESTION.test(visibleText(action, 400)) ? answerTableQuestion(action, state) : null
  if (whoAnswer?.model === 'npc-public-profile') return whoAnswer
  const backstory = heroBackstoryAnswer(action, state, options.viewer?.playerId ?? options.actorId ?? '')
  if (backstory) return backstory
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
      ? `По текущей задаче вам нужно: ${objective}. Сейчас отряд находится здесь: ${location}.`
      : `Пункт назначения пока не открыт. Текущая задача — ${objective || 'исследовать обстановку и найти новую зацепку'}. Сейчас вы здесь: ${location}. Чтобы понять маршрут, осмотритесь, расспросите свидетелей или найдите нужную запись.`
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
  // Сначала то, что отряд нашёл сам, затем остальное известное — коротко:
  // ведущий напоминает суть, а не зачитывает пролог целиком.
  const found = []
  const known = []
  // «Что мы уже знаем?» не называет темы: находки отряда перечисляются все,
  // даже если поиск по словам вопроса ничего не нашёл.
  const discoveries = (visibleMemory?.facts ?? [])
    .filter((fact) => fact?.status !== 'superseded' && ['party', 'public'].includes(String(fact?.visibility)))
    .filter((fact) => fact.predicate === 'discovery')
  for (const fact of [...discoveries, ...worldFacts]) {
    const line = asSentence(fact.fact?.summary || fact.summary || fact.object || fact.predicate, 400)
    if (!line) continue
    if ((fact.fact?.predicate ?? fact.predicate) === 'discovery') found.push(line)
    else if ((fact.fact?.predicate ?? fact.predicate) !== 'opening_narration') known.push(line)
  }
  const goal = asSentence(scene.objective || questObjective, 240)
  const history = (Array.isArray(adventure.history) ? adventure.history.slice(-2) : [])
    .map((chapter) => asSentence(chapter?.outcome, 240)).filter(Boolean)
  const hook = asSentence(adventure.currentHook, 400)
  if (hook) known.unshift(hook)
  const parts = [
    found.length ? `Вы выяснили: ${[...new Set(found)].slice(0, 4).join(' ')}` : '',
    known.length ? `Ещё известно: ${[...new Set(known)].slice(0, 2).join(' ')}` : '',
    history.length ? `Прежде: ${history.join(' ')}` : '',
    goal ? `Цель: ${goal.charAt(0).toLocaleLowerCase('ru')}${goal.slice(1)}` : '',
  ].filter(Boolean)
  const narration = found.length || known.length || history.length
    ? parts.join(' ')
    : `Пока ничего подтверждённого об этом не известно — только то, что вы видели сами.${goal ?` Цель: ${goal.charAt(0).toLocaleLowerCase('ru')}${goal.slice(1)}` : ''} Осмотритесь или расспросите местных.`
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
    return {
      type: 'scene_request',
      decision: interpretation.decision,
      destinationHint: interpretation.destinationHint,
      abandonsQuest: interpretation.abandonsQuest === true,
      ...(interpretation.destinationLocationId ? { destinationLocationId: interpretation.destinationLocationId } : {}),
    }
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
