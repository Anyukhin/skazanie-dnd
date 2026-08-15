// Что стол действительно видит от молитв и благословений.
//
// Контракт тройной. Данные: панель ничего не досчитывает — цена требы, СЛ
// молитвы и суточный слот приезжают с сервера готовыми. Разметка: у молитвы
// обязана быть кнопка у святыни, у требы — кнопка в меню служителя, а у самого
// благословения — иконка состояния на панели героя, та же, что у остальных
// условий. Кубик: молитва обязана быть объявлена двухфазной **на обеих**
// сторонах, иначе карточка приходит с сервера, клиент её не показывает, и ход
// зависает без единой ошибки в консоли.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { suggestedActionsFor } from '../server/action-hints.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { BLESSING_CONDITION, BLESSING_DONATION_CP, PRAYER_DC } from '../server/blessings.mjs'
import { applyGameEvent, eventSummary, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { PROJECTED_STATE_KEYS, campaignStateForViewer } from '../server/viewer-projection.mjs'
import { combatNarration } from '../server/combat-narration.mjs'
import { addProp, createTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'

const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const board = source('src/DungeonMap.tsx')
const app = source('src/App.tsx')
const session = source('src/useGameSession.ts')
const orchestrator = source('server/game-orchestrator.mjs')
const server = source('server/index.mjs')
const ui = source('src/tactical-ui.ts')

const CHAPEL = 'Придорожная часовня'
const PLAYER = { id: 'user-1', role: 'player', heroIds: ['hero'] }
const applyAll = (state, events) => events.reduce((next, event) => applyGameEvent(next, event), state)

function chapel() {
  const map = createTacticalMap({
    width: 5, height: 3, locationId: 'chapel', seed: 'chapel-seed',
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  addProp(map, { id: 'prop-altar', assetId: 'altar', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }], interactive: true })
  return normalizeCampaignState({
    sessionCode: 'SHRINE-UI',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero', character: 'Ада', hp: 12, maxHp: 12, proficiency: 2,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      classSkillProficiencies: [], savingThrowProficiencies: [], backgroundSkillProficiencies: [],
      currency: { copper: 0, silver: 0, gold: 2, platinum: 0 }, inventory: [], x: 0, y: 0,
    }],
    enemies: [],
    scene: { title: CHAPEL, location: CHAPEL, location_id: 'chapel', map: serializeTacticalMap(map), turn: 1 },
    social: {
      npcs: [{ id: 'father', name: 'Отец Никодим', role: 'жрец Утренней зари', location: CHAPEL, visibility: 'party', public_summary: 'Служитель часовни.' }],
    },
    mechanics: { positions: { hero: { x: 0, y: 0 } }, world_time: { elapsed_minutes: 0 } },
  })
}

test('карточка благословений уезжает игроку и объявлена ключом проекции', () => {
  assert.ok(PROJECTED_STATE_KEYS.includes('blessings'), 'без ключа строгий whitelist выбросил бы реестр до подмены карточкой')
  const room = campaignStateForViewer(chapel(), PLAYER, 'hero')
  assert.equal(room.blessings.donation_cp, BLESSING_DONATION_CP)
  assert.equal(room.blessings.prayer_dc, PRAYER_DC)
  assert.equal(room.blessings.condition, BLESSING_CONDITION)
  assert.deepEqual(room.blessings.priests.map((npc) => npc.id), ['father'])
})

test('панель подсказок зовёт к святыне, но только пока обращение доступно', () => {
  const room = campaignStateForViewer(chapel(), PLAYER, 'hero')
  const hints = suggestedActionsFor(room, 'hero')
  assert.ok(hints.some((hint) => hint.id === 'blessing:offer' && /помолиться/iu.test(hint.text)))
  // Подсказка, обещающая недоступное, хуже отсутствующей: движок откажет, а
  // панель звала.
  const spent = suggestedActionsFor({ ...room, blessings: { ...room.blessings, available: false } }, 'hero')
  assert.equal(spent.some((hint) => hint.id === 'blessing:offer'), false)
  // Благословлённому герою второго не дадут ни у алтаря, ни у жреца
  // (`BLESSING_ALREADY_ACTIVE`): панель, зовущая его молиться, ведёт в отказ.
  const held = suggestedActionsFor({ ...room, blessings: { ...room.blessings, blessed: true } }, 'hero')
  assert.equal(held.some((hint) => hint.id === 'blessing:offer'), false)
})

test('доска рисует кнопку молитвы у святыни и кнопку требы в меню служителя', () => {
  assert.match(board, /pray: 'Помолиться'/u)
  // Кнопка молитвы гаснет по всем трём причинам, по которым откажет движок: бой,
  // закрытые сутки и уже висящее благословение.
  assert.match(board, /intent === 'pray' && \(blessingHeld \|\| !blessingAvailable \|\| combatActive\)/u)
  assert.match(board, /combatActive \? 'Посреди боя благословений не раздают'/u)
  assert.match(board, /blessingPriests\.some\(\(priest\) => priest\.id === sceneNpc\.id\)/u)
  assert.match(board, /onReceiveNpcBlessing\(sceneNpc\.id\)/u)
  // Кнопка не должна обещать того, чего движок не примет: ни в бою, ни с пустым
  // кошельком, ни второй раз за сутки, ни поверх неизрасходованного
  // благословения — иначе треба списывала бы золотой в отказ.
  assert.match(board, /activeHeroPurseCp < blessingDonationCp/u)
  assert.match(board, /const blessingHeld = blessings\?\.blessed === true/u)
  assert.match(board, /\|\| blessingHeld \|\| !blessingAvailable \|\| activeHeroPurseCp < blessingDonationCp/u)
  assert.match(board, /onReceiveNpcBlessing: \(npcId: string\) => Promise<CommandOutcome>/u)
  assert.match(app, /onReceiveNpcBlessing=\{\(npcId\) => receiveNpcBlessing\(activePlayer\.id, npcId\)\}/u)
})

test('молитва объявлена двухфазной и на клиенте, и на сервере', () => {
  assert.match(session, /case 'OperateSceneObject':\s*\n\s*return command\.intent === 'pray' \? command : null/u)
  assert.match(session, /intent === 'pray' \? \{ manualRoll: !autoRollEnabled\(\) \} : undefined/u)
  assert.match(orchestrator, /shrinePrayerCheckCard\(\{ campaignId, playerId, state, command \}\)/u)
  // Сторож второй фазы проверяется поведением (`test/blessings.test.mjs`,
  // «во вторую фазу принимается только кубик…»): грепом по исходнику его снятие
  // не ловится. Здесь остаётся только стык двух фаз — что сторож вообще
  // позван из разбора хода, а не объявлен и забыт.
  assert.match(orchestrator, /this\.assertShrinePrayerRollContext\(prayerCommand, prayerCheckContext\)/u)
})

test('санитайзер сервера принимает молитву кнопкой и не принимает поджог', () => {
  assert.match(server, /\['inspect', 'open', 'take', 'use', 'pray'\]\.includes\(intent\)/u)
  assert.match(server, /sanitizePlayerBlessingCommand/u)
  assert.match(server, /Благословение идёт отдельной атомарной командой/u)
})

test('благословение показывается на панели героя обычным условием', () => {
  // Подпись и статус живут в `conditionPresentation` (`src/tactical-ui.ts`) —
  // том же механизме, который рисует остальные условия героя. Проверяется он по
  // исходнику: модуль клиентский и в тестовом рантайме не импортируется.
  assert.match(ui, /'minor-blessing': 'Малое благословение'/u)
  // «Только маркер» благословению не годится: движок действительно двигает
  // бросок атаки, и подпись обязана это подтверждать.
  assert.match(ui, /IMPLEMENTED_CONDITIONS = new Set\(\[[^\]]*'minor-blessing'/su)
  assert.equal(BLESSING_CONDITION, 'minor-blessing', 'идентификатор состояния — общий для сервера и панели')
})

test('летопись говорит о молитве и о требе своими строками', () => {
  const state = chapel()
  const prayed = resolveCommand(
    { campaign_id: 'SHRINE-UI', command_id: 'pray-1', command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-altar', intent: 'pray' },
    state,
    { diceService: new DiceService({ rng: new SequenceDiceRng([15]) }), context: { allowedActorIds: ['hero'] } },
  )
  const prayerLine = combatNarration(prayed.events, state)
  assert.match(prayerLine, /святын/iu)
  assert.match(prayerLine, /благословени/iu)

  const blessed = applyAll(state, prayed.events)
  assert.match(eventSummary(prayed.events.find((event) => event.event_type === 'ShrinePrayerResolved')), /Молитва у святыни/u)

  const asked = resolveCommand(
    { campaign_id: 'SHRINE-UI', command_id: 'ask-1', command_type: 'ReceiveNpcBlessing', actor_id: 'hero', npc_id: 'father' },
    chapel(),
    { diceService: new DiceService({ rng: new SequenceDiceRng([]) }), context: { allowedActorIds: ['hero'] } },
  )
  assert.match(combatNarration(asked.events, state), /пожертвовани/iu)
  assert.match(eventSummary(asked.events.find((event) => event.event_type === 'NpcBlessingGranted')), /благословляет/u)
  assert.ok(blessed.mechanics.conditions.hero.some((condition) => String(condition.id) === BLESSING_CONDITION))
})
