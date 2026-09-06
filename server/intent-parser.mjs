import { classifyNpcSocialCheck } from './npc-social-check.mjs'

const FREE_ACTION_PATTERNS = Object.freeze([
  ['physically_impossible', /(взлет\w*|взлета\w*|парю\w*|телепорт\w*|останавлива\w*\s+время|дыш\w*\s+под\s+водой|становлюсь\s+невидим\w*|путешеств\w*\s+во\s+времени|fly\b|teleport\w*|stop\s+time|breathe\s+underwater)/iu],
  ['bounded_scene_action', /(подпира\w*|баррикад\w*|поджига\w*|зажига\w*|зову\w*\s+страж|крич\w*\s+страж|связыва\w*|прячу\w*\s+след\w*|заслоня\w*)/iu],
  ['corpse_search', /(?:обыск\p{L}*|провер\p{L}*|осматр\p{L}*|ищ\p{L}*)[^.!?]{0,80}(?:труп|тел[оаеу]|останки|карман)|(?:труп|тел[оаеу]|останки|карман)[^.!?]{0,80}(?:обыск\p{L}*|провер\p{L}*|осматр\p{L}*|ищ\p{L}*)/iu],
])

export const REQUEST_KINDS = Object.freeze(['action', 'question', 'discussion'])

/**
 * Ввод игрока приходит из недоверенного клиента. Режим заявки — это только
 * маршрутизация: он не даёт права выполнить команду и не меняет механику.
 */
export function normalizeRequestKind(value) {
  const kind = String(value ?? '').trim().toLocaleLowerCase('en')
  return REQUEST_KINDS.includes(kind) ? kind : 'action'
}

const DIRECT_QUESTION_PATTERN = /^(?:можно\s+ли|могу\s+ли|есть\s+ли|как\s+далеко|что\s+будет|почему|зачем|где\s+(?:наход|стоит|леж)|кто\s+так|сколько|как\s+(?:это|мне|нам))(?:\s|$)/iu
const PARTY_PROPOSAL_PATTERN = /^(?:давайте|предлагаю|может\s+(?:нам|мы)|стоит\s+(?:ли\s+)?нам)(?:\s|$)/iu
const EXPLICIT_NPC_SPEECH_PATTERN = /^(?:спрашиваю|спрашиваем|говорю|говорим|обращаюсь|обращаемся|прошу|просим)(?:\s|$)/iu
const ACTION_LIKE_GROUP_PATTERN = /(?:покида|покин|уходим|уйти|маршрут|голосован|переговор|перемир|сдавайт)/iu
const EXPLICIT_CHECK_PATTERN = /(?:провер\p{L}*|спасброс\p{L}*|\bcheck\b|\bsave\b)/iu

/** Безопасный fallback для клиентов, которые ещё не передают request_kind. */
export function inferRequestKind(value) {
  const text = normalizedText(value)
  if (!text || EXPLICIT_NPC_SPEECH_PATTERN.test(text)) return 'action'
  if (DIRECT_QUESTION_PATTERN.test(text)) return 'question'
  if (PARTY_PROPOSAL_PATTERN.test(text) && !ACTION_LIKE_GROUP_PATTERN.test(text)) return 'discussion'
  return 'action'
}

// Шаблоны намерений тоже привязаны к началу слова: без границы `долг` ловил
// «долго», `тон` — «стоном», а `rest` — любое английское слово с этой
// подстрокой, и обычная фраза уезжала в отдых или в проверку Силы.
const W = '(?<![\\p{L}\\p{M}])'
const INTENT_PATTERNS = [
  ['why', /^\s*\/why\b/i],
  ['attack', new RegExp(`${W}(атак|удар|бью|стреля|выстрел|рублю|колю|attack|shoot|strike)`, 'iu')],
  ['saving_throw', new RegExp(`${W}(спасброс|saving\\s*throw|save)`, 'iu')],
  ['improvised_action', FREE_ACTION_PATTERNS[0][1]],
  ['improvised_action', FREE_ACTION_PATTERNS[1][1]],
  ['improvised_action', FREE_ACTION_PATTERNS[2][1]],
  ['ability_check', new RegExp(`${W}(провер|пытаюсь|исслед|осматр|осмотр|крадусь|взлом|убежд|выбираюсь|выплыв|плыву|тону|утоп|check|swim|drown)`, 'iu')],
  ['healing', new RegExp(`${W}(леч|исцел|восстанов\\p{L}*\\s+хит|heal)`, 'iu')],
  ['damage', /(получает?\s+урон|нанести\s+урон|damage)/iu],
  ['cast_spell', new RegExp(`${W}(каст|заклин|сотвор|spell)`, 'iu')],
  ['start_combat', /(начать\s+бой|инициатив|start\s+combat)/iu],
  ['end_combat', /((законч|заверш|прекрат)\p{L}*\s+бой|бой\s+(окончен|заверш[её]н)|end\s+combat)/iu],
  ['end_turn', /^\s*(заканчиваю\s+ход|конец\s+хода|end\s+turn)\s*[.!]?\s*$/iu],
  ['rest', new RegExp(`${W}(коротк\\p{L}*\\s+отдых|долг\\p{L}*\\s+отдых|привал|отдых|отдыха|rest)`, 'iu')],
  ['social', new RegExp(`${W}(говор|убежд|обман|запуг|спраш|переговор)`, 'iu')],
  ['explore', new RegExp(`${W}(осматр|исслед|иду|двига|открыва|ищу|слуша)`, 'iu')],
]

export function classifyFreeActionKind(value) {
  const text = normalizedText(value)
  // Удар после прыжка нельзя молча сократить до обычной атаки: заявка
  // содержит перемещение, которого одиночный эффект импровизации не исполняет.
  const leap = /(?<![\p{L}\p{M}])(?:вс|с|за|пере|под|вы|при|от)?прыг|(?<![\p{L}\p{M}])(?:прыж|соскоч|спрыг|перескоч)/iu
  const strike = /(?<![\p{L}\p{M}])(?:атак|удар|бью|бить|стреля|выстрел|рублю|колю|попасть\s+по|attack|shoot|strike)/iu
  if (leap.test(text) && strike.test(text)) return 'compound_maneuver'
  if (/(?<![\p{L}\p{M}])(?:подхож|подой|подбег|подбеж|приближа|приближусь|добег|добеж|иду\s+к)/iu.test(text) && strike.test(text)) {
    return /(?<![\p{L}\p{M}])(?:стреля|выстрел|shoot)/iu.test(text) ? 'compound_ranged_attack' : 'approach_attack'
  }
  return FREE_ACTION_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null
}

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, 2000)
}

function uniqueActorsById(candidates) {
  const actors = new Map()
  for (const actor of candidates) {
    const id = String(actor?.id ?? '')
    if (id && !actors.has(id)) actors.set(id, actor)
  }
  return [...actors.values()]
}

function visibleActors(visibleState) {
  const candidates = [
    ...(Array.isArray(visibleState?.players) ? visibleState.players : []),
    ...(Array.isArray(visibleState?.actors) ? visibleState.actors : []),
    ...(Array.isArray(visibleState?.enemies) ? visibleState.enemies : []),
    ...(Array.isArray(visibleState?.social?.npcs) ? visibleState.social.npcs : []),
    ...(Array.isArray(visibleState?.merchants) ? visibleState.merchants : []),
  ]
  return uniqueActorsById(candidates)
}

function namesFor(actor) {
  const names = [
    actor?.id,
    actor?.name,
    actor?.character,
    actor?.label,
    ...(Array.isArray(actor?.aliases) ? actor.aliases : []),
  ].map((value) => String(value ?? '').trim()).filter(Boolean)
  // Для составного имени вроде «Король Арес» последняя часть — обычное имя,
  // а не новый рольовой alias. Добавляем её в общий индекс упоминаний, чтобы
  // «Ареса» и «Аресу» находили того же NPC; неоднозначные совпадения по-прежнему
  // возвращаются всеми кандидатами и требуют уточнения выше по стеку.
  const humanNames = [
    actor?.name,
    actor?.character,
    actor?.label,
    ...(Array.isArray(actor?.aliases) ? actor.aliases : []),
  ].map((value) => String(value ?? '').trim()).filter(Boolean)
  const trailingNameTokens = humanNames.flatMap((value) => {
    const tokens = wordTokens(value)
    const last = tokens.at(-1)
    return tokens.length > 1 && last && !/^\d+$/u.test(last) ? [last] : []
  })
  return [...new Set([...names, ...trailingNameTokens].filter(Boolean))]
}

function wordTokens(value) {
  return String(value ?? '').toLocaleLowerCase('ru').match(/\p{L}[\p{L}\p{M}]*|\d+/gu) ?? []
}

function sameNameToken(left, right) {
  if (left === right) return true
  if (/^\d+$/u.test(left) || /^\d+$/u.test(right)) return false
  if (!/^[а-яё]{3,}$/u.test(left) || !/^[а-яё]{3,}$/u.test(right)) return false
  const stem = (value) => {
    if (value.endsWith('ь') && value.length > 3) return value.slice(0, -1)
    for (const suffix of ['иями', 'ями', 'ами', 'ого', 'ему', 'ому', 'ыми', 'ими', 'ах', 'ях', 'ой', 'ей', 'ом', 'ем', 'а', 'я', 'у', 'ю', 'е', 'ы', 'и']) {
      if (value.endsWith(suffix) && value.length - suffix.length >= 3) return value.slice(0, -suffix.length)
    }
    return value
  }
  return stem(left) === stem(right)
}

function mentionsName(message, name) {
  const normalized = String(name ?? '').toLocaleLowerCase('ru')
  if (normalized.length >= 2 && message.includes(normalized)) return true
  const messageWords = wordTokens(message)
  const nameWords = wordTokens(normalized)
  return nameWords.length > 0 && nameWords.every((word) => messageWords.some((candidate) => sameNameToken(word, candidate)))
}

function mentionedActors(message, state) {
  const lower = message.toLocaleLowerCase('ru')
  return visibleActors(state).filter((actor) => namesFor(actor).some((name) => mentionsName(lower, name)))
}

const ROLE_ALIASES = Object.freeze({
  merchant: ['торговец', 'торговц', 'лавочник', 'продавец', 'продавц'],
  innkeeper: ['трактирщик', 'хозяин трактира', 'хозяйка трактира'],
  guard: ['стражник', 'страж', 'охранник'],
  healer: ['лекарь', 'целитель'],
  blacksmith: ['кузнец'],
})

function socialAliasesFor(actor) {
  const role = String(actor?.role ?? '').trim()
  const tags = (Array.isArray(actor?.tags) ? actor.tags : [])
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && !value.includes(':'))
  const translated = [...new Set([role, ...tags].flatMap((value) => (
    ROLE_ALIASES[value.toLocaleLowerCase('ru')] ?? []
  )))]
  return [...new Set([
    ...namesFor(actor),
    role,
    ...tags,
    ...translated,
  ].map((value) => String(value ?? '').trim()).filter(Boolean))]
}

function presentSocialActors(visibleState) {
  const location = String(visibleState?.scene?.location ?? '').trim().toLocaleLowerCase('ru')
  const candidates = [
    ...(Array.isArray(visibleState?.social?.npcs) ? visibleState.social.npcs : []),
    ...(Array.isArray(visibleState?.merchants) ? visibleState.merchants : []),
  ]
  return uniqueActorsById(candidates)
    .filter((actor) => actor?.available !== false)
    .filter((actor) => {
      const actorLocation = String(actor?.location ?? '').trim().toLocaleLowerCase('ru')
      return !location || !actorLocation || actorLocation === location
    })
}

/**
 * Сопоставление собеседника ограничено видимой текущей сценой. Точное имя или
 * явный alias имеют приоритет над ролью; одинаковая роль у двух NPC остаётся
 * неоднозначной и не превращается в молчаливый выбор первого.
 */
export function resolvePresentSocialActors(message, visibleState) {
  const lower = normalizedText(message).toLocaleLowerCase('ru')
  const scored = presentSocialActors(visibleState).map((actor) => {
    const properNames = namesFor(actor)
    const roleAliases = socialAliasesFor(actor).filter((alias) => !properNames.includes(alias))
    const score = properNames.some((name) => mentionsName(lower, name))
      ? 2
      : roleAliases.some((alias) => mentionsName(lower, alias))
        ? 1
        : 0
    return { actor, score }
  }).filter((entry) => entry.score > 0)
  const best = Math.max(0, ...scored.map((entry) => entry.score))
  return scored.filter((entry) => entry.score === best).map((entry) => entry.actor)
}

/**
 * Подходы распознаются по началу слова. Раньше шаблоны были подстроками без
 * границы, и «сломанные вёсла» попадали в `лома` → проверка Силы, а «дверь со
 * стоном» — в `тон`. Осмотр и поиск проверяются раньше силовых глаголов:
 * «осматриваю сломанные вёсла» — это Внимательность, а не попытка что-то
 * сдвинуть.
 */
const APPROACH_PATTERNS = Object.freeze([
  ['perception', /(?<![\p{L}\p{M}])(осматр|осмотр|разгляд|рассматр|высматр|замеч|заметить|ищу|искать|поиск|обыск|прислуш|слуша|следы?|улик)/iu],
  ['arcana', /(?<![\p{L}\p{M}])(маги|магич|рун|заклинан|чароде|arcan)/iu],
  ['stealth', /(?<![\p{L}\p{M}])(крад|тихо|тихонь|скрыт|прячу|прятать|незамет|stealth|sneak)/iu],
  ['persuasion', /(?<![\p{L}\p{M}])(убежд|уговар|угово|диплом|persuad)/iu],
  ['intimidation', /(?<![\p{L}\p{M}])(запуг|угрож|припуг|intimidat)/iu],
  ['strength', /(?<![\p{L}\p{M}])(плыв|плава|тону|утоп|выламыв|ломаю|сломать|взлома|толка|толкаю|поднима|подним|тащ|оттаск|силой|swim|drown|shove|lift)/iu],
])

function inferApproach(message) {
  return APPROACH_PATTERNS.find(([, pattern]) => pattern.test(message))?.[0] ?? 'unspecified'
}

export class IntentParser {
  async parse({ message, playerId, visibleState }) {
    const text = normalizedText(message)
    if (!text) return {
      actor_id: String(playerId ?? ''), intent: 'unknown', approach: 'unspecified', targets: [],
      mentioned_entities: [], missing_information: ['message'], requires_clarification: true, confidence: 0,
      free_action_kind: null,
    }
    const socialSkill = classifyNpcSocialCheck(text)
    const freeActionKind = classifyFreeActionKind(text)
    const detectedIntent = freeActionKind === 'compound_maneuver' ? 'compound_maneuver'
      : freeActionKind === 'compound_ranged_attack' ? 'improvised_action'
      : freeActionKind === 'approach_attack' ? 'approach_attack'
      : socialSkill ? 'social' : INTENT_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'improvised_action'
    const approach = socialSkill ?? inferApproach(text)
    // Свободная задумка вроде «пытаюсь поймать шишку ртом» не должна
    // превращаться в проверку Мудрости только из-за глагола «пытаюсь».
    // Явно запрошенная проверка сохраняет обычный маршрут арбитра.
    const intent = detectedIntent === 'ability_check'
      && approach === 'unspecified'
      && !EXPLICIT_CHECK_PATTERN.test(text)
      ? 'improvised_action'
      : detectedIntent
    const socialTargets = intent === 'social' ? resolvePresentSocialActors(text, visibleState) : []
    const mentioned = intent === 'social' && socialTargets.length ? socialTargets : mentionedActors(text, visibleState)
    const targets = mentioned.map((actor) => String(actor.id)).filter((id) => id !== String(playerId ?? ''))
    const requiresTarget = intent === 'attack' || intent === 'damage' || intent === 'approach_attack' || intent === 'compound_maneuver'
    const ambiguousSocialTarget = intent === 'social' && socialTargets.length > 1
    const missing = [
      ...(requiresTarget && !targets.length ? ['target_id'] : []),
      ...(ambiguousSocialTarget ? ['ambiguous_npc'] : []),
      ...(['approach_attack', 'compound_maneuver'].includes(intent) && targets.length > 1 ? ['target_id'] : []),
    ]
    const number = /(?:^|\s)(\d{1,3})(?:\s|$)/.exec(text)?.[1]
    return {
      actor_id: String(playerId ?? ''),
      intent,
      approach,
      targets,
      mentioned_entities: mentioned.map((actor) => String(actor.id)),
      numeric_value: number ? Number(number) : null,
      raw_message: text,
      missing_information: missing,
      requires_clarification: missing.length > 0,
      confidence: intent === 'improvised_action' ? 0.45 : missing.length ? 0.55 : 0.86,
      free_action_kind: freeActionKind,
      ...(ambiguousSocialTarget ? {
        target_candidates: socialTargets.map((actor) => ({
          id: String(actor.id),
          name: String(actor.name ?? actor.id),
          role: String(actor.role ?? ''),
        })),
      } : {}),
    }
  }
}

export function buildRuleQueries(intent, state) {
  const queries = [intent?.raw_message, intent?.intent, intent?.approach]
  if (intent?.intent === 'attack') queries.push('attack roll armor class damage advantage disadvantage')
  if (intent?.intent === 'saving_throw') queries.push('saving throw')
  if (intent?.intent === 'healing') queries.push('healing hit points zero hit points')
  if (intent?.intent === 'cast_spell') queries.push('spellcasting concentration resource')
  if (intent?.intent === 'end_combat') queries.push('combat initiative turn order end combat')
  if (/плыв|вод|тон\w*|удуш|swim|drown|suffocat/iu.test(intent?.raw_message ?? '')) queries.push('swimming rough water suffocation hazard exhaustion')
  if (state?.mechanics?.combat?.active) queries.push('combat turn action bonus action reaction')
  return [...new Set(queries.map(normalizedText).filter(Boolean))]
}
