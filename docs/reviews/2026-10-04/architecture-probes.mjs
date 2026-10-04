import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import { DiceService, SequenceDiceRng } from '../../../server/dice-service.mjs'
import { createFileEventStore } from '../../../server/event-store.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../../../server/rules-engine.mjs'
import { loadRulePack, validateRulePack } from '../../../server/rule-pack.mjs'
import { RuleRetriever } from '../../../server/rule-retriever.mjs'

const freshRoot = () => mkdtempSync(join(tmpdir(), 'skazanie-architecture-probe-'))
const eventStore = (root, initialStateFactory = () => ({})) => createFileEventStore({
  rootDir: root,
  reducer: applyGameEvent,
  normalizeState: normalizeCampaignState,
  initialStateFactory,
})

async function main() {
  const roots = []
  try {
    const rulesetRoot = freshRoot(); roots.push(rulesetRoot)
    const rulesetStore = eventStore(rulesetRoot, () => ({
      ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_rule_packs: ['dnd_5e_2014'],
    }))
    const rulesetCommit = await rulesetStore.commit({
      campaignId: 'ARC-01', expectedStateVersion: 0, idempotencyKey: 'arc-01',
      events: [{ event_type: 'PublicDieRolled', payload: { roll: { total: 1 } } }],
    })
    assert.equal(rulesetCommit.state.ruleset_id, 'dnd_5e_2014')
    assert.equal(rulesetCommit.metadata.ruleset_id, 'srd_5_2_1')

    const unknownRoot = freshRoot(); roots.push(unknownRoot)
    const unknownStore = eventStore(unknownRoot)
    const unknownCommit = await unknownStore.commit({
      campaignId: 'ARC-02', expectedStateVersion: 0, idempotencyKey: 'arc-02',
      events: [{ event_type: 'TypoEvent', payload: { hp: 999 } }],
    })
    assert.equal(unknownCommit.state.state_version, 1)
    assert.equal(unknownCommit.events[0].event_type, 'TypoEvent')

    const unknownRuleset = normalizeCampaignState({
      ruleset_id: 'made-up', players: [{ id: 'hero', hp: 10, maxHp: 10, abilities: { str: 16 } }],
    })
    const check = resolveCommand({ command_type: 'MakeAbilityCheck', actor_id: 'hero', ability: 'str', difficulty: 10 }, unknownRuleset, {
      diceService: new DiceService({ rng: new SequenceDiceRng([10]), idFactory: () => 'probe-roll' }),
    })
    assert.equal(unknownRuleset.ruleset_id, 'made-up')
    assert.ok(check.events[0].source_rule_ids.includes('srd_5_2_1:checks:ability-check'))

    const pack = await loadRulePack('srd_5_2_1', { freeze: false })
    pack.rules[0].entity_refs = ['missing:term']
    assert.doesNotThrow(() => validateRulePack(pack, { expectedRulesetId: 'srd_5_2_1' }))

    const duplicate = structuredClone(await loadRulePack('srd_5_2_1', { freeze: false }))
    duplicate.manifest.pack_id = 'srd_5_2_1-addon-probe'
    const retriever = new RuleRetriever([pack, duplicate])
    const search = await retriever.search({
      query: 'advantage', ruleset_id: 'srd_5_2_1', enabled_packs: ['srd_5_2_1', 'srd_5_2_1-addon-probe'], limit: 50,
    })
    assert.ok(search.results.length > 0)
    assert.ok(search.results.every((entry) => entry.pack_id === 'srd_5_2_1-addon-probe'))

    const raw = { players: [{ id: 'hero', hp: 10, maxHp: 10, abilities: { str: 16 } }] }
    const before = structuredClone(raw)
    const normalized = normalizeCampaignState(raw)
    assert.deepEqual(raw, before)
    const event = { event_type: 'PublicDieRolled', payload: { roll: { total: 1 } }, state_version_after: 1, reducer_version: 15 }
    assert.deepEqual(applyGameEvent(normalized, event), replayEvents(normalized, [event]))

    let state = normalized
    const started = performance.now()
    for (let index = 1; index <= 100; index += 1) {
      state = applyGameEvent(state, { ...event, state_version_after: index })
    }
    console.log(JSON.stringify({
      arc01_metadata_mismatch: true,
      arc02_unknown_event_committed: true,
      arc04_unknown_ruleset_used_legacy_rule: true,
      arc05_unknown_entity_ref_accepted: true,
      arc06_duplicate_rule_id_shadowed_by_last_pack: true,
      arc07_input_unchanged: true,
      arc07_100_apply_ms: Number((performance.now() - started).toFixed(2)),
    }, null, 2))
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
}

await main()
