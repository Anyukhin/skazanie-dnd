// Ось «ИИ-ведущий»: «Отказ или недоступность LLM не повреждает состояние и не
// даёт механического преимущества. Для критических переходов обязан быть
// детерминированный fallback».
//
// У каждой роли свой catch, и каждый по отдельности выглядит правильно. Здесь
// проверяется свойство целиком и одним правилом: **отказ модели обязан дать
// ровно то же, что даёт отсутствие ключа**. Третьего поведения быть не должно —
// именно в нём и заводится расхождение, которое на глаз не видно.
//
// Роль, добавленная без fallback, упадёт здесь на первом же прогоне.
import assert from 'node:assert/strict'
import test from 'node:test'

import { ActionAdjudicator } from '../server/action-adjudicator.mjs'
import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { DirectorAgent } from '../server/director-agent.mjs'
import { Narrator } from '../server/narrator.mjs'
import { NpcMoraleAgent } from '../server/npc-controller.mjs'
import { NpcSocialController } from '../server/npc-social-controller.mjs'
import { interpretFreeAction } from '../server/free-action-adjudication.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'

class RefusingClient {
  constructor(code = 'LLM_PROVIDER_ERROR') { this.code = code }

  async completeJson() {
    const error = new Error('провайдер недоступен')
    error.code = this.code
    throw error
  }
}

function state() {
  return normalizeCampaignState({
    sessionCode: 'REFUSAL',
    campaign_id: 'REFUSAL',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Лира', hp: 24, maxHp: 24, armor: 12, speed: 30,
      abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 14, cha: 10 },
      x: 0, y: 0, inventory: [],
    }],
    enemies: [{
      id: 'wolf', name: 'волк', kind: 'зверь', hp: 5, maxHp: 20, armor: 11,
      abilities: { str: 14, dex: 12, con: 12, int: 4, wis: 12, cha: 6 }, x: 1, y: 0, alive: true,
    }],
    scene: {
      turn: 1, location: 'Тракт', title: 'Тракт', objective: 'Найти пропажу',
      cells: Array.from({ length: 9 }, (_, index) => ({ x: index % 3, y: Math.floor(index / 3), type: 'floor', revealed: true })),
    },
    mechanics: {
      world_time: { elapsed_minutes: 0 },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'wolf', total: 10 }],
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          wolf: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
    worldMemory: {
      entities: [{ id: 'trakt', kind: 'location', name: 'Тракт', summary: '', aliases: [], visibility: 'party', tags: [] }],
      facts: [], quests: [], knowledge: {},
    },
    social: {
      npcs: [{
        id: 'marta', name: 'Марта', role: 'дозорная', location: 'Тракт', public_summary: 'Дозорная тракта.',
        voice: 'Кратко.', goals: [], beliefs: [], known_fact_ids: [], visibility: 'party', available: true, tags: [],
      }],
      relationships: { marta: { hero: 0 } },
      conversations: [],
      promises: [],
    },
  })
}

const NARRATION_BRIEF = Object.freeze({
  visible_events: [{ event_type: 'ActorMoved', payload: { distance: 10 }, target_ids: ['hero'] }],
  visible_state_changes: [],
  known_environment: {},
  permitted_npc_reactions: [],
})

/**
 * Каждая роль описана двумя способами её позвать: без клиента и с отказывающим.
 * `strip` убирает поля, которые честно обязаны отличаться, — метку провайдера и
 * причину отказа. Всё остальное обязано совпасть.
 */
const ROLES = [
  {
    name: 'DirectorAgent',
    call: (client) => new DirectorAgent({ llmClient: client }).choose({ state: state(), playerAction: 'осмотреться' }),
    strip: ({ intent }) => ({ intent }),
  },
  {
    name: 'NpcMoraleAgent',
    call: (client) => new NpcMoraleAgent({ llmClient: client }).decide({ state: state(), enemyId: 'wolf' }),
    strip: ({ provider: _provider, provider_error: _error, ...rest }) => rest,
  },
  {
    name: 'NpcSocialController',
    call: (client) => new NpcSocialController({ llmClient: client })
      .respond({ state: state(), playerId: 'hero', npcId: 'marta', message: 'Что нового?', turnId: 'turn-1' }),
    strip: ({ provider: _provider, provider_error: _error, facts_available: _facts, ...rest }) => rest,
  },
  {
    name: 'Narrator',
    call: (client) => new Narrator({ llmClient: client }).render(NARRATION_BRIEF),
    strip: ({ provider: _provider, verification, ...rest }) => ({ ...rest, valid: verification?.valid }),
  },
  {
    name: 'SceneArchitectAgent',
    call: (client) => new SceneArchitectAgent({ llmClient: client })
      .plan({ action: 'Отряд уходит на север', state: state(), decision: 'идём на север', destinationHint: 'Север' }),
    strip: ({ trace: _trace, ...rest }) => rest,
  },
  {
    name: 'ActionAdjudicator',
    call: (client) => new ActionAdjudicator({ llmClient: client })
      .read(state(), 'hero', 'подпираю дверь скамьёй', interpretFreeAction('подпираю дверь скамьёй')),
    strip: ({ source: _source, ...rest }) => rest,
  },
  {
    // Создание кампании — самый критический переход из всех: продуктовые
    // принципы требуют, чтобы кампания становилась `active` только после
    // валидной серверной инициализации. Отказ провайдера обязан оставить её
    // играбельной, а не полупустой.
    name: 'CampaignBootstrapper',
    call: (client) => new CampaignBootstrapper({ llmClient: client }).create({
      code: 'REFUSAL-1', name: 'Проба', partyName: 'Отряд',
      world: { preset: 'dark-fantasy', tone: 'мрачно' },
      players: [{ id: 'hero', character: 'Лира', role: 'следопыт' }],
    }),
    // Метки настенных часов законно отличаются между двумя созданиями: время
    // фиксации ruleset и время открывающей реплики. Проверено прогоном, что
    // больше не отличается ничего.
    strip: ({ ruleset_locked_at: _locked, messages, ...rest }) => ({
      ...rest,
      messages: (messages ?? []).map(({ timestamp: _timestamp, ...message }) => message),
    }),
  },
]

for (const role of ROLES) {
  test(`${role.name}: отказ модели даёт ровно то же, что и работа без ключа`, async () => {
    const withoutKey = await role.call(null)
    const refused = await role.call(new RefusingClient())
    assert.ok(refused, 'отказ модели не должен оставлять роль без ответа')
    assert.deepEqual(role.strip(refused), role.strip(withoutKey))
  })

  test(`${role.name}: отказ модели не выбрасывает наружу`, async () => {
    await assert.doesNotReject(() => role.call(new RefusingClient('LLM_TIMEOUT')))
  })
}

// Совпадение с работой без ключа доказывает согласованность, но не играбельность:
// обе ветки могли бы одинаково отдавать полупустую кампанию. Продуктовые
// принципы требуют другого — кампания становится `active` только после валидной
// серверной инициализации, а отказ провайдера это требование не отменяет.
test('кампания, созданная при отказе модели, играбельна', async () => {
  const created = await new CampaignBootstrapper({ llmClient: new RefusingClient() }).create({
    code: 'REFUSAL-2', name: 'Проба', partyName: 'Отряд',
    world: { preset: 'dark-fantasy', tone: 'мрачно' },
    players: [{ id: 'hero', character: 'Лира', role: 'следопыт' }, { id: 'ally', character: 'Бран', role: 'воин' }],
  })
  const campaign = normalizeCampaignState(created)

  assert.equal(campaign.players.length, 2)
  for (const hero of campaign.players) {
    assert.ok(Number.isInteger(hero.x) && Number.isInteger(hero.y), `${hero.id}: герой обязан стоять на карте`)
  }
  // Две стартовые точки не совпадают: иначе отряд начинает в одной клетке.
  assert.notDeepEqual(
    { x: campaign.players[0].x, y: campaign.players[0].y },
    { x: campaign.players[1].x, y: campaign.players[1].y },
  )
  assert.ok(campaign.scene.cells.length > 0, 'без карты сцена не играбельна')
  assert.ok(campaign.scene.cells.some((cell) => cell.type === 'floor'), 'на карте обязан быть пол')
  assert.ok(campaign.scene.location, 'у сцены обязана быть локация')
  assert.ok(campaign.scene.objective, 'без цели сцены отряду нечего делать')
  assert.ok(campaign.messages[0]?.text, 'открывающая реплика обязана быть не пустой')
  assert.equal(campaign.engine_mode, 'enforce')
  assert.equal(campaign.state_version, 0)
  assert.equal(campaign.activePlayerId, 'hero')
  assert.ok(campaign.worldMap?.currentLocationId, 'кампания обязана знать, где отряд на карте мира')
})

test('отказ модели не меняет состояние кампании', async () => {
  const before = state()
  const snapshot = JSON.stringify(before)
  for (const role of ROLES) await role.call(new RefusingClient())
  assert.equal(JSON.stringify(before), snapshot, 'роль изменила переданное состояние на месте')
})
