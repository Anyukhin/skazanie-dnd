// Эталон server/lockpicking.mjs: node gen-lockpicking.mjs
import { readFileSync } from 'node:fs'

import * as m from '../../../../server/lockpicking.mjs'
import { product, recorder } from './record.mjs'

const r = recorder('lockpicking')
for (const name of [
  'LOCKPICKING_POLICY_ID', 'LOCKPICKING_SCHEMA_VERSION', 'THIEVES_TOOLS_ID', 'THIEVES_TOOLS_NAME', 'THIEVES_TOOLS_REQUIRED_MESSAGE',
  'THIEVES_TOOLS_REQUIRED_CODE', 'LOCKPICK_NOISE_SEVERITY', 'LOCKPICK_TRACE_SHARE',
]) r.constant(name, m[name])

const backgroundIds = ['backgrounds-srd-5-2-1', 'backgrounds-dnd-5e-2014']
  .flatMap((file) => JSON.parse(readFileSync(new URL(`../../../../data/${file}.json`, import.meta.url), 'utf8')).backgrounds.map((entry) => entry.id))
const heroes = [
  undefined, null, {}, [], 'criminal', 5,
  ...[...new Set(backgroundIds)].map((backgroundId) => ({ backgroundId })),
  { backgroundId: ' criminal ' }, { backgroundId: 'CRIMINAL' }, { backgroundId: 'нет-такой' }, { backgroundId: null },
  { backgroundBenefits: { tool_proficiency: 'thieves_tools' } }, { backgroundBenefits: { tool_proficiency: ' thieves_tools ' } },
  { toolProficiencies: ['herbalism_kit', 'thieves_tools'] }, { toolProficiencies: ['herbalism_kit'] }, { toolProficiencies: 'thieves_tools' },
  { toolProficiencyIds: ['thieves_tools'] }, { characterSheet: { tool_proficiencies: ['thieves_tools'] } }, { characterSheet: { tools: [null, 'thieves_tools'] } },
  { classSkillProficiencies: ['sleight_of_hand'] }, { toolProficiencies: ['Thieves_Tools'], backgroundId: 'sage' },
  { toolProficiencies: ['ｔｈｉｅｖｅｓ_ｔｏｏｌｓ'] },
]
for (const hero of heroes) r.call('hasThievesTools', m.hasThievesTools, hero)

const states = [
  undefined, null, {},
  { players: [{ id: 'hero', backgroundId: 'criminal' }, { id: 'mage', backgroundId: 'sage' }, { backgroundId: 'criminal' }] },
  { players: [{ id: ' hero ', toolProficiencies: ['thieves_tools'] }] },
  { players: 'none' },
]
for (const [state, playerId] of product(states, [undefined, 'hero', 'mage', '', null, ' hero', 'ghost'])) {
  r.call('lockpickingForViewer', m.lockpickingForViewer, state, playerId === undefined ? {} : { playerId })
}
r.call('lockpickingForViewer', m.lockpickingForViewer, states[3])

for (const check of [undefined, null, {}, { success: true, natural: 1 }, { success: false, natural: 7 }, { success: false, natural: 1 }, { natural: '1' }, { success: 'true', natural: 1 }, { success: false }]) {
  r.call('lockpickNoiseFor', m.lockpickNoiseFor, check)
}

const traceStates = [
  undefined, {}, { sessionCode: 'LOCKPICK-1', worldMap: { currentLocationId: 'vault' } }, { sessionCode: 'X', scene: { location: 'Хранилище' } },
  { sessionCode: 'Y'.repeat(80), worldMap: { currentLocationId: null }, scene: { location: 'Таверна' } }, { worldMap: { currentLocationId: 'ｖａｕｌｔ' } },
]
const witnessSets = [undefined, [], ['npc-1'], ['npc-1', 'npc-2'], [null, '', '  '], ['npc-2', 'npc-1'], 'npc-1']
for (const [state, witnessIds, index] of product(traceStates, witnessSets, Array.from({ length: 30 }, (_, index) => index))) {
  const where = { targetId: `lock-${index}` }
  if (witnessIds !== undefined) where.witnessIds = witnessIds
  r.call('lockpickTraceNoticedFor', m.lockpickTraceNoticedFor, state, where)
}
r.call('lockpickTraceNoticedFor', m.lockpickTraceNoticedFor, traceStates[2], { witnessIds: ['npc-1'] })
r.call('lockpickTraceNoticedFor', m.lockpickTraceNoticedFor, traceStates[2], { targetId: null, witnessIds: ['npc-1'] })
r.write('lockpicking.json')
