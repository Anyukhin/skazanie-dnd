import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { NpcSocialController } from '../server/npc-social-controller.mjs'
import { isIndoors, weatherForViewer } from '../server/weather.mjs'

const hero = (id) => ({
  id, character: 'Аудитор', name: 'Игрок', role: 'Воин · ур. 1',
  species: 'Человек', background: 'Странник', maxHp: 12,
})

async function astohan(code = 'OPENING-MEMORY') {
  return new CampaignBootstrapper().create({
    code, worldTemplateId: 'astohan-plains', players: [hero(`hero-${code.toLocaleLowerCase()}`)],
  })
}

test('публичный пролог становится знанием партии и Ареса, а дворец выключает погоду', async () => {
  const state = await astohan()
  const location = state.worldMemory.entities.find((entity) => entity.kind === 'location' && entity.name === 'Штормберг')
  const facts = state.worldMemory.facts.filter((fact) => fact.predicate === 'opening_narration')
  const ares = state.social.npcs.find((npc) => npc.id === 'astohan-ares')

  assert.ok(location, 'стартовая локация должна иметь canonical entity')
  assert.ok(facts.length > 0, 'пролог должен попасть в память мира')
  assert.ok(facts.every((fact) => fact.subject_id === location.id && fact.visibility === 'party'))
  assert.ok(facts.some((fact) => /Саргат/u.test(fact.summary) && /три донесения/u.test(fact.summary)))
  assert.deepEqual(ares.known_fact_ids, facts.map((fact) => fact.id))

  let request = null
  await new NpcSocialController({
    llmClient: { async completeJson(input) { request = input; return { reply: 'Я расскажу о Саргате.', disclosed_fact_ids: [], relationship_delta: 0 } } },
  }).respond({
    state, playerId: state.players[0].id, npcId: 'astohan-ares',
    message: 'Расскажите о драконе Саргате и трёх донесениях.', turnId: 'opening-memory-dialogue',
  })
  assert.match(request.messages[1].content, /Саргата/u)
  assert.match(request.messages[1].content, /три донесения/u)

  assert.equal(state.scene.map.theme, 'building')
  assert.equal(isIndoors(state), true)
  assert.equal(weatherForViewer(state).indoors, true)
  assert.deepEqual(weatherForViewer(state).effects, [])
})

test('стартовое знание и indoor metadata переживают replay', async (t) => {
  const state = await astohan('OPENING-REPLAY')
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-opening-memory-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const reducer = (current) => structuredClone(current)
  const store = new FileEventStore({ rootDir, reducer })
  await store.initializeCampaign({
    campaign_id: state.sessionCode,
    initial_state: state,
    ruleset_id: state.ruleset_id,
    ruleset_version: state.ruleset_version,
    enabled_rule_packs: state.enabled_rule_packs,
    enabled_house_rules: state.enabled_house_rules,
  })

  const reopened = new FileEventStore({ rootDir, reducer })
  const replayed = await reopened.replay(state.sessionCode, { use_snapshots: false })
  assert.deepEqual(replayed.state.worldMemory.facts, state.worldMemory.facts)
  assert.deepEqual(
    replayed.state.social.npcs.find((npc) => npc.id === 'astohan-ares')?.known_fact_ids,
    state.social.npcs.find((npc) => npc.id === 'astohan-ares')?.known_fact_ids,
  )
  assert.equal(replayed.state.scene.map.theme, 'building')
})

test('свободная кампания тоже запоминает только свой канонический пролог', async () => {
  const state = await new CampaignBootstrapper().create({
    code: 'OPENING-GENERATED',
    world: {
      startingLocation: 'Станция «Тихая гавань»',
      openingSituation: 'Неизвестный сигнал приходит из закрытого шлюза.',
      premise: 'Первый контакт меняет порядок на станции.',
    },
    players: [hero('hero-generated')],
  })
  const facts = state.worldMemory.facts.filter((fact) => fact.predicate === 'opening_narration')
  assert.ok(facts.length > 0)
  assert.equal(facts.map((fact) => fact.summary).join('\n\n'), state.messages[0].text)
  assert.doesNotMatch(JSON.stringify(facts), /Земли вокруг Станции/u)
})
