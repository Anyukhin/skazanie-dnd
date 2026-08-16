/**
 * Изнанка торговли: скупщик краденого и подкуп.
 *
 * Оба свойства человека — «берёт краденое» и «не берёт денег» — **выводятся из
 * сида, а не хранятся**, тем же приёмом, что карман (`server/pickpocket.mjs`) и
 * характер соперника за костями (`server/tavern-life.mjs`). Причина та же:
 * социальный профиль приезжает из админского импорта и из команды Режиссёра,
 * и всё, что в нём лежит, надо валидировать белым списком, закрывать в проекции
 * и мигрировать. Выведенное свойство не требует ничего из этого и по построению
 * не течёт игроку: в состоянии его просто нет — есть только следствия.
 *
 * Явно проставленный автором тег при этом уважается: ведущий вправе назначить
 * скупщика руками, и тогда сид не спорит. Обратной силы это не имеет — снять
 * выведенный тег тегом нельзя, иначе «неподкупный» в данных читался бы как
 * «подкупный», и правило зависело бы от того, чего в записи **нет**.
 */
import { createHash } from 'node:crypto'

export const UNDERWORLD_POLICY_ID = 'skazanie:underworld-v1'

/** Тег скупщика краденого. Живёт в `tags` профиля, если автор поставил руками. */
export const FENCE_TAG = 'скупщик'
/** Тег неподкупного. Тот же порядок: сид или рука ведущего. */
export const INCORRUPTIBLE_TAG = 'неподкупный'

/**
 * Теги, которые столу не принадлежат. Оба — готовые ответы на вопросы, ради
 * которых кража и подкуп вообще имеют смысл: «кому нести краденое» и «стоит ли
 * доставать монету». Игрок узнаёт их следствием, а не описью.
 */
export const UNDERWORLD_PRIVATE_TAGS = Object.freeze([FENCE_TAG, INCORRUPTIBLE_TAG])

/**
 * Скупщик редок: примерно один торговец из семи. Реже — и краденое некуда
 * девать вовсе; чаще — и кража перестаёт быть риском.
 */
export const FENCE_SHARE = 14

/** Неподкупных примерно один из пяти: подкуп обязан иногда взрываться в руках. */
export const INCORRUPTIBLE_SHARE = 20

/**
 * Скидка скупщика: он берёт краденое за ~60 % обычной цены.
 *
 * Слагаемое **отдельное** и в `reputationBps` не сливается намеренно: тот зажат
 * ±1000 и уже занят славой отряда и ступенью розыска. Сложи их — и скидка за
 * краденое то исчезала бы у героя с доброй славой, то удваивалась под розыском,
 * а разбор цены в торговом окне перестал бы сходиться.
 */
export const STOLEN_DISCOUNT_BPS = 4_000

/**
 * Ступени щедрости подкупа. Доля от цены, а не круглые монеты: в бедной деревне
 * и в столице «хорошо дать» — разные суммы, а ступеней должно остаться три.
 * Сдвиг СЛ закрыт и мал: подкуп облегчает разговор, но не заменяет его.
 */
export const BRIBE_TIERS = Object.freeze([
  { id: 'coin', label: 'монета', share_bps: 500, dc_shift: -1 },
  { id: 'purse', label: 'кошель', share_bps: 1_500, dc_shift: -2 },
  { id: 'generous', label: 'щедро', share_bps: 4_000, dc_shift: -3 },
])

/** Меньше этого подкуп не бывает: медяк оскорбителен, а не убедителен. */
export const MIN_BRIBE_CP = 10

/**
 * Насколько подкуп бьёт по неподкупному. Сдвиг **в плюс** и вдвое больше
 * задуманной поблажки: попытка купить того, кто не продаётся, портит разговор
 * сильнее, чем деньги могли его облегчить.
 */
export const INCORRUPTIBLE_DC_PENALTY = 4

/**
 * Порог розыска, с которого честный торговец начинает доносить. Ниже него он
 * просто откажется: доносить на прохожего с чужим ножом никто не побежит.
 */
export const DENUNCIATION_WANTED_LEVEL = 2

/** Доля доносов на этом пороге. Детерминированная, а не бросок кости. */
export const DENUNCIATION_SHARE = 50

const text = (value, maximum = 160) => String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
const integer = (value, fallback = 0) => (Number.isSafeInteger(Number(value)) ? Number(value) : fallback)

function digest(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex')
}

function spread(seed, salt, size) {
  return Number.parseInt(digest(seed, salt).slice(0, 8), 16) % Math.max(1, size)
}

const tagsOf = (npc) => (Array.isArray(npc?.tags) ? npc.tags : []).map((tag) => text(tag, 60))

/**
 * Сид свойства. В него входит **поселение**, а не только человек: скупщик — это
 * свойство места не меньше, чем лица, и в двух разных городах у одинаково
 * названного лавочника оно своё.
 */
function traitSeed(state, npcId, salt) {
  const settlement = text(state?.worldMap?.currentLocationId ?? state?.scene?.location, 180)
  return digest(text(state?.sessionCode, 60), settlement, text(npcId, 120), UNDERWORLD_POLICY_ID, salt)
}

/** Берёт ли этот торговец краденое. */
export function npcIsFence(state = {}, npc = {}) {
  const id = text(npc?.id, 120)
  if (!id) return false
  if (tagsOf(npc).includes(FENCE_TAG)) return true
  return spread(traitSeed(state, id, 'fence'), 'roll', 100) < FENCE_SHARE
}

/** Оскорбится ли этот человек предложенной монетой. */
export function npcIsIncorruptible(state = {}, npc = {}) {
  const id = text(npc?.id, 120)
  if (!id) return false
  if (tagsOf(npc).includes(INCORRUPTIBLE_TAG)) return true
  return spread(traitSeed(state, id, 'incorruptible'), 'roll', 100) < INCORRUPTIBLE_SHARE
}

/**
 * Побежит ли честный торговец доносить. Не бросок: один и тот же отказ на одном
 * и том же состоянии обязан кончаться одинаково и после replay.
 */
export function fenceDenunciationFor(state = {}, npc = {}, { wantedLevel = 0, itemId = '' } = {}) {
  if (integer(wantedLevel, 0) < DENUNCIATION_WANTED_LEVEL) return null
  const seed = traitSeed(state, text(npc?.id, 120), `denounce:${text(itemId, 160)}`)
  if (spread(seed, 'roll', 100) >= DENUNCIATION_SHARE) return null
  return { npc_id: text(npc?.id, 120), wanted_level: integer(wantedLevel, 0) }
}

/**
 * Во сколько обходится ступень щедрости. Считается от масштаба цен в кошельке
 * собеседника — а его у социального профиля нет, — поэтому мерка приходит
 * снаружи: вызывающий передаёт опорную сумму (кошелёк героя либо цену сделки).
 */
export function bribeTierAmounts(referenceCp = 0) {
  const reference = Math.max(0, integer(referenceCp, 0))
  return BRIBE_TIERS.map((tier) => ({
    ...tier,
    amount_cp: Math.max(MIN_BRIBE_CP, Math.round(reference * tier.share_bps / 10_000)),
  }))
}

export function bribeTierById(tierId, referenceCp = 0) {
  const id = text(tierId, 40)
  return bribeTierAmounts(referenceCp).find((tier) => tier.id === id) ?? null
}

/**
 * Что подкуп делает со сложностью разговора. Одна функция на обе стороны:
 * поблажка честному и наказание неподкупному считаются здесь, чтобы карточка
 * проверки и движок не разошлись во мнении о цене монеты.
 */
export function bribeOutcomeFor({ incorruptible = false, tier = null } = {}) {
  if (!tier) return { dc_shift: 0, insulted: false }
  return incorruptible
    ? { dc_shift: INCORRUPTIBLE_DC_PENALTY, insulted: true }
    : { dc_shift: tier.dc_shift, insulted: false }
}
