import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'

const ARES_ID = 'astohan-ares'
const WIZARD_ID = 'consequence-wizard'

const wizard = {
  id: WIZARD_ID,
  character: 'Испытатель',
  name: 'Испытатель',
  role: 'Волшебник · ур. 5',
  characterClass: 'wizard',
  species: 'Человек',
  background: 'Странник',
  level: 5,
  hp: 38,
  maxHp: 38,
  armor: 13,
  speed: 30,
  proficiency: 3,
  abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 10, cha: 10 },
  knownSpellIds: ['fireball'],
  preparedSpellIds: ['fireball'],
  inventory: [],
}

/**
 * Фиксированная сцена для тестов последствий. Низкий `kingHp` проверяет
 * подтверждённую смерть, высокий — тот же обычный CastSpell без смерти.
 * Свидетели остаются авторскими NPC на их штатных постах, если `witnesses`
 * не отключён.
 */
export async function palaceFixture({ kingHp = 20, witnesses = true } = {}) {
  const state = await new CampaignBootstrapper().create({
    code: 'NPC-OFFICE',
    worldTemplateId: 'astohan-plains',
    campaignMode: 'persistent',
    players: [wizard],
  })
  // Заклинатель стоит вне двадцатифутовой сферы вокруг короля. Клетка
  // принадлежит версионированной авторской галерее и фиксирована для теста.
  const casterPoint = { x: 7, y: 4 }
  const casterCell = state.scene.cells.find((cell) => cell.x === casterPoint.x && cell.y === casterPoint.y)
  if (!casterCell || casterCell.type !== 'floor' || casterCell.revealed !== true) {
    throw new Error('Фикстура не разместила заклинателя на безопасной клетке галереи')
  }
  state.players = state.players.map((player) => player.id === WIZARD_ID ? { ...player, ...casterPoint } : player)
  state.mechanics.positions = { ...state.mechanics.positions, [WIZARD_ID]: casterPoint }
  const kingVital = state.npc_world.vitals[ARES_ID]
  state.npc_world.vitals[ARES_ID] = {
    ...kingVital,
    hp: Math.max(1, Math.min(kingVital.max_hp, Number(kingHp) || 1)),
    alive: true,
  }

  if (!witnesses) {
    const sceneNpcIds = new Set([ARES_ID])
    state.social.npcs = state.social.npcs.map((npc) => sceneNpcIds.has(npc.id)
      ? npc
      : npc.location_id === 'astohan-stormberg'
        ? { ...npc, location: 'Пепельная застава', location_id: 'astohan-ash-watch' }
        : npc)
    state.npc_world.placements = state.npc_world.placements.filter((placement) => sceneNpcIds.has(placement.npc_id))
    state.merchants = state.merchants.map((merchant) => ({
      ...merchant, location: 'Пепельная застава', location_id: 'astohan-ash-watch',
    }))
  }

  const normalized = normalizeCampaignState(state)
  const kingPlacement = normalized.npc_world.placements.find((placement) => placement.npc_id === ARES_ID)
  if (!kingPlacement) throw new Error('Фикстура не разместила короля на авторской сцене')
  return {
    state: normalized,
    heroId: WIZARD_ID,
    kingId: ARES_ID,
    casterPoint,
    kingPoint: { x: kingPlacement.x, y: kingPlacement.y },
  }
}
