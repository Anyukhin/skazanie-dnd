import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { IntentParser } from '../server/intent-parser.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { addPlayer, assertReplayMatches, createCampaign, createCampaignStore, createEngine, expectStatus, setupAdmin, startTestServer } from './kit/index.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

// Плейтест 2026-10-10 (D&D 2024): волшебница с заговором на панели написала
// «…швыряет в чудовище Огненный снаряд». Ни «заклин», ни «колдую» в тексте не
// было, заявка ушла к судье свободных действий и решалась проверкой навыка,
// а не командой `CastSpell` через Rules Engine.
const PLAYTEST = 'Мирель, истекая кровью, пятится от огра за спину Борина и швыряет в чудовище Огненный снаряд'

function battle() {
  return normalizeCampaignState({
    sessionCode: 'TEXT-SPELL', ruleset_id: 'srd_5_2_1', activePlayerId: 'mirel', partyMemberIds: ['mirel', 'borin'],
    players: [
      {
        id: 'mirel', character: 'Мирель', characterClass: 'wizard', level: 3, hp: 4, maxHp: 18, armor: 12,
        abilities: { int: 16, dex: 14 }, x: 1, y: 1, inventory: [],
        knownSpellIds: ['fire-bolt', 'ray-of-frost', 'mage-hand', 'magic-missile', 'shield', 'burning-hands', 'sleep'],
        preparedSpellIds: ['magic-missile', 'shield', 'burning-hands'],
      },
      { id: 'borin', character: 'Борин', characterClass: 'fighter', level: 3, hp: 28, maxHp: 28, armor: 18, abilities: { str: 16 }, x: 2, y: 1, inventory: [] },
    ],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 59, maxHp: 59, armor: 11, alive: true, x: 5, y: 1 }],
    scene: { title: 'Двор', location: 'Двор', cells: Array.from({ length: 32 }, (_, i) => ({ x: i % 8, y: Math.floor(i / 8), type: 'floor', revealed: true })) },
    mechanics: {
      positions: { mirel: { x: 1, y: 1 }, borin: { x: 2, y: 1 }, ogre: { x: 5, y: 1 } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mirel' }, { actor_id: 'borin' }, { actor_id: 'ogre' }],
        action_economy: { mirel: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

async function fixture(t, rolls = []) {
  const initial = battle()
  const eventStore = await createCampaignStore(t, 'TEXT-SPELL', initial)
  // Судья свободных действий (модель) в этом пути не участвует: механику
  // решает Rules Engine, Рассказчик лишь описывает уже записанный ход — как
  // у удара, заявленного текстом.
  const narrated = []
  const orchestrator = new GameOrchestrator({
    eventStore,
    rulesEngine: createEngine(rolls),
    narrator: { render: async (brief) => { narrated.push(brief); return { narration: 'Огненный снаряд срывается с пальцев Мирель.', provider: 'test-narrator' } } },
  })
  const turn = (message, idempotencyKey, extra = {}) => orchestrator.handle({
    campaignId: 'TEXT-SPELL', playerId: 'mirel', allowedActorIds: ['mirel'], state: initial, message, idempotencyKey, ...extra,
  })
  return { eventStore, turn, narrated }
}

test('названное заклинание героя узнаётся с падежами и без слова «заклинание»', async () => {
  const parser = new IntentParser()
  const state = battle()
  const parse = (message) => parser.parse({ message, playerId: 'mirel', visibleState: state })

  const thrown = await parse('Мирель швыряет в огра Огненный снаряд')
  assert.equal(thrown.intent, 'cast_spell')
  assert.equal(thrown.spell_id, 'fire-bolt')
  assert.equal(thrown.spell_with_movement, false)
  assert.deepEqual(thrown.targets, ['ogre'])
  assert.equal((await parse('Кидаю Волшебную стрелу в огра')).spell_id, 'magic-missile')
  assert.equal((await parse('Стреляю Лучом холода в огра')).spell_id, 'ray-of-frost')
  assert.equal((await parse('Колдую «Щит»')).spell_id, 'shield')

  const playtest = await parse(PLAYTEST)
  assert.equal(playtest.intent, 'cast_spell')
  assert.equal(playtest.spell_id, 'fire-bolt')
  assert.equal(playtest.spell_with_movement, true)

  // Однословное имя без слова сотворения — обычная речь, «от» — уклонение.
  assert.notEqual((await parse('Прикрываюсь щитом от огра')).intent, 'cast_spell')
  assert.equal((await parse('Уворачиваюсь от Огненного снаряда и бью огра')).intent, 'attack')
  // Чужое заклинание без слова сотворения остаётся судье свободных действий,
  // а со словом — честный отказ без расхода.
  assert.notEqual((await parse('Швыряю Огненный шар в огра')).intent, 'cast_spell')
  // Карточку без серверного исполнения движок блокирует; её творческое
  // применение по-прежнему решает судья свободных действий.
  assert.ok(!['verified', 'partial'].includes(canonicalCombatSpellFor('mage-hand', 'srd_5_2_1').mechanicsSupport))
  assert.notEqual((await parse('Использую Волшебную руку, чтобы открыть щеколду')).intent, 'cast_spell')
  const fireball = await parse('Колдую Огненный шар в огра')
  assert.equal(fireball.intent, 'cast_spell')
  assert.equal(fireball.spell_id, null)
  assert.deepEqual(fireball.unavailable_spells.map((spell) => spell.id), ['fireball'])
})

test('заклинание из текста исполняется той же командой CastSpell и переживает повтор и replay', async (t) => {
  // d20 атаки заклинанием, затем d10 урона «Огненного снаряда».
  const { eventStore, turn, narrated } = await fixture(t, [18, 7])
  const result = await turn('Мирель швыряет в огра Огненный снаряд', 'cast')

  const cast = result.mechanics.find((event) => event.event_type === 'SpellCast')
  assert.ok(cast, JSON.stringify(result.mechanics.map((event) => event.event_type)))
  assert.equal(cast.payload.spell_id ?? cast.payload.spell?.id, 'fire-bolt')
  assert.ok(result.mechanics.some((event) => event.event_type === 'AttackResolved'))
  assert.equal(result.authoritative_state.mechanics.combat.action_economy.mirel.action, false)
  assert.ok(result.authoritative_state.enemies[0].hp < 59)

  const duplicate = await turn('Мирель швыряет в огра Огненный снаряд', 'cast')
  assert.equal(duplicate.idempotent_replay, true)
  assert.deepEqual(duplicate.mechanics, result.mechanics)
  assert.equal(narrated.length, 1, 'повтор не зовёт Рассказчика второй раз')
  await assertReplayMatches(eventStore, 'TEXT-SPELL', { expected: result.authoritative_state })
})

test('отход со заклинанием, чужое заклинание, точка и пропущенная цель — уточнение без расхода', async (t) => {
  const { eventStore, turn } = await fixture(t)
  const answers = {
    [PLAYTEST]: /два шага.*«Огненный снаряд»/u,
    'Колдую Огненный шар в огра': /Мирель не может сотворить «Огненный шар»/u,
    'Колдую Усыпление на огра': /не может сотворить «Усыпление»/u,
    'Колдую Огненные ладони на огра': /«Огненные ладони» направляется в точку/u,
    'Кидаю Огненный снаряд': /В кого направить «Огненный снаряд»/u,
  }
  for (const [index, [message, expected]] of Object.entries(answers).entries()) {
    const result = await turn(message, `clarify-${index}`)
    assert.equal(result.action_kind, 'clarification', message)
    assert.match(result.narration, expected, message)
    assert.match(result.narration, /ничего не расходует/u, message)
    assert.deepEqual(result.mechanics, [], message)
  }
  assert.equal((await eventStore.load('TEXT-SPELL')).state_version, 0)
})

test('чужим героем заклинание из текста не сотворить', async (t) => {
  const { eventStore, turn } = await fixture(t)
  await assert.rejects(
    turn('Мирель швыряет в огра Огненный снаряд', 'foreign', { allowedActorIds: ['borin'] }),
    { code: 'ACTOR_FORBIDDEN' },
  )
  assert.equal((await eventStore.load('TEXT-SPELL')).state_version, 0)
})

test('игрок творит заклинание текстом через основной маршрут, чужой аккаунт — нет', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-text-spell-api-' })
  const { client: gm } = await setupAdmin(server)
  await createCampaign(gm, { code: 'TEXT-SPELL', state: battle() })
  const { client: owner } = await addPlayer(server, gm, 'TEXT-SPELL', { heroIds: ['mirel'] })
  const { client: stranger } = await addPlayer(server, gm, 'TEXT-SPELL', { heroIds: ['borin'] })
  // Тело — как у клиента (`src/ai-client.ts`).
  const narrate = (client, key) => client.post('/api/narrate', {
    campaignId: 'TEXT-SPELL', actor_id: 'mirel', action: 'Мирель швыряет в огра Огненный снаряд',
    idempotency_key: key, request_kind: 'action', manual_roll: true,
  })

  assert.equal((await narrate(stranger, 'stranger')).status, 403)
  const cast = expectStatus(await narrate(owner, 'owner'))
  assert.ok((cast.mechanics ?? []).some((event) => event.event_type === 'SpellCast'), JSON.stringify(cast.mechanics?.map((event) => event.event_type)))
  const room = expectStatus(await owner.get('/api/rooms/TEXT-SPELL'))
  assert.equal(room.state.mechanics.combat.action_economy.mirel.action, false)
})
