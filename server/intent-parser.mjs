import { classifyNpcSocialCheck } from './npc-social-check.mjs'

const FREE_ACTION_PATTERNS = Object.freeze([
  ['physically_impossible', /(взлет\w*|взлета\w*|парю\w*|телепорт\w*|останавлива\w*\s+время|дыш\w*\s+под\s+водой|становлюсь\s+невидим\w*|путешеств\w*\s+во\s+времени|fly\b|teleport\w*|stop\s+time|breathe\s+underwater)/iu],
  ['bounded_scene_action', /(подпира\w*|баррикад\w*|поджига\w*|зажига\w*|зову\w*\s+страж|крич\w*\s+страж|связыва\w*|прячу\w*\s+след\w*|заслоня\w*)/iu],
  ['corpse_search', /(?:обыск\p{L}*|провер\p{L}*|осматр\p{L}*|ищ\p{L}*)[^.!?]{0,80}(?:труп|тел[оаеу]|останки|карман)|(?:труп|тел[оаеу]|останки|карман)[^.!?]{0,80}(?:обыск\p{L}*|провер\p{L}*|осматр\p{L}*|ищ\p{L}*)/iu],
])

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
  const strike = /(?<![\p{L}\p{M}])(?:атак|удар|бью|бить|стреля|рублю|колю|попасть\s+по|attack|strike)/iu
  if (leap.test(text) && strike.test(text)) return 'compound_maneuver'
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
    ...(Array.isArray(visibleState?.social?.npcs) ? visibleState.social.npcs : []),
    ...(Array.isArray(visibleState?.merchants) ? visibleState.merchants : []),
  ]
  return uniqueActorsById(candidates)
}

function namesFor(actor) {
  return [
    actor?.id,
    actor?.name,
    actor?.character,
    actor?.label,
    ...(Array.isArray(actor?.aliases) ? actor.aliases : []),
  ].map((value) => String(value ?? '').trim()).filter(Boolean)
}

function wordTokens(value) {
  return String(value ?? '').toLocaleLowerCase('ru').match(/\p{L}[\p{L}\p{M}-]*/gu) ?? []
}

function sameNameToken(left, right) {
  if (left === right) return true
  if (!/^[а-яё]{3,}$/u.test(left) || !/^[а-яё]{3,}$/u.test(right)) return false
  const stem = (value) => {
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
    const intent = freeActionKind === 'compound_maneuver' ? 'improvised_action'
      : socialSkill ? 'social' : INTENT_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'improvised_action'
    const socialTargets = intent === 'social' ? resolvePresentSocialActors(text, visibleState) : []
    const mentioned = intent === 'social' && socialTargets.length ? socialTargets : mentionedActors(text, visibleState)
    const targets = mentioned.map((actor) => String(actor.id)).filter((id) => id !== String(playerId ?? ''))
    const requiresTarget = intent === 'attack' || intent === 'damage'
    const ambiguousSocialTarget = intent === 'social' && socialTargets.length > 1
    const missing = [
      ...(requiresTarget && !targets.length ? ['target_id'] : []),
      ...(ambiguousSocialTarget ? ['ambiguous_npc'] : []),
    ]
    const number = /(?:^|\s)(\d{1,3})(?:\s|$)/.exec(text)?.[1]
    return {
      actor_id: String(playerId ?? ''),
      intent,
      approach: socialSkill ?? inferApproach(text),
      targets,
      mentioned_entities: mentioned.map((actor) => String(actor.id)),
      numeric_value: number ? Number(number) : null,
      raw_message: text,
      missing_information: missing,
      requires_clarification: missing.length > 0,
      confidence: intent === 'improvised_action' ? 0.45 : missing.length ? 0.55 : 0.86,
      free_action_kind: intent === 'improvised_action' ? freeActionKind : null,
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
