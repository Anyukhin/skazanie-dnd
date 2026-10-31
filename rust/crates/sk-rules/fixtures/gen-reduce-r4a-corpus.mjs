import '../../../fixtures-env.mjs'
// Эталоны веток редьюсера Р4а по событиям корпуса — по одному событию.
//
// Сверка `sk-corpus` применяет все события записи подряд без нормализации
// между ними, а JS нормализует состояние перед каждым событием
// (`applyGameEvent` → `normalizeCampaignState`). Поэтому расхождение после
// `SceneAdvanced` с последующей памятью мира может быть следом нормализации,
// а не ветки. Здесь каждое событие перенесённого типа снимается отдельно:
// состояние «до» — нормализованное JS-состояние перед этим событием (вместе
// с производными полями героя), «после» — `applyGameEvent` без производных
// полей. Берутся только неподвижные точки нормализации, иначе Rust (без
// нормализации) и JS начинают с разного.
//
// Выход большой (полные состояния), поэтому он пишется вне репозитория:
//   node rust/crates/sk-rules/fixtures/gen-reduce-r4a-corpus.mjs <корпус> <выход.jsonl> [предел на тип]
// Сверка — `SK_R4A_CASES=<выход.jsonl> cargo test -p sk-rules --test reduce_r4a_corpus -- --ignored`.
import { createWriteStream, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOpenCopy } from './open-copy.mjs'

const [corpus, output, limitText] = process.argv.slice(2)
if (!corpus || !output) throw new Error('Укажите каталог корпуса и файл выхода')
const limit = Number(limitText ?? 60)
const E = await loadOpenCopy()

const ALL_TYPES = [
  'CampaignStoryCompleted', 'CampaignArcChainSet', 'CampaignArcCompleted',
  'PartyDecisionOpened', 'PartyVoteCast', 'PartyDecisionAbstained', 'PartyDecisionResolved', 'PartyDecisionExpired', 'PartyDecisionConsumed',
  'SceneAdvanced', 'LocationMapImported', 'MapLevelChanged', 'EncounterCreated', 'CombatStarted', 'ActorMoved', 'AreaRevealed',
  'DoorStateChanged', 'DoorBarricaded', 'DoorBarricadeCleared', 'DoorBarricadeForced', 'DoorForced', 'DoorLockpicked', 'LockpickNoticed',
  'SceneObjectOperated', 'ScenarioKnightHeadReturned', 'SceneObjectCheckResolved', 'SceneObjectInspected', 'SceneObjectUseRecorded',
  'SceneObjectKnowledgeRevealed', 'SceneObjectLootRevealed', 'SceneObjectStateChanged', 'SceneObjectLootGranted', 'SceneObjectEffectApplied',
  'EntitySpawned', 'EquipmentChanged', 'ItemDawnRechargeResolved', 'ItemUsed', 'ItemConsumed', 'AmmunitionSpent', 'NpcEquipmentSpent',
  'ScenarioPurseGranted', 'ItemGranted', 'CaptiveTaken', 'BeastTamed', 'CaptiveHandedOver', 'ParleyProposed', 'ParleyRejected',
  'TruceEstablished', 'TruceBroken', 'GuardEncounterResolved', 'NpcBlessingGranted', 'CourierLetterSent', 'TavernDiceRoundOpened',
  'TavernDiceRoundCancelled', 'TavernDiceRoundResolved', 'TavernDrinkOrdered', 'ParleySettled', 'NpcBribeOffered', 'NpcPocketPicked',
  'CharacterAbilitiesRolled', 'CharacterWealthRolled', 'ExperienceAwarded', 'MilestoneAwarded',
  // Р4в: мир NPC.
  'NpcPlaced', 'NpcMoved', 'NpcHarmed', 'NpcDied', 'NpcStanceChanged',
  // Р4в: события реестров таверны, благословений и зверей (своих веток нет).
  'TavernPatronEjected', 'ShrinePrayerResolved', 'BeastEncountered', 'BeastSoothingResolved', 'BeastFed', 'BeastBit', 'BeastMoved', 'BeastScaredThreat',
  // Р4в-2: жизнь вещи, герой, награды, контейнеры добычи, должности.
  'ItemEquipped', 'ItemUnequipped', 'ItemTransferred', 'ItemAttunementChanged', 'ItemChargesSpent', 'ItemDestroyed', 'MagicItemActivationChanged',
  'SpellSelectionsUpdated', 'CharacterChoicesUpdated', 'CharacterLeveledUp', 'CharacterImported', 'EncounterRewardsDistributed',
  'LootContainerCreated', 'LootContainerTaken', 'OfficeVacated', 'OfficeHolderInstalled', 'OfficeSuccessionSkipped',
]
// `SK_R4A_TYPES=A,B` — снять только эти типы (например, с большим пределом);
// `SK_R4A_TYPES=all` — все типы корпуса (реестры-выводы читают и события без
// своей ветки: доставку письма, свидетелей, разговоры).
const ANY_TYPE = process.env.SK_R4A_TYPES === 'all'
const TYPES = new Set(process.env.SK_R4A_TYPES && !ANY_TYPE ? process.env.SK_R4A_TYPES.split(',').filter(Boolean) : ALL_TYPES)
const wanted = (type) => ANY_TYPE || TYPES.has(type)
const DERIVED = ['combatSpells', 'combatActions', 'characterSheet', 'inventoryLoad']
const strip = (state) => {
  const copy = JSON.parse(JSON.stringify(state))
  for (const player of copy.players ?? []) for (const field of DERIVED) delete player[field]
  return copy
}
const modeFor = (event) => {
  const marker = event?.reducer_version == null ? 0 : Number(event.reducer_version)
  return (marker > 0 && marker < E.RETENTION_REDUCER_VERSION) || (marker === 0 && Number.isSafeInteger(event?.state_version_after)) ? 'legacy' : 'current'
}

const out = createWriteStream(output)
const taken = new Map()
const skipped = new Map()
let written = 0
for (const file of readdirSync(corpus).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()) {
  let row = 0
  for (const line of readFileSync(join(corpus, file), 'utf8').split('\n')) {
    if (!line) continue
    row += 1
    const entry = JSON.parse(line)
    if (!entry.outcome?.ok) continue
    const events = entry.outcome.events ?? []
    if (!events.some((event) => wanted(event.event_type) && (taken.get(event.event_type) ?? 0) < limit)) continue
    let state
    try {
      state = E.normalizeCampaignState(JSON.parse(readFileSync(join(corpus, 'states', `${entry.state}.json`), 'utf8')))
    } catch {
      continue
    }
    for (const [index, event] of events.entries()) {
      let next
      try {
        if (wanted(event.event_type) && (taken.get(event.event_type) ?? 0) < limit) {
          const mode = modeFor(event)
          const pre = E.withRetentionMode(mode, () => E.normalizeCampaignState(state))
          const again = E.withRetentionMode(mode, () => E.normalizeCampaignState(pre))
          if (JSON.stringify(again) !== JSON.stringify(pre)) {
            skipped.set(event.event_type, (skipped.get(event.event_type) ?? 0) + 1)
          } else {
            const post = E.applyGameEvent(pre, event)
            out.write(`${JSON.stringify({ file, row, index, event_type: event.event_type, mode, pre: JSON.parse(JSON.stringify(pre)), event, post: strip(post) })}\n`)
            taken.set(event.event_type, (taken.get(event.event_type) ?? 0) + 1)
            written += 1
          }
        }
        next = E.applyGameEvent(state, event)
      } catch {
        break
      }
      state = next
    }
  }
}
out.end()
console.log(`случаев: ${written}`)
console.log('по типам:', Object.fromEntries([...taken.entries()].sort()))
console.log('пропущено (не неподвижная точка):', Object.fromEntries([...skipped.entries()].sort()))
