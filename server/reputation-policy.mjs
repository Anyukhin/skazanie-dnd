import {
  WANTED_TRADE_REFUSAL_REASON,
  wantedLevelHere,
  wantedPriceBps,
  wantedTradeAvailable,
} from './law-and-order.mjs'

/**
 * Что репутация делает с миром.
 *
 * До 2026-07-28 репутация фракций была записью в никуда: события
 * `FactionReputationAdjusted` копились, reducer складывал их в
 * `autonomy.reputations`, и **ни одна строка кода этот реестр не читала**.
 * Отряд мог вырезать деревню или спасти её — цены, готовность разговаривать и
 * доступность услуг не менялись ни на медяк.
 *
 * Политика ниже замыкает петлю. Она вся server-owned и объявлена таблицами:
 * модель на неё не влияет, а действия игрока влияют только через уже
 * подтверждённые события.
 *
 * Границы намеренные:
 * - поправка к цене ограничена ±10 % и складывается с прочими множителями
 *   внутри уже существующих `min_multiplier_bps`/`max_multiplier_bps`;
 * - поправка к СЛ социальной проверки ограничена ±3 и никогда не делает
 *   проверку невозможной;
 * - репутация не может закрыть торговлю совсем: голод и жадность сильнее
 *   неприязни, а запертая лавка останавливает кампанию.
 *
 * С 2026-08-09 сюда же приходит розыск (`server/law-and-order.mjs`), и это не
 * второй механизм цены, а тот же самый: ступень добавляет наценку в те же
 * базисные пункты и зажимается теми же границами. Розыск при этом умеет то,
 * чего не умеет неприязнь, — **закрыть лавку**: продавший тем, кого ищет
 * стража, отвечает перед той же стражей. Кампания от этого не встаёт, потому
 * что выход из розыска у отряда есть всегда (вира, сдача, сутки без новых
 * преступлений), и он не требует торговли.
 */

const FACTION_TAG_PREFIX = 'faction:'

const clampScore = (value) => Math.max(-100, Math.min(100, Number.isSafeInteger(Number(value)) ? Number(value) : 0))

/** Фракции NPC берутся из безопасного тега `faction:<id>` его профиля. */
export function factionIdsForNpc(npc) {
  return [...new Set((npc?.tags ?? [])
    .map(String)
    .filter((tag) => tag.startsWith(FACTION_TAG_PREFIX))
    .map((tag) => tag.slice(FACTION_TAG_PREFIX.length))
    .filter(Boolean))].sort()
}

/**
 * Репутация отряда в глазах конкретного NPC — худшая среди его фракций.
 *
 * Именно худшая, а не средняя: членство в дружественной гильдии не отменяет
 * того, что отряд враждует со стражей, к которой NPC тоже принадлежит.
 */
export function reputationScoreFor(state, npc) {
  const reputations = state?.autonomy?.reputations ?? {}
  const factions = factionIdsForNpc(npc)
  if (!factions.length) return 0
  return factions.reduce((worst, id) => Math.min(worst, clampScore(reputations[id])), 100)
}

/** Именованные ступени — их видно в трассе и в тексте, в отличие от числа. */
export function reputationTier(score) {
  const value = clampScore(score)
  if (value <= -50) return 'reviled'
  if (value <= -20) return 'distrusted'
  if (value >= 50) return 'honoured'
  if (value >= 20) return 'respected'
  return 'unknown'
}

/**
 * Поправка к цене в базисных пунктах. Положительная — дороже для героя.
 * Ненавидимому отряду продают с наценкой, уважаемому — со скидкой.
 */
export const REPUTATION_PRICE_BPS = Object.freeze({
  reviled: 1_000, distrusted: 500, unknown: 0, respected: -500, honoured: -1_000,
})

/** Поправка к СЛ социальной проверки. Положительная — говорить труднее. */
export const REPUTATION_SOCIAL_DC_SHIFT = Object.freeze({
  reviled: 3, distrusted: 2, unknown: 0, respected: -1, honoured: -2,
})

/** Ступени, на которых NPC перестаёт оказывать необязательные услуги. */
const SERVICE_REFUSAL_TIERS = new Set(['reviled'])

function npcProfileFor(state, npcId) {
  const expected = String(npcId ?? '')
  return (state?.social?.npcs ?? []).find((npc) => String(npc?.id ?? '') === expected) ?? null
}

/** Всё, что политика говорит про отношение мира к отряду у этого NPC. */
export function reputationStandingFor(state, npcId) {
  const npc = npcProfileFor(state, npcId)
  const factions = factionIdsForNpc(npc)
  const score = reputationScoreFor(state, npc)
  const tier = reputationTier(score)
  // Розыск считается по краю, где отряд стоит **сейчас**: в соседнем крае тот
  // же торговец возьмёт обычную цену, и это не поблажка, а география закона.
  const wantedLevel = wantedLevelHere(state)
  const tradeAvailable = wantedTradeAvailable(state)
  return {
    npc_id: String(npcId ?? ''),
    faction_ids: factions,
    score,
    tier,
    wanted_level: wantedLevel,
    price_adjustment_bps: (REPUTATION_PRICE_BPS[tier] ?? 0) + wantedPriceBps(state),
    social_dc_shift: REPUTATION_SOCIAL_DC_SHIFT[tier] ?? 0,
    // Услуги — это одолжение, и в нём отказывают. Товар продают всем, пока
    // отряд не в розыске: запертая из-за неприязни лавка останавливает
    // кампанию, а запертая из-за стражи — следствие, которое отряд выбрал сам.
    services_available: !SERVICE_REFUSAL_TIERS.has(tier) && tradeAvailable,
    trade_available: tradeAvailable,
    ...(tradeAvailable ? {} : { trade_refusal_reason: WANTED_TRADE_REFUSAL_REASON }),
  }
}

/** Готовая поправка к цене для торговца; 0, когда фракций у него нет. */
export function reputationPriceBps(state, merchantId) {
  return reputationStandingFor(state, merchantId).price_adjustment_bps
}
