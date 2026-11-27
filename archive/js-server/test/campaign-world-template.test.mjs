import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { listWorldTemplates } from '../server/world-template-catalog.mjs'

const hero = {
  id: 'hero-template',
  character: 'Безымянный герой',
  name: 'Игрок',
  role: 'Воин · ур. 1',
  species: 'Человек',
  background: 'Странник',
  maxHp: 12,
}

test('каждый авторский мир создаётся без LLM и сохраняет точную карту, лор и фракции', async () => {
  let llmCalls = 0
  const bootstrapper = new CampaignBootstrapper({
    llmClient: { completeJson() { llmCalls += 1; throw new Error('Авторский шаблон не должен вызывать модель') } },
  })

  for (const [index, template] of listWorldTemplates().entries()) {
    const state = await bootstrapper.create({
      code: `AUTHORED-${index + 1}`,
      worldTemplateId: template.id,
      // Из пользовательского world у готового мира действует только safety-
      // граница. Остальные поля не имеют права подменить server-owned лор.
      world: {
        preset: 'Поддельный мир',
        premise: 'Поддельная история',
        startingLocation: 'Несуществующий старт',
        boundaries: 'Без натуралистичного насилия',
      },
      players: [{ ...hero, id: `hero-template-${index + 1}` }],
    })

    assert.equal(state.campaign, template.name)
    assert.equal(state.campaignConcept.world_template_id, template.id)
    assert.equal(state.campaignConcept.world_template_version, template.version)
    assert.equal(state.campaignConcept.generatedBy, 'authored-world-template')
    assert.equal(state.campaignConcept.boundaries, 'Без натуралистичного насилия')
    assert.notEqual(state.campaignConcept.preset, 'Поддельный мир')
    assert.notEqual(state.campaignConcept.premise, 'Поддельная история')
    assert.equal(state.scene.location, template.world.startingLocation)
    assert.equal(state.scene.location_id, state.worldMap.currentLocationId)
    assert.equal(state.worldMap.backgroundImage, template.image)
    assert.equal(state.worldMap.routesComplete, true)
    assert.equal(state.worldMap.regions.length, template.regionCount)
    assert.equal(state.worldMap.locations.length, template.locationCount)
    assert.equal(state.worldMap.routes.length, template.routeCount)
    assert.equal(state.worldMap.locations.find((location) => location.id === state.worldMap.currentLocationId)?.visited, true)
    assert.ok(state.worldMap.locations.every((location) => location.history && location.storyHooks?.length >= 2))
    const cityLocations = state.worldMap.locations.filter((location) => location.cityOverview)
    assert.equal(cityLocations.length, 1)
    assert.equal(cityLocations[0].id, state.worldMap.currentLocationId)
    assert.equal(cityLocations[0].cityOverview.districts.length, 6)
    assert.equal(cityLocations[0].cityOverview.places.length, 10)
    assert.equal(state.campaignConcept.factions.length, 5)
    assert.equal(state.campaignConcept.story_arcs.length, 3)
    const factionEntities = state.worldMemory.entities.filter((entity) => entity.kind === 'faction')
    assert.equal(factionEntities.length, 5)
    const factionIds = new Set(factionEntities.map((entity) => entity.id))
    assert.ok(state.social.npcs.every((npc) => npc.tags.some((tag) => tag.startsWith('faction:') && factionIds.has(tag.slice('faction:'.length)))))
  }

  assert.equal(llmCalls, 0)
})

test('название стола переопределяет название шаблона, но не его географию', async () => {
  const template = listWorldTemplates()[0]
  const state = await new CampaignBootstrapper().create({
    code: 'AUTHORED-NAMED',
    name: 'Моя хроника прилива',
    partyName: 'Искатели колоколов',
    worldTemplateId: template.id,
    players: [hero],
  })
  assert.equal(state.campaign, 'Моя хроника прилива')
  assert.equal(state.partyName, 'Искатели колоколов')
  assert.equal(state.worldMap.name, 'Карта Лиги Девяти Отливов')
  assert.equal(state.scene.location, template.world.startingLocation)
})

test('неизвестный id авторского мира отклоняется до создания состояния', async () => {
  await assert.rejects(
    () => new CampaignBootstrapper().create({
      code: 'AUTHORED-BAD', worldTemplateId: 'invented-world', players: [hero],
    }),
    (error) => error?.code === 'WORLD_TEMPLATE_INVALID',
  )
})

test('авторский мир совпадает после reopen и replay', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-world-template-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const reducer = (state) => structuredClone(state)
  const template = listWorldTemplates()[2]
  const state = await new CampaignBootstrapper().create({
    code: 'AUTHORED-REPLAY', worldTemplateId: template.id, players: [hero],
  })
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
  assert.equal(replayed.state.campaignConcept.world_template_id, template.id)
  assert.deepEqual(replayed.state.worldMap, state.worldMap)
  assert.deepEqual(replayed.state.campaignConcept.story_arcs, state.campaignConcept.story_arcs)
})
