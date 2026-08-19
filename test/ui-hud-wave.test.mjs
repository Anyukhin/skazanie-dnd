import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Интерфейс разделён по задаче 0: часть экранов вынесена из App.tsx.
// Сторож читает весь корпус интерфейса, иначе проверка молча перестала бы
// что-либо охранять после переезда компонента.
const appSource = ['../src/App.tsx', '../src/AppViews.tsx', '../src/DungeonMap.tsx', '../src/app-shared.tsx']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n')
const sessionSource = readFileSync(new URL('../src/useGameSession.ts', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
// Отдельно от корпуса: часть проверок смотрит на порядок разметки внутри
// одного файла, а в склейке порядок теряется.
const rootSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

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

test('сброс сцены — правка вида: только у владельца, с подтверждением и честной подписью', () => {
  assert.match(appSource, /canReset && <button/u, 'кнопка сброса рисуется только по праву')
  assert.match(appSource, /canReset=\{canManageLifecycle \|\| isAdmin\}/u)
  assert.match(appSource, /window\.confirm\(RESET_CONFIRMATION\)/u)
  assert.match(appSource, /сервер такой правки не получит/u, 'подтверждение обязано называть локальность правки')
  assert.doesNotMatch(appSource, /title="Снять бой и поднять павших героев"/u, 'старая подпись обещала команду миру')
})

test('правая колонка отдаёт ситуативные панели прокрутке, а HUD не гасится на ноутбуке', () => {
  assert.match(appSource, /<div className="server-situational">/u)
  assert.match(stylesSource, /\.server-column \{[^}]*display: flex;[^}]*flex-direction: column;/u)
  assert.match(stylesSource, /\.server-column > \.server-situational \{[^}]*overflow-y: auto;/u)
  assert.match(stylesSource, /\.server-column > \.player-hud-stack \{[^}]*margin-top: auto;/u)
  // Прежние правила гасили карточку героя целиком — в том числе на 1366×768
  // и 1440×900, за которыми и играют.
  assert.doesNotMatch(stylesSource, /\.player-hud-stack, \.player-hud \{ display: none; \}/u)
  assert.doesNotMatch(stylesSource, /\.server-column > \.player-hud-stack \{ display: none; \}/u)
  assert.match(stylesSource, /@media \(max-width: 1120px\), \(max-height: 850px\) and \(min-width: 681px\) \{/u, 'вместо сокрытия — компактная форма на тех же условиях')
  // Описание действия и управление хроникой тоже не исчезают молча.
  assert.doesNotMatch(stylesSource, /\.hotbar-detail \{ display: none; \}/u)
  assert.match(stylesSource, /\.chronicle-filters \{ display: flex;/u)
  assert.match(stylesSource, /\.chronicle-to-latest \{[^}]*display: flex;/u)
})

test('рассказчик и ожидающая проверка живут поверх любого раздела, а не только комнаты', () => {
  // Последняя пара тегов — разметка самого игрового экрана: до неё в файле
  // стоят экраны ожидания со своими `main`.
  const mainStart = rootSource.lastIndexOf('<main className="game-main">')
  const mainEnd = rootSource.lastIndexOf('</main>')
  assert.ok(mainStart > 0 && mainEnd > mainStart)
  const insideMain = rootSource.slice(mainStart, mainEnd)
  assert.doesNotMatch(insideMain, /cinematic-narration/u, 'врезка рассказчика не должна зависеть от раздела «комната»')
  assert.doesNotMatch(insideMain, /pending-check-overlay/u, 'карточка броска не должна зависеть от раздела «комната»')
  assert.match(rootSource.slice(mainEnd), /className=\{`scene-overlay-layer/u)
  assert.match(rootSource, /className="pending-check-overlay"/u)
  assert.match(stylesSource, /\.scene-overlay-layer \{[^}]*position: fixed;/u)
  assert.match(stylesSource, /\.scene-overlay-layer\.beside-server-column \{ right: var\(--server-column/u)
})

test('отказы идут одной очередью тостов, а не тремя строками в трёх углах', () => {
  assert.match(appSource, /export function ErrorToasts/u)
  assert.match(appSource, /className="toast toast-error" role="alert"/u)
  assert.match(appSource, /<ErrorToasts sources=\{\[/u)
  assert.match(appSource, /\{ text: tacticalError, onDismiss: clearTacticalError \}/u)
  assert.doesNotMatch(appSource, /className="admin-error director-error"/u)
  assert.doesNotMatch(appSource, /className="tactical-command-error"/u)
  assert.match(stylesSource, /\.toast-stack \{[^}]*position: fixed;/u)
})

test('Escape закрывает окна интерфейса и возвращает фокус вызвавшей кнопке', () => {
  assert.match(appSource, /export function useDialogEscape/u)
  assert.match(appSource, /invoker\?\.isConnected\) invoker\.focus\(\)/u)
  assert.match(appSource, /useDialogEscape\(\(\) => setSpellbookOpen\(false\), spellbookOpen\)/u)
  assert.match(appSource, /useDialogEscape\(\(\) => setNpcDossier\(null\), Boolean\(npcDossier\)\)/u)
})
