const END_TURN = /^\s*(?:заканчиваю|завершаю|передаю|пропускаю)\s+(?:свой\s+)?ход(?:\s|[.!]|$)|^\s*конец\s+хода(?:\s|[.!]|$)|^\s*end\s+turn(?:\s|[.!]|$)/iu
const FREE_ACTION = /(^|\s)(?:говорю|отвечаю|спрашиваю|кричу|шепчу|обсуждаю|предлагаю|планирую|думаю|вспоминаю|смотрю\s+инвентарь|показываю|передаю\s+слово|что\s+я\s+знаю|что\s+видно|кто\s+здесь)(?:\s|$)|\?\s*$/iu
const SUBSTANTIVE_ACTION = /атак|удар|стреля|заклин|каст|взлом|лома|крадусь|прячусь|обыск|исслед|осматр|ищу|открыва|беру|подбира|использую|активир|обезвреж|иду|бегу|двига|перехожу|покида|отдых|привал|леч/iu
const LORE_QUESTION = /(?:лор|истори[яию]|легенд|предани|что\s+(?:я|мы)\s+зна|кто\s+так|что\s+так|расскажи\s+(?:мне\s+)?(?:о|об|про)|помню\s+ли)/iu

function hasWorldEffect(result = {}) {
  const effects = result.effects ?? {}
  return Boolean(
    effects.scene || effects.objective || effects.roll ||
    effects.reveal?.length || effects.spawn?.length || effects.grantItems?.length,
  )
}

/** Server-side turn policy. The model may suggest a value, but hard game rules
 * win so a narration response cannot accidentally steal the rest of a turn. */
export function decideTurnConsumption({ state = {}, action = '', result = {}, rollResolved = false } = {}) {
  const text = String(action).normalize('NFKC').trim()
  if (!text || result.turn_consumed === false && result.check) return false
  if (result.check) return false
  if (/^\s*\/why\b/iu.test(text)) return false
  if (result.effects?.interaction) return false
  if (LORE_QUESTION.test(text) && /\?\s*$/.test(text) && !hasWorldEffect(result)) return false
  if (END_TURN.test(text)) return true

  // In initiative, spending an action is not the same as ending the turn:
  // movement, bonus action and free interaction may still remain.
  if (state.mechanics?.combat?.active) return false

  if (result.effects?.scene) return true
  if (rollResolved || result.effects?.roll) return true
  if (FREE_ACTION.test(text) && !hasWorldEffect(result)) return false
  if (hasWorldEffect(result)) return true
  if (typeof result.turn_consumed === 'boolean') return result.turn_consumed
  return SUBSTANTIVE_ACTION.test(text)
}

export function isExplicitEndTurn(action) {
  return END_TURN.test(String(action ?? '').normalize('NFKC').trim())
}
