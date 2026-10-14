import '../../../fixtures-env.mjs'
// Эталоны `server/pickpocket.mjs` для Rust-переноса (`sk-items`).
//
// Карман и внимательность выводятся из SHA-256 сида кампании и id человека,
// поэтому входы — сотни сочетаний кода кампании, id, роли и имени (с регистром,
// пробелами, совместимыми формами Unicode и мусором вместо строк), ступени
// людности на любом числе людей и СЛ кражи.
//
// Запуск: node rust/crates/sk-items/fixtures/gen-pickpocket.mjs
import { recorder, rng } from './record.mjs'

const P = await import(new URL('../../../../server/pickpocket.mjs', import.meta.url).href)

const random = rng(33)
const pick = (list) => list[Math.floor(random() * list.length)]
const r = recorder('server/pickpocket.mjs')

for (const name of ['PICKPOCKET_POLICY_ID', 'PICKPOCKET_SKILL', 'PICKPOCKET_ABILITY', 'PICKPOCKET_CROWD_STEPS', 'PICKPOCKET_MIN_DC', 'PICKPOCKET_MAX_DC']) {
  r.constant(name, P[name])
}

const SESSIONS = ['THIEF-UNIT', 'OTHER', '', '  ASTOHAN  ', 'ＴＨＩＥＦ', 'x'.repeat(80), null, 7]
const IDS = ['npc-1', 'npc-2', 'npc-3', ' npc-1 ', 'ｎｐｃ-1', '', '   ', 'горазд', 'n'.repeat(150), 42, null]
const ROLES = [
  'купец', 'Купчиха', 'ТОРГОВКА', 'лавочник', 'менялa', 'ростовщик', 'жрец', 'служка', 'Монах', 'настоятельница',
  'страж', 'Солдат', 'воин', 'наёмник', 'десятник', 'сотник', 'кузнец', 'ремесленник', 'мастер', 'плотник', 'нищий',
  'бродяга', 'попрошайка', 'крестьянин', 'пахарь', 'рыбак', 'пастух', 'трактирщик', 'бард', '', null, 12, ['купец'],
]
const NAMES = ['Горазд', 'Ждан', 'Купава', 'Нищеброд', 'Стражко', '', null, 'Ｍастер']

for (let index = 0; index < 600; index += 1) {
  const state = random() < 0.1 ? pick([null, {}, 'строка']) : { sessionCode: pick(SESSIONS) }
  const npc = random() < 0.05 ? pick([null, {}, 'npc-1']) : { id: pick(IDS), role: pick(ROLES), name: pick(NAMES) }
  r.call('npcPocketFor', P.npcPocketFor, state, npc)
  r.call('npcPassiveInsightFor', P.npcPassiveInsightFor, state, npc)
  r.call('pickpocketDifficultyFor', P.pickpocketDifficultyFor, state, npc, pick([0, 1, 2, 3, 5, 6, 8, 12, -3, 2.5, '4', null, 'много']))
}
r.call('npcPocketFor', P.npcPocketFor, undefined, undefined)
r.call('npcPassiveInsightFor', P.npcPassiveInsightFor, undefined, undefined)
r.call('pickpocketDifficultyFor', P.pickpocketDifficultyFor, { sessionCode: 'THIEF-UNIT' }, { id: 'npc-1' }, undefined)
for (const count of [-5, -1, 0, 1, 2, 3, 4, 5, 6, 7, 12, 999, 2.5, '3', ' 6 ', null, undefined, 'abc', [6], true]) {
  r.call('pickpocketCrowdStep', P.pickpocketCrowdStep, count)
}
r.write('pickpocket.json')
