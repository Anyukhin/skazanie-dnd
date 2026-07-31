import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Интерфейс разделён по задаче 0: часть экранов вынесена из App.tsx.
// Сторож читает весь корпус интерфейса, иначе проверка молча перестала бы
// что-либо охранять после переезда компонента.
const appSource = ['../src/App.tsx', '../src/AppViews.tsx', '../src/app-shared.tsx']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')
const sessionSource = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('главный экран показывает серверные задачи и явные действия отдыха', () => {
  assert.match(appSource, /function PartyQuestHud/u)
  assert.match(appSource, /state\.worldMemory\?\.quests/u)
  assert.match(appSource, /className=\{`party-quest-hud/u)
  assert.match(stylesSource, /\.party-quest-hud\s*\{/u)

  assert.match(appSource, /className="rest-controls"/u)
  assert.match(appSource, /onStartRest\('short'\)/u)
  assert.match(appSource, /onStartRest\('long'\)/u)
  assert.match(appSource, /onSpendHitPointDie/u)
  assert.match(appSource, /onCompleteRest/u)
  assert.match(appSource, /activeRest\.reason === 'knockout'/u)
  assert.match(appSource, /activeRest\.kind !== 'short' \|\| activeRest\.schema_version !== 2/u)
  assert.match(appSource, /!combatActive && <section className="rest-controls"/u)
})

test('HUD отдыха использует типизированный HTTP-путь без клиентской формулы и длительности', () => {
  assert.match(sessionSource, /command: RestCommand/u)
  assert.match(sessionSource, /command_type: 'StartRest'/u)
  assert.match(sessionSource, /command_type: 'SpendHitPointDie'/u)
  assert.match(sessionSource, /command_type: 'CompleteRest'/u)
  assert.match(sessionSource, /\/api\/campaigns\/\$\{encodeURIComponent\(current\.sessionCode\)\}\/commands/u)
  assert.doesNotMatch(sessionSource, /SpendHitPointDie[^\n]+(?:formula|amount|duration|rest_id)/u)
})

test('подтверждённый бросок разбирается возле фишки и не вычисляется из карты', () => {
  assert.match(appSource, /function BattleRollTokenCallout/u)
  assert.match(appSource, /battleRollContext\(visualBatch\?\.events, visibleBattleRoll\)/u)
  assert.match(appSource, /className=\{`battle-roll-token-callout/u)
  assert.match(stylesSource, /\.battle-roll-token-callout\s*\{/u)
})

test('предпросмотр области использует общий модуль геометрии', () => {
  assert.match(appSource, /import \{ areaCells \} from '\.\/area-geometry'/u)
  assert.match(appSource, /const previewBlastKeys = useMemo\(\(\) => \{/u)
  assert.match(appSource, /if \(!previewBlastCenter \|\| !active \|\| previewBlastSizeFeet <= 0\) return new Set<string>\(\)/u)
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
  assert.match(appSource, /<CombatTurnClock clock=\{state\.turn_clock\} actorName=\{actorNameById\(state\.turn_clock\?\.actor_ids\?\.\[0\]\)\}/u)
  assert.match(appSource, /ДО АВТОПРОПУСКА'\}\{actorName \? ` · \$\{actorName\}`/u)
  assert.doesNotMatch(appSource, /fetch\([^)]*system-tick/u)
})
