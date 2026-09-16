import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { normalizeWorldMemory } from '../server/world-memory.mjs'
import { palaceFixture } from './shared-npc-consequence-fixture.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const SESSION = 'WORLD-DATA-FLOW'
const SETUP_TOKEN = 'world-data-flow-setup-token'
const HERO_ID = 'consequence-wizard'
const NPC_ID = 'astohan-ares'

async function freePort() {
  const probe = await new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: SETUP_TOKEN,
      GAME_ENGINE_MODE: 'enforce',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Тестовый сервер не завершился')), 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился до health\n${logs()}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`, { headers: { Connection: 'close' } })).ok) return
    } catch { /* listener ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Тестовый сервер не стал healthy\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body, key = '' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Connection: 'close',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { 'X-Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* assertion reports body */ }
  return { response, status: response.status, body: parsed, text }
}

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

function memoryEntity(id) {
  return { id, kind: 'concept', name: id, summary: `Сущность ${id}`, visibility: 'party', tags: [] }
}

function memoryFact(id, subjectId = 'entity-0') {
  return {
    id,
    subject_id: subjectId,
    predicate: 'recorded',
    object: `Факт ${id}`,
    summary: `Подтверждённый факт ${id}`,
    visibility: 'party',
    source_event_ids: [`event:${id}`],
    source_command_id: `command:${id}`,
    status: 'active',
  }
}

function memoryRelationship(id, from = 'entity-0', to = 'entity-1') {
  return {
    id,
    from_entity_id: from,
    relation: 'connected',
    to_entity_id: to,
    summary: `Связь ${id}`,
    visibility: 'party',
    source_event_ids: [`event:${id}`],
    source_command_id: `command:${id}`,
    status: 'active',
  }
}

function memoryQuest(id, entityId = 'entity-0') {
  return {
    id,
    title: `Задание ${id}`,
    summary: `Долгая нить ${id}`,
    status: 'active',
    visibility: 'party',
    entity_ids: [entityId],
    objectives: [`Цель ${id}`],
    clock: { current: 0, max: 4, label: 'Прогресс' },
  }
}

test('сохранность мира не теряет 501-ю сущность и связанные записи', () => {
  const memory = normalizeWorldMemory({
    entities: Array.from({ length: 501 }, (_, index) => memoryEntity(`entity-${index}`)),
    facts: [memoryFact('fact-tail', 'entity-500')],
    relationships: [memoryRelationship('relation-tail', 'entity-0', 'entity-500')],
    quests: [memoryQuest('quest-tail', 'entity-500')],
    knowledge_ledger: [{
      id: 'knowledge-tail', hero_id: 'hero-1', fact_id: 'fact-tail', summary: 'Герой знает последний факт',
      source_event_ids: ['event:reveal-tail'], source_command_id: 'command:reveal-tail', source_kind: 'knowledge_revealed',
    }],
  })

  assert.ok(memory.entities.some((entity) => entity.id === 'entity-500'))
  assert.ok(memory.facts.some((fact) => fact.id === 'fact-tail'))
  assert.ok(memory.relationships.some((relationship) => relationship.id === 'relation-tail'))
  assert.ok(memory.quests.some((quest) => quest.id === 'quest-tail'))
  assert.ok(memory.knowledge_ledger.some((entry) => entry.id === 'knowledge-tail'))
  assert.deepEqual(normalizeWorldMemory(memory), memory)
})

test('сохранность мира не отсекает факты, отношения и задания за прежними пределами', () => {
  const memory = normalizeWorldMemory({
    entities: [memoryEntity('entity-0'), memoryEntity('entity-1')],
    facts: Array.from({ length: 2_001 }, (_, index) => memoryFact(index === 2_000 ? 'fact-tail' : `fact-${index}`)),
    relationships: Array.from({ length: 2_001 }, (_, index) => memoryRelationship(index === 2_000 ? 'relation-tail' : `relation-${index}`)),
    quests: Array.from({ length: 301 }, (_, index) => memoryQuest(index === 300 ? 'quest-tail' : `quest-${index}`)),
  })

  assert.ok(memory.facts.some((fact) => fact.id === 'fact-tail'))
  assert.ok(memory.relationships.some((relationship) => relationship.id === 'relation-tail'))
  assert.ok(memory.quests.some((quest) => quest.id === 'quest-tail'))
  assert.deepEqual(normalizeWorldMemory(memory), memory)
})

test('длинный журнал знаний сохраняет раннее знание после нормализации', () => {
  const memory = normalizeWorldMemory({
    entities: [memoryEntity('entity-0')],
    facts: [memoryFact('fact-0')],
    knowledge_ledger: Array.from({ length: 5_001 }, (_, index) => ({
      id: `knowledge-${index}`,
      hero_id: 'hero-1',
      fact_id: 'fact-0',
      summary: `Знание ${index}`,
      source_event_ids: [`event:knowledge-${index}`],
      source_command_id: `command:knowledge-${index}`,
      source_kind: 'knowledge_revealed',
    })),
  })

  assert.ok(memory.knowledge_ledger.some((entry) => entry.id === 'knowledge-0'))
  assert.ok(memory.knowledge_ledger.some((entry) => entry.id === 'knowledge-5000'))
  assert.deepEqual(normalizeWorldMemory(memory), memory)
})

test('обычный игрок сохраняет смерть NPC, добычу, квест и историю через уход, возврат и restart', { timeout: runnerTimeout(120_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-world-data-flow-'))
  let child = null
  let baseUrl = ''
  let logs = ''
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  const launch = async () => {
    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}`
    child = startServer(port, storage, (chunk) => { logs += chunk })
    await waitForHealth(baseUrl, child, () => logs)
  }

  await launch()
  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Ведущий', email: 'gm@world-data-flow.test', password: 'world-data-flow-password', setupToken: SETUP_TOKEN },
  })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Игрок', email: 'player@world-data-flow.test', password: 'world-data-flow-password' },
  })
  assert.equal(owner.status, 201, `${owner.text}\n${logs}`)
  const adminCookie = sessionCookie(admin)
  const ownerCookie = sessionCookie(owner)

  const fixture = await palaceFixture({ kingHp: 1, witnesses: false })
  const blade = {
    ...materializeCatalogItem('srd_5_2_1:longsword', { id: 'ares-oathblade-instance', quantity: 1 }),
    item_instance_id: 'ares-oathblade-instance',
    origin: 'enemy_loadout',
  }
  fixture.state.npc_world.inventories = { [NPC_ID]: [blade] }
  const baseEntityId = fixture.state.worldMemory.entities[0].id
  const flowEntityTailId = 'flow-entity-500'
  const flowFactTailId = 'flow-fact-1999'
  const flowKnowledgeTailId = 'flow-knowledge-tail'
  fixture.state.worldMemory.entities.push(...Array.from({ length: 501 }, (_, index) => ({
    id: `flow-entity-${index}`, kind: 'concept', name: `E${index}`,
    ...(index === 500 ? { visibility: 'party' } : {}),
  })))
  fixture.state.worldMemory.facts.push(...Array.from({ length: 2_000 }, (_, index) => ({
    id: index === 1_999 ? flowFactTailId : `flow-fact-${index}`,
    subject_id: baseEntityId, predicate: 'recorded', object: 'x',
    ...(index === 1_999 ? { visibility: 'party' } : {}),
  })))
  fixture.state.worldMemory.quests.push(...Array.from({ length: 300 }, (_, index) => ({
    id: index === 299 ? 'flow-quest-299' : `flow-quest-${index}`,
    title: 'Q', status: 'completed', visibility: 'party',
  })))
  fixture.state.worldMemory.knowledge_ledger.push({
    id: flowKnowledgeTailId, hero_id: HERO_ID, fact_id: flowFactTailId, summary: 'x', source_kind: 'knowledge_revealed',
  })
  const prepared = normalizeCampaignState(fixture.state)
  assert.ok(prepared.worldMemory.entities.some((entity) => entity.id === flowEntityTailId))
  assert.ok(prepared.worldMemory.facts.some((fact) => fact.id === flowFactTailId))
  assert.ok(prepared.worldMemory.knowledge_ledger.some((entry) => entry.id === flowKnowledgeTailId))
  const initial = resolveCommands([
    { command_type: 'AttackNpc', command_id: 'world-data-flow-initiative', actor_id: HERO_ID, npc_id: NPC_ID },
  ], prepared, {
    diceService: new DiceService({ rng: new SequenceDiceRng([20, 1]) }),
    context: { allowedActorIds: [HERO_ID] },
  }).state
  initial.sessionCode = SESSION
  assert.ok(JSON.stringify(initial).length < 1_000_000, 'fixture должен проходить действующий лимит тела HTTP-запроса')

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const ownerId = users.body.users.find((candidate) => candidate.email === 'player@world-data-flow.test').id
  const assigned = await request(baseUrl, `/api/admin/users/${ownerId}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: [HERO_ID] },
  })
  assert.equal(assigned.status, 200, `${assigned.text}\n${logs}`)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie,
    body: { code: SESSION, name: 'Мир после смерти короля', state: initial },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)

  const castKey = 'world-data-flow-fireball'
  const spellCommand = {
    command_type: 'CastSpell', actor_id: HERO_ID, spell_id: 'fireball', to: fixture.kingPoint,
  }
  const cast = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: castKey,
    body: { idempotency_key: castKey, command: spellCommand },
  })
  assert.equal(cast.status, 200, `${cast.text}\n${logs}`)
  const castTypes = cast.body.mechanics.map((event) => event.event_type)
  for (const type of ['SpellCast', 'DamageApplied', 'NpcDied', 'LootContainerCreated', 'QuestInvalidated', 'CampaignStoryCompleted']) {
    assert.ok(castTypes.includes(type), `${type}: ${JSON.stringify(cast.body.mechanics)}`)
  }
  const afterDeath = cast.body.authoritative_state
  const questId = fixture.state.campaignConcept.story_quest_id
  assert.ok(afterDeath.worldMemory.facts.some((fact) => fact.id === flowFactTailId))
  assert.ok(afterDeath.worldMemory.facts.some((fact) => fact.subject_id === NPC_ID && fact.predicate === 'died'), 'факт смерти должен быть записан поверх старого предела')
  assert.equal(afterDeath.worldMemory.quests.find((quest) => quest.id === questId).status, 'failed')
  assert.equal(afterDeath.campaignConcept.story_history.length, 1)
  assert.equal(afterDeath.campaignConcept.story_history[0].outcome, 'failure')
  const visibleContainer = afterDeath.loot_containers?.containers?.find((container) => container.item_count === 1)
  assert.ok(visibleContainer, `Контейнер добычи не попал в проекцию игрока: ${JSON.stringify(afterDeath.loot_containers)}`)
  const containerId = visibleContainer.id
  assert.equal(visibleContainer.can_inspect, false)

  const repeatedCast = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: castKey,
    body: { idempotency_key: castKey, command: spellCommand },
  })
  assert.equal(repeatedCast.status, 200, `${repeatedCast.text}\n${logs}`)
  assert.equal(repeatedCast.body.idempotent_replay, true)
  assert.equal(repeatedCast.body.authoritative_state.campaignConcept.story_history.length, 1)

  const leaveAction = '[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id=astohan-ash-watch] Отряд предлагает отправиться из «Штормберг» в «Пепельная застава».'
  const leave = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: ownerCookie,
    body: { campaignId: SESSION, idempotency_key: 'world-data-flow-leave', action: leaveAction },
  })
  assert.equal(leave.status, 200, `${leave.text}\n${logs}`)
  assert.equal(leave.body.authoritative_state.scene.location_id, 'astohan-ash-watch')

  const returnAction = '[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id=astohan-stormberg] Отряд предлагает отправиться из «Пепельная застава» в «Штормберг».'
  const returned = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: ownerCookie,
    body: { campaignId: SESSION, idempotency_key: 'world-data-flow-return', action: returnAction },
  })
  assert.equal(returned.status, 200, `${returned.text}\n${logs}`)
  assert.equal(returned.body.authoritative_state.scene.location_id, 'astohan-stormberg')
  const returnedContainer = returned.body.authoritative_state.loot_containers?.containers?.find((container) => container.id === containerId)
  assert.ok(returnedContainer, `Добыча не пережила уход и возврат: ${JSON.stringify(returned.body.authoritative_state.loot_containers)}`)
  assert.equal(returnedContainer.item_count, 1)

  const moved = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'world-data-flow-approach',
    body: { idempotency_key: 'world-data-flow-approach', command: { command_type: 'MoveActor', actor_id: HERO_ID, to: { x: 12, y: 5 } } },
  })
  assert.equal(moved.status, 200, `${moved.text}\n${logs}`)
  const nearRoom = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: ownerCookie })
  assert.equal(nearRoom.status, 200, `${nearRoom.text}\n${logs}`)
  const nearContainer = nearRoom.body.state.loot_containers.containers.find((container) => container.id === containerId)
  assert.ok(nearContainer?.can_inspect, `Герой не получил защищённое содержимое тела: ${JSON.stringify(nearRoom.body.state.loot_containers)}`)
  const lootItemId = nearContainer.items[0].item_instance_id

  const lootKey = 'world-data-flow-loot'
  const lootCommand = {
    command_type: 'LootContainer', actor_id: HERO_ID, container_id: containerId,
    lines: [{ item_instance_id: lootItemId, quantity: 1 }],
  }
  const looted = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: lootKey,
    body: { idempotency_key: lootKey, command: lootCommand },
  })
  assert.equal(looted.status, 200, `${looted.text}\n${logs}`)
  assert.ok(looted.body.mechanics.some((event) => event.event_type === 'LootContainerTaken'))
  const inventoryAfterLoot = looted.body.authoritative_state.players.find((player) => player.id === HERO_ID).inventory
  assert.equal(inventoryAfterLoot.filter((item) => item.catalog_id === 'srd_5_2_1:longsword').length, 1)

  const repeatedLoot = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: lootKey,
    body: { idempotency_key: lootKey, command: lootCommand },
  })
  assert.equal(repeatedLoot.status, 200, `${repeatedLoot.text}\n${logs}`)
  assert.equal(repeatedLoot.body.idempotent_replay, true)
  assert.equal(repeatedLoot.body.authoritative_state.players.find((player) => player.id === HERO_ID).inventory
    .filter((item) => item.catalog_id === 'srd_5_2_1:longsword').length, 1)

  await stopServer(child)
  child = null
  await launch()
  const restored = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: ownerCookie })
  assert.equal(restored.status, 200, `${restored.text}\n${logs}`)
  const restoredState = restored.body.state
  assert.equal(restoredState.scene.location_id, 'astohan-stormberg')
  assert.equal(restoredState.social.npcs.find((npc) => npc.id === NPC_ID).available, false)
  assert.equal(restoredState.worldMemory.quests.find((quest) => quest.id === questId).status, 'failed')
  assert.equal(restoredState.campaignConcept.story_history.length, 1)
  assert.ok(restoredState.worldMemory.entities.some((entity) => entity.id === flowEntityTailId))
  assert.ok(restoredState.worldMemory.facts.some((fact) => fact.id === flowFactTailId))
  assert.ok(restoredState.worldMemory.facts.some((fact) => fact.subject_id === NPC_ID && fact.predicate === 'died'))
  assert.ok(restoredState.worldMemory.knowledge_ledger.some((entry) => entry.id === flowKnowledgeTailId))
  assert.equal(restoredState.players.find((player) => player.id === HERO_ID).inventory
    .filter((item) => item.catalog_id === 'srd_5_2_1:longsword').length, 1)

  const replayAfterRestart = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie: ownerCookie, key: lootKey,
    body: { idempotency_key: lootKey, command: lootCommand },
  })
  assert.equal(replayAfterRestart.status, 200, `${replayAfterRestart.text}\n${logs}`)
  assert.equal(replayAfterRestart.body.idempotent_replay, true)
  assert.equal(replayAfterRestart.body.authoritative_state.players.find((player) => player.id === HERO_ID).inventory
    .filter((item) => item.catalog_id === 'srd_5_2_1:longsword').length, 1)
})
