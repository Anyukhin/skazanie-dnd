import assert from 'node:assert/strict'
import test from 'node:test'

import { createClient, startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

test('HTTP-каталог не раскрывает полный шаблон, а POST создаёт server-owned авторский мир', { timeout: runnerTimeout(30_000) }, async (t) => {
  const server = await startTestServer(t, { setupToken: 'world-template-setup' })
  const logs = server.output

  const unauthorized = await createClient(server).get('/api/world-templates')
  assert.equal(unauthorized.status, 401)

  const setup = await createClient(server).post('/api/auth/setup-admin', {
    name: 'Admin', email: 'world-template-admin@example.test', password: 'very-secure-password', setupToken: 'world-template-setup',
  })
  assert.equal(setup.status, 201, `${setup.text}\n${logs()}`)
  const player = createClient(server)
  const registered = await player.post('/api/auth/register', {
    name: 'Cartographer', email: 'cartographer@example.test', password: 'very-secure-player-password',
  })
  assert.equal(registered.status, 201, registered.text)
  assert.ok(player.cookie)

  const catalog = await player.get('/api/world-templates')
  assert.equal(catalog.status, 200, catalog.text)
  assert.equal(catalog.body.templates.length, 4)
  assert.deepEqual(catalog.body.templates.map((template) => template.id), [
    'league-nine-tides', 'unfading-star-belt', 'ashen-garden-bowl', 'astohan-plains',
  ])
  for (const template of catalog.body.templates) {
    assert.equal(Object.hasOwn(template, 'worldMap'), false)
    assert.equal(Object.hasOwn(template, 'world_map'), false)
    assert.equal(Object.hasOwn(template, 'worldHistory'), false)
    assert.match(template.image, /^\/assets\/maps\/world\/skazanie\/.+-v[1-9][0-9]*\.webp$/u)
    assert.equal(template.locationCount, 14)
    assert.equal(template.routeCount, 18)
    assert.equal(template.cityOverviewCount, 1)
  }

  const created = await player.post('/api/campaigns', {
    code: 'TIDE-TEMPLATE', name: '',
    bootstrap: {
      partyName: '', slotCount: 1, rulesetId: 'srd_5_2_1', worldTemplateId: 'league-nine-tides',
      world: { premise: 'Подмена', startingLocation: 'Подмена', boundaries: 'Без боди-хоррора' },
    },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs()}`)
  assert.equal(created.body.state.campaign, 'Лига Девяти Отливов')
  assert.equal(created.body.state.campaignConcept.world_template_id, 'league-nine-tides')
  assert.equal(created.body.state.campaignConcept.generatedBy, 'authored-world-template')
  assert.equal(created.body.state.campaignConcept.boundaries, 'Без боди-хоррора')
  assert.notEqual(created.body.state.campaignConcept.premise, 'Подмена')
  assert.equal(created.body.state.scene.location, 'Вельдбург')
  assert.equal(created.body.state.worldMap.locations.length, 14)
  assert.equal(created.body.state.worldMap.routes.length, 18)
  assert.equal(created.body.state.worldMap.backgroundImage, '/assets/maps/world/skazanie/nine-tides-v2.webp')
  const cityOverview = created.body.state.worldMap.locations.find((location) => location.id === 'tides-veld-burg').cityOverview
  assert.equal(cityOverview.image, '/assets/maps/city/skazanie/veld-burg-v1.webp')
  assert.equal(cityOverview.districts.length, 6)
  assert.equal(cityOverview.places.length, 10)

  const unknown = await player.post('/api/campaigns', {
    code: 'TEMPLATE-BAD', bootstrap: { partyName: '', slotCount: 1, world: {}, worldTemplateId: 'invented-world' },
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'WORLD_TEMPLATE_INVALID')

  const forgedVersion = await player.post('/api/campaigns', {
    code: 'TEMPLATE-FORGE', bootstrap: { partyName: '', slotCount: 1, world: {}, worldTemplateId: 'league-nine-tides', worldTemplateVersion: '999' },
  })
  assert.equal(forgedVersion.status, 400)
  assert.equal(forgedVersion.body.code, 'WORLD_TEMPLATE_FIELDS_SERVER_OWNED')

  const forgedMap = await player.post('/api/campaigns', {
    code: 'TEMPLATE-MAP-FORGE', bootstrap: { partyName: '', slotCount: 1, world: {}, worldMap: { locations: [] } },
  })
  assert.equal(forgedMap.status, 400)
  assert.equal(forgedMap.body.code, 'WORLD_TEMPLATE_FIELDS_SERVER_OWNED')
})
