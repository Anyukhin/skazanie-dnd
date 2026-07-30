import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { Adjudicator } from '../server/adjudicator.mjs'
import { IntentParser } from '../server/intent-parser.mjs'

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('главный экран показывает серверные задачи и явные действия отдыха', () => {
  assert.match(appSource, /function PartyQuestHud/u)
  assert.match(appSource, /state\.worldMemory\?\.quests/u)
  assert.match(appSource, /className=\{`party-quest-hud/u)
  assert.match(stylesSource, /\.party-quest-hud\s*\{/u)

  assert.match(appSource, /className="rest-controls"/u)
  assert.match(appSource, /Устроить короткий отдых/u)
  assert.match(appSource, /Устроить долгий отдых/u)
  assert.match(appSource, /!combatActive && <section className="rest-controls"/u)
})

test('фраза долгого отдыха из HUD проходит parser и adjudicator до StartRest long', async () => {
  const intent = await new IntentParser().parse({
    message: 'Устроить долгий отдых',
    playerId: 'hero',
    visibleState: { players: [{ id: 'hero', name: 'Ада' }] },
  })
  const plan = await new Adjudicator().createPlan({
    intent,
    state: { players: [{ id: 'hero', name: 'Ада' }] },
    retrievedRules: { results: [], confidence: 1 },
  })

  assert.equal(intent.intent, 'rest')
  assert.equal(plan.proposed_commands[0]?.command_type, 'StartRest')
  assert.equal(plan.proposed_commands[0]?.actor_id, 'hero')
  assert.equal(plan.proposed_commands[0]?.kind, 'long')
})

test('подтверждённый бросок разбирается возле фишки и не вычисляется из карты', () => {
  assert.match(appSource, /function BattleRollTokenCallout/u)
  assert.match(appSource, /battleRollContext\(visualBatch\?\.events, visibleBattleRoll\)/u)
  assert.match(appSource, /className=\{`battle-roll-token-callout/u)
  assert.match(stylesSource, /\.battle-roll-token-callout\s*\{/u)
})

test('предпросмотр области использует общий модуль геометрии', () => {
  assert.match(appSource, /import \{ areaCells \} from '\.\/area-geometry'/u)
  assert.match(appSource, /const previewBlastKeys = new Set\(/u)
  assert.match(appSource, /const inBlastArea = previewBlastKeys\.has\(cellKey\)/u)
  assert.doesNotMatch(appSource, /function boardCellInCone/u)
  assert.doesNotMatch(appSource, /function boardCellInDirectedCube/u)
})

test('сигнал своего хода уважает видимость вкладки и разрешение Notification API', () => {
  assert.match(appSource, /if \(!document\.hidden\) return/u)
  assert.match(appSource, /document\.title = `⚔ Твой ход/u)
  assert.match(appSource, /document\.addEventListener\('visibilitychange', restoreTitle\)/u)
  assert.match(appSource, /if \(!document\.hidden\) document\.title = normalDocumentTitle\.current/u)
  assert.match(appSource, /Notification\.permission !== 'granted'/u)
  assert.match(appSource, /Notification\.requestPermission\(\)/u)
  assert.match(appSource, /onClick=\{onRequestNotifications\}/u, 'разрешение запрашивается только явным действием в настройках')
  assert.match(appSource, /atmosphereAudioRef\.current\?\.playEffect\('level'\)/u)
})

test('боевой HUD показывает только серверный turn_clock и не решает авто-пропуск сам', () => {
  assert.match(appSource, /function CombatTurnClock/u)
  assert.match(appSource, /turnClockPresentation\(clock, now\)/u)
  assert.match(appSource, /<CombatTurnClock clock=\{state\.turn_clock\}/u)
  assert.doesNotMatch(appSource, /fetch\([^)]*system-tick/u)
})
