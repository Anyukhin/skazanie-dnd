// Перехват настоящих вызовов модулей sk-npc-world внутри серверного конвейера.
//
// Хук загрузки (`module.registerHooks`) дописывает в конец модуля
// переприсваивание экспортов обёрткой — привязка `export function` изменяема,
// и импортёры (Rules Engine, проекция, соседние модули) видят обёртку.
// Исходники `server/` на диске не меняются. Как в
// `rust/crates/sk-map-core/fixtures/recorder.mjs`.
//
// Импортировать ВТОРЫМ после `fixtures-env.mjs`, а серверные модули грузить
// после этого динамическим `import()`.
import { registerHooks } from 'node:module'

export const TARGETS = {
  'server/npc-positioning.mjs': [
    'normalizeNpcWorldState', 'normalizeNpcWorldStateLegacy', 'sceneLocationId', 'presentSceneNpcs', 'npcPlacementFor',
    'npcVitalFor', 'npcMechanicsFor', 'npcCombatActorFor', 'npcInteractionTargetForViewer', 'initialNpcVital',
    'isValidNpcPost', 'planSceneNpcPlacementEvents', 'validateNpcWorldCommand', 'placedSceneNpcTargets',
    'sceneNpcOccupiedCells', 'sceneNpcTransitCells', 'npcTargetsWithinArea', 'npcMissCollateralTarget',
    'npcHarmEventDrafts', 'planAuthoredNpcWorldEvents', 'npcCombatStanceEventDrafts', 'applyNpcWorldEvent',
    'sceneNpcsForViewer',
  ],
  'server/tavern-life.mjs': [
    'isTavernScene', 'tavernOpponents', 'isTavernOpponent', 'tavernGamblerFor', 'tavernOpponentDie',
    'normalizeTavernState', 'tavernRoundFor', 'tavernGamblerPurseFor', 'tavernPurseTransfer',
    'tavernPurseTransferPayload', 'tavernOpenRounds', 'tavernOpenRoundsAgainst', 'tavernEarmarkedCpAgainst',
    'tavernFreePurseFor', 'tavernMaxStakeFor', 'tavernDrinksFor', 'tavernScandalsFor', 'tavernEjected',
    'tavernNextDrinkDc', 'tavernSocialBonus', 'tavernTableMood', 'tavernForViewer', 'publicTavernRoundFor',
    'applyTavernEvent',
  ],
  'server/blessings.mjs': [
    'normalizeBlessingState', 'blessingRecordFor', 'heroIsBlessed', 'blessingAvailabilityFor', 'isPriestProfile',
    'blessingPriestsFor', 'isBlessingPriest', 'blessingFactionIdsFor', 'blessingOmenFor', 'blessingsForViewer',
    'applyBlessingEvent',
  ],
  'server/beast-taming.mjs': [
    'beastDietFor', 'isTameableBeast', 'beastChallengeRating', 'beastChallengeDcShift', 'beastIsWounded',
    'beastMoraleBroken', 'normalizeBeastState', 'beastList', 'beastFor', 'beastCompanions', 'beastIdFor',
    'beastDistanceFeet', 'beastReachFor', 'beastOutOfReach', 'beastReachByHero', 'beastApproachBlockedReason',
    'tameableBeasts', 'beastDraftFor', 'beastTamingPolicy', 'beastBiteDamage', 'beastFoodItemFor',
    'partyIsResting', 'beastWatchCompanion', 'beastWatchSwing', 'beastScareLine', 'beastScareCooldownLeft',
    'planBeastFollowDrafts', 'beastDietLabel', 'beastStageLabel', 'beastForViewer', 'beastsForViewer',
    'beastChronicleEntry', 'applyBeastEvent',
  ],
}

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    const target = Object.keys(TARGETS).find((suffix) => url.endsWith(`/${suffix}`))
    if (!target) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    const wraps = TARGETS[target].map((name) => `${name} = globalThis.__npcWorldWrap(${JSON.stringify(target)}, ${JSON.stringify(name)}, ${name})`).join('\n')
    return { ...result, source: `${source}\n;${wraps}\n` }
  },
})

const depth = new Map()

globalThis.__npcWorldWrap = (module, name, fn) => function recorded(...args) {
  const recorder = globalThis.__npcWorldRecorder
  if (!recorder || (depth.get(module) ?? 0) > 0) return fn(...args)
  depth.set(module, (depth.get(module) ?? 0) + 1)
  try {
    recorder(module, name, args)
    return fn(...args)
  } finally {
    depth.set(module, depth.get(module) - 1)
  }
}

/**
 * Начать запись: `capture(module, name, args)` получает аргументы верхних
 * вызовов модуля (внутренние вызовы модуля самого себя не пишутся).
 */
export function startCapture(capture) {
  globalThis.__npcWorldRecorder = capture
  return () => {
    globalThis.__npcWorldRecorder = undefined
  }
}
