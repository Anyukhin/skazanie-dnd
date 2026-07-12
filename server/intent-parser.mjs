const INTENT_PATTERNS = [
  ['why', /^\s*\/why\b/i],
  ['attack', /(атак|удар|бью|стреля|выстрел|рублю|колю|attack|shoot|strike)/iu],
  ['saving_throw', /(спасброс|saving\s*throw|save)/iu],
  ['ability_check', /(провер|пытаюсь|исслед|осматр|крадусь|взлом|убежд|выбираюсь|выплыв|плыву|тон\w*|check|swim|drown)/iu],
  ['healing', /(леч|исцел|восстанов.*хит|heal)/iu],
  ['damage', /(получает?\s+урон|нанести\s+урон|damage)/iu],
  ['cast_spell', /(каст|заклин|сотвор|spell)/iu],
  ['start_combat', /(начать\s+бой|инициатив|start\s+combat)/iu],
  ['end_combat', /((законч|заверш|прекрат)\p{L}*\s+бой|бой\s+(окончен|заверш[её]н)|end\s+combat)/iu],
  ['end_turn', /^\s*(заканчиваю\s+ход|конец\s+хода|end\s+turn)\s*[.!]?\s*$/iu],
  ['rest', /(коротк|долг|привал|отдых|rest)/iu],
  ['social', /(говор|убежд|обман|запуг|спраш|переговор)/iu],
  ['explore', /(осматр|исслед|иду|двига|открыва|ищу|слуша)/iu],
]

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, 2000)
}

function visibleActors(visibleState) {
  return [...(Array.isArray(visibleState?.players) ? visibleState.players : []), ...(Array.isArray(visibleState?.actors) ? visibleState.actors : [])]
}

function namesFor(actor) {
  return [actor?.id, actor?.name, actor?.character, actor?.label].map((value) => String(value ?? '').trim()).filter(Boolean)
}

function mentionedActors(message, state) {
  const lower = message.toLocaleLowerCase('ru')
  return visibleActors(state).filter((actor) => namesFor(actor).some((name) => name.length >= 2 && lower.includes(name.toLocaleLowerCase('ru'))))
}

function inferApproach(message) {
  if (/плыв|выбираюсь.*вод|тон\w*|swim|drown/iu.test(message)) return 'strength'
  if (/крад|тихо|скрыт/iu.test(message)) return 'stealth'
  if (/убежд|диплом|угов/iu.test(message)) return 'persuasion'
  if (/запуг|угрож/iu.test(message)) return 'intimidation'
  if (/сил|лома|толка|поднима/iu.test(message)) return 'strength'
  if (/осматр|замеч|ищу|слуш/iu.test(message)) return 'perception'
  if (/маг|рун|заклин/iu.test(message)) return 'arcana'
  return 'unspecified'
}

export class IntentParser {
  async parse({ message, playerId, visibleState }) {
    const text = normalizedText(message)
    if (!text) return {
      actor_id: String(playerId ?? ''), intent: 'unknown', approach: 'unspecified', targets: [],
      mentioned_entities: [], missing_information: ['message'], requires_clarification: true, confidence: 0,
    }
    const intent = INTENT_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'improvised_action'
    const mentioned = mentionedActors(text, visibleState)
    const targets = mentioned.map((actor) => String(actor.id)).filter((id) => id !== String(playerId ?? ''))
    const requiresTarget = intent === 'attack' || intent === 'damage'
    const missing = requiresTarget && !targets.length ? ['target_id'] : []
    const number = /(?:^|\s)(\d{1,3})(?:\s|$)/.exec(text)?.[1]
    return {
      actor_id: String(playerId ?? ''),
      intent,
      approach: inferApproach(text),
      targets,
      mentioned_entities: mentioned.map((actor) => String(actor.id)),
      numeric_value: number ? Number(number) : null,
      raw_message: text,
      missing_information: missing,
      requires_clarification: missing.length > 0,
      confidence: intent === 'improvised_action' ? 0.45 : missing.length ? 0.55 : 0.86,
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
