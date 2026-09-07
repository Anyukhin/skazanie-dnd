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
// Каталог классов и подписи запасов живут отдельно от корпуса интерфейса.
const actionsSource = readFileSync(new URL('../src/combat-actions.ts', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
// Доска и её отрисовка живут отдельными модулями: карту рисует не корпус
// интерфейса, и сторожа слоёв обязаны смотреть именно туда.
const boardSource = readFileSync(new URL('../src/TacticalBoard.tsx', import.meta.url), 'utf8')
const renderSource = readFileSync(new URL('../src/board-render.ts', import.meta.url), 'utf8')
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
  // Отдых — только вне боя, чипом в строке ситуаций; сама панель раскрывается поверх ленты.
  assert.match(appSource, /!combatActive && <SituationalSlot id="rest" icon=\{<Flame size=\{14\} \/>\} label="Отдых"[^\n]*>\r?\n\s*<section className="rest-controls"/u)
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
  // Звуковой сигнал хода был синтезированным и ушёл вместе с синтезом:
  // остаются заголовок вкладки и системное уведомление.
  assert.doesNotMatch(appSource, /playEffect\('level'\)/u)
})

test('боевой HUD показывает только серверный turn_clock и не решает авто-пропуск сам', () => {
  assert.match(appSource, /function CombatTurnClock/u)
  assert.match(appSource, /turnClockPresentation\(clock, now\)/u)
  assert.match(appSource, /<CombatTurnClock clock=\{state\.turn_clock\} actorName=\{actorNameById\(state\.turn_clock\?\.actor_ids\?\.\[0\]\)\} compact \/>/u, 'часы стоят в полоске хода компактно')
  // Подпись «до автопропуска · имя» в компактном виде уходит в title, но не
  // исчезает: скринридер и наведение обязаны читать, чьи это часы.
  assert.match(appSource, /'До автопропуска'\}\$\{actorName \? ` · \$\{actorName\}`/u)
  assert.match(appSource, /title=\{compact \? caption : undefined\}/u)
  assert.doesNotMatch(appSource, /fetch\([^)]*system-tick/u)
})

test('правая колонка — лента и две полоски: контекст боя не штабелем, инспектор у фишки', () => {
  // Сверху — полоска хода: раунд, ходящий, его состояния и часы в одну строку.
  assert.match(appSource, /className="turn-strip" role="status" aria-live="polite"/u)
  assert.match(appSource, /className="turn-strip-round">Раунд \{combat\.round \?\? 1\}/u)
  assert.match(appSource, /className=\{`turn-strip-condition \$\{condition\.status\}`\}/u)
  // Прежних этажей в колонке нет: ни карточки контекста, ни двух лент боя,
  // ни блока «выбранная команда» — он дублировал строку ввода.
  assert.doesNotMatch(appSource, /className="combat-context-panel"/u)
  assert.doesNotMatch(appSource, /className="board-combat-journal"/u)
  assert.doesNotMatch(appSource, /className="npc-turn-summary"/u)
  assert.doesNotMatch(appSource, /className="combat-command-confirmation"/u)
  // Ходы противников — одной свёрнутой строкой со счётчиком и подсветкой участников.
  assert.match(appSource, /className=\{`npc-turn-group\$\{npcGroupOpen \? ' open' : ''\}`\}/u)
  assert.match(appSource, /<span>Пока вы ждали<\/span><b>\{npcSummaryEvents\.length\}<\/b>/u)
  // Инспектор цели — поповер у фишки, с якорем от самой фишки, а не в колонке.
  assert.match(appSource, /export function targetPopoverStyle\(anchor: TokenAnchor/u)
  assert.match(appSource, /\{inspectedTarget && inspectedAnchor && <div className="combat-target-popover" style=\{targetPopoverStyle\(inspectedAnchor\)\}/u)
  assert.match(appSource, /setInspectedAnchor\(tokenAnchor\(event\.currentTarget\)\)/u)
  assert.match(stylesSource, /\.combat-target-popover \{[^}]*pointer-events: none;/u, 'поповер не перехватывает наведение на фишку')
  // Чипы экономики над картой ушли: то же показывает кластер панели действий.
  assert.doesNotMatch(appSource, /className="map-economy"/u)
  assert.doesNotMatch(stylesSource, /\.map-economy \{/u)
})

test('сброс сцены — правка вида: только у владельца, с подтверждением и честной подписью', () => {
  assert.match(appSource, /canReset && <button/u, 'кнопка сброса рисуется только по праву')
  assert.match(appSource, /canReset=\{canManageLifecycle \|\| isAdmin\}/u)
  assert.match(appSource, /window\.confirm\(RESET_CONFIRMATION\)/u)
  assert.match(appSource, /сервер такой правки не получит/u, 'подтверждение обязано называть локальность правки')
  assert.doesNotMatch(appSource, /title="Снять бой и поднять павших героев"/u, 'старая подпись обещала команду миру')
})

test('правая колонка: ситуации чипами поверх ленты, хроника берёт остаток, HUD — полоска у низа', () => {
  assert.match(appSource, /<div className="server-situational">/u)
  assert.match(stylesSource, /\.server-column \{[^}]*display: flex;[^}]*flex-direction: column;/u)
  // Ситуативные панели — чипы в одну строку; раскрытая встаёт поверх ленты,
  // а не в штабель: раньше девять панелей делили с хроникой 384 пикселя.
  assert.match(appSource, /export function SituationalSlot\(/u)
  assert.match(appSource, /<SituationalSlot id="guard" icon=\{<ShieldAlert size=\{14\} \/>\} label="Стража"/u)
  assert.match(appSource, /<SituationalSlot id="letters" icon=\{<Mail size=\{14\} \/>\} label="Письма" badge=\{heroLettersInTransit\.length\}/u)
  assert.match(appSource, /const urgentSituational = guardEncounter \? 'guard' : truce \? 'truce' : tavernRound \? 'tavern' : null/u, 'срочные панели раскрываются сами')
  assert.match(stylesSource, /\.server-column > \.server-situational \{[^}]*display: flex;[^}]*flex-wrap: wrap;/u)
  assert.match(stylesSource, /\.situational-overlay \{[^}]*position: absolute;[^}]*inset: 12px;/u)
  // Хроника — единственная прокрутка колонки и берёт всё, что не заняли полоски.
  assert.match(stylesSource, /\.server-column > \.chat-panel \{ flex: 1 1 auto; min-width: 0; min-height: 120px; \}/u)
  assert.doesNotMatch(stylesSource, /\.server-column > \.chat-panel \{[^}]*max-height/u)
  assert.doesNotMatch(stylesSource, /\.server-column > \.combat-context-panel/u)
  assert.doesNotMatch(appSource, /className="chat-closed"/u, 'сворачивать ленту больше не во что')
  assert.doesNotMatch(rootSource, /setChatOpen\(false\)/u, 'бой больше не прячет хронику')
  assert.match(stylesSource, /\.server-column > \.player-hud-stack \{[^}]*margin-top: auto;/u)
  // Карточка героя — одна полоска: числа с подписями в title, портрет и класс
  // не повторяются (они в списке отряда). Прежние правила гасили её целиком на
  // 1366×768 и 1440×900, за которыми и играют.
  assert.match(rootSource, /className="hud-health"/u)
  assert.match(rootSource, /className="hud-identity"/u)
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

test('ресурсы героя видны у действий, а экономика хода вне боя не расходуется', () => {
  assert.match(appSource, /className="hotbar-hero-cluster player-resource-panel"/u)
  assert.match(appSource, /Экономика хода вне боя не расходуется/u)
  assert.match(appSource, /disabled=\{!combatActive\}/u)
  assert.match(appSource, /const economy = combat\.action_economy\?\.\[turnActorId\]/u)
  assert.match(appSource, /Number\(actionReady\) \+ Math\.max\(0, Number\(economy\?\.extra_actions\)/u)
  assert.match(appSource, /const heroResourceRows = Object\.entries\(activeResources\)/u)
  assert.match(appSource, /aria-label=\{heroResourceTitle\(row\.keys, row\.current, row\.max\)\}/u)
})
test('запас героя подписан по-русски, а незнакомый ключ опрятен и не теряет сырого имени', () => {
  // Ключ серверной проекции — `feature_<id>` из каталога классов, латиницей и
  // в транслите: «feature_wizard-magicheskoe-vosstanovlenie». Словарём по ключу
  // на способность это не закрыть — их 115 на двенадцать классов, — поэтому имя
  // берётся из того же каталога, что и у сервера.
  assert.match(actionsSource, /export function featureResourceName/u)
  assert.match(actionsSource, /featureResourceNames\.set\(`feature_\$\{entry\.id\}`, catalogSentenceCase\(entry\.name\)\)/u)
  assert.match(actionsSource, /function catalogSentenceCase/u, 'имена из dndsu местами набраны капсом — в подсказке это крик')
  assert.match(appSource, /import \{ fallbackCombatActions, fallbackCombatResources, featureResourceName \} from '\.\/combat-actions'/u)
  assert.match(appSource, /return HERO_RESOURCE_LABELS\[key\] \?\? featureResourceName\(key\) \?\? heroResourceFallbackLabel\(key\)/u)
  // Фолбэк: срезать служебный префикс, разделители в пробелы, первая буква вверх.
  assert.match(appSource, /key\.replace\(\/\^\(\?:feature\|resource\)_\/u, ''\)\.replace\(\/\[_-\]\+\/gu, ' '\)\.trim\(\)/u)
  assert.match(appSource, /tidy\.charAt\(0\)\.toLocaleUpperCase\('ru'\) \+ tidy\.slice\(1\)/u)
  // Выведенное имя переводом не притворяется: сырой ключ уходит в подсказку.
  assert.match(appSource, /heroResourceKnown\(first\) \? '' : ` · ключ \$\{first\}`/u)
  assert.match(appSource, /export function heroResourceTitle\(keys: string\[\], current: number, max: number\): string/u)
  assert.match(appSource, /aria-label=\{heroResourceTitle\(row\.keys, row\.current, row\.max\)\}/u, 'скринридер слышит то же, что видно в подсказке')
  // Чип неразрывен: рвётся ряд по чипам, обрезается только подпись.
  assert.match(stylesSource, /\.hero-resource \{[^}]*max-width: 100%;[^}]*overflow: hidden;[^}]*white-space: nowrap;/u)
  assert.match(stylesSource, /\.hero-resource em \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/u)
  assert.match(stylesSource, /\.hero-cluster-resources \{[^}]*flex-wrap: wrap;/u)
  assert.match(stylesSource, /\.hero-resource i \{ flex: 0 0 auto;/u, 'пипсы не жмутся: обрезать разрешено только подпись')
  assert.match(stylesSource, /\.hero-resource b \{ flex: 0 0 auto;[^}]*white-space: nowrap;/u, 'счётчик заряда с многоточием врал бы о запасе')
})

test('запас-близнец схлопывается в один чип, а разошедшийся счёт остаётся двумя', () => {
  // Сервер кладёт один запас дважды: рукописным ключом и каталожным
  // (`second_wind` и `feature_fighter-vtoroe-dyhanie`). Панель схлопывает их —
  // но только при совпадении подписи, заряда и запаса разом.
  assert.match(appSource, /const twin = rows\.find\(\(row\) => row\.current === entry\.current && row\.max === entry\.max\s+&& heroResourceLabel\(row\.keys\[0\]\) === heroResourceLabel\(entry\.key\)\)/u)
  assert.match(appSource, /if \(twin\) twin\.keys\.push\(entry\.key\)/u)
  assert.match(appSource, /else rows\.push\(\{ keys: \[entry\.key\], current: entry\.current, max: entry\.max \}\)/u)
  // Ни один из трёх признаков не должен выпасть из условия: без `current`/`max`
  // расхождение дублей спряталось бы, а это уже серверный баг.
  assert.doesNotMatch(appSource, /rows\.find\(\(row\) => heroResourceLabel\(row\.keys\[0\]\) === heroResourceLabel\(entry\.key\)\)/u, 'схлопывание по одной подписи спрятало бы расхождение счётчиков')
  // Схлопнутый чип называет оба сырых ключа — иначе двойник исчезает бесследно.
  assert.match(appSource, /if \(keys\.length > 1\) return `\$\{head\} · ключи: \$\{keys\.join\(', '\)\}`/u)
  assert.match(appSource, /key=\{row\.keys\.join\('\+'\)\}/u, 'React-ключ строки собран из всех сырых ключей')
  // Двойник узнаётся только при совпадении подписей, поэтому вольный синоним
  // волшебника приведён к имени самой способности.
  assert.match(appSource, /arcane_recovery: 'Магическое восстановление'/u)
  assert.doesNotMatch(appSource, /arcane_recovery: 'Восстановление сил'/u)
})

test('клик по пипсу фильтрует колоду по стоимости, а Escape снимает выборку', () => {
  assert.match(appSource, /const \[costFilter, setCostFilter\] = useState<HotbarCostFilter \| null>\(null\)/u)
  assert.match(appSource, /onClick=\{\(\) => setCostFilter\(\(current\) => current === pip\.id \? null : pip\.id\)\}/u, 'повторный клик по тому же пипсу снимает фильтр')
  assert.match(appSource, /const visibleTiles = costFilter \? orderedTiles\.filter\(\(tile\) => tile\.cost === costFilter\) : orderedTiles/u)
  assert.match(appSource, /\{visibleTiles\.map\(\(\{ id, node \}\)/u, 'колода рисует отфильтрованный список')
  assert.match(appSource, /const ids = orderedTiles\.map\(\(tile\) => tile\.id\)/u, 'перестановка плиток считает полный порядок, а не видимый')
  // Активная выборка видна и рамкой пипса, и строкой со сбросом.
  assert.match(appSource, /costFilter === pip\.id \? 'filtering' : ''/u)
  assert.match(stylesSource, /\.combat-hotbar \.hero-pip\.filtering \{/u)
  assert.match(appSource, /className="hero-cluster-filter" role="status">Показаны: \{HOTBAR_COST_FILTER_LABELS\[costFilter\]\} · <button/u)
  // Escape снимает фильтр, уступая книге заклинаний, и снимает слушателя за собой.
  assert.match(appSource, /if \(!costFilter \|\| spellbookOpen\) return\s+const onKey = \(event: KeyboardEvent\) => \{ if \(event\.key === 'Escape'\) setCostFilter\(null\) \}/u)
  assert.match(appSource, /window\.addEventListener\('keydown', onKey\)\s+return \(\) => window\.removeEventListener\('keydown', onKey\)\s+\}, \[costFilter, spellbookOpen\]\)/u)
})

test('Пробел завершает ход только в свой ход и только мимо полей ввода', () => {
  assert.match(appSource, /if \(!combatActive \|\| !canAct \|\| tacticalBusy\) return/u, 'горячая клавиша живёт по тем же правилам, что и сама кнопка')
  assert.match(appSource, /if \(event\.code !== 'Space' && event\.key !== ' '\) return/u, 'слушатель не хватает других клавиш')
  assert.match(appSource, /if \(tag === 'INPUT' \|\| tag === 'TEXTAREA' \|\| tag === 'SELECT' \|\| tag === 'BUTTON'\) return/u)
  assert.match(appSource, /if \(focused instanceof HTMLElement && \(focused\.isContentEditable \|\| focused\.getAttribute\('role'\) === 'button'\)\) return/u)
  assert.match(appSource, /\}, \[combatActive, canAct, tacticalBusy\]\)/u)
  assert.match(appSource, /void finishTurnRef\.current\(\)/u)
  assert.match(appSource, /<kbd>Пробел<\/kbd>/u, 'клавиша названа на самой кнопке')
})

test('стоимость плитки читается фигурой, а «Завершить ход» — главная кнопка ряда', () => {
  // Фигура добавлена одним правилом на все плитки; слово осталось в разметке.
  assert.match(stylesSource, /\.action-cost::before \{ content: ''/u)
  assert.match(stylesSource, /\.action-cost\.bonus_action::before \{ clip-path: polygon/u)
  assert.match(stylesSource, /\.action-cost\.reaction::before \{ clip-path: polygon/u)
  assert.match(stylesSource, /\.action-cost\.movement::before \{ clip-path: polygon/u)
  assert.match(stylesSource, /\.action-cost\.free::before \{ background: transparent; box-shadow: inset/u)
  assert.match(stylesSource, /\.combat-hotbar \.action-tile \.action-cost::before \{ position: absolute/u)
  assert.match(appSource, /<i className="action-cost action">действие<\/i>/u, 'слово стоимости остаётся для скринридера')
  // Кнопка конца хода — золотая, выше соседей и с честной подсказкой.
  assert.match(stylesSource, /\.combat-hotbar \.hotbar-turn-controls \.end-turn-hotbar \{[^}]*min-height: 46px;[^}]*justify-self: end;/u)
  assert.match(appSource, /className=\{`end-turn-hotbar \$\{turnFullySpent \? 'exhausted' : ''\}`\}/u)
  assert.match(appSource, /`Остались: \$\{unspentTurnResources\.join\(', '\)\}\. Завершить ход/u)
  assert.match(appSource, /const turnFullySpent = combatActive && unspentTurnResources\.length === 0/u)
  assert.match(stylesSource, /@keyframes end-turn-ready-pulse \{/u)
  assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\) \{\s+\.combat-hotbar \.hotbar-turn-controls \.end-turn-hotbar\.exhausted \{ animation: none;/u)
})

test('чипы пикеров в колонке описания весят больше общего правила кнопок панели', () => {
  // Ландмайн панели: правило той же силы (0,1,1) объявлено ниже по файлу и
  // растягивает любую кнопку внутри `.tactical-control` на всю строку
  // красноватой плашкой. Его не трогаем — на нём держится вся панель.
  assert.match(stylesSource, /\.tactical-control button \{[^}]*width: 100%;[^}]*margin-top: 9px;/u)
  const landmine = stylesSource.indexOf('.tactical-control button {')
  const chips = stylesSource.indexOf('.combat-hotbar .spell-option-picker button {')
  assert.ok(chips > 0, 'правило чипов пикера обязано быть привязано к классу панели: без него вес равный, а место в файле проигрышное')
  assert.ok(landmine > chips, 'спор решает вес селектора (0,2,1) против (0,1,1), а не порядок объявления')
  // Свойства, которые задаёт только общее правило, возвращены явно: иначе
  // «Одной рукой», «Метнуть» и «Сила» снова разъедутся кнопками во всю колонку.
  assert.match(stylesSource, /\.combat-hotbar \.spell-option-picker button \{[^}]*width: auto;[^}]*min-height: 20px;[^}]*margin: 0;/u)
  assert.match(stylesSource, /\.combat-hotbar \.spell-option-picker button:hover, \.combat-hotbar \.spell-option-picker button\.selected \{[^}]*border-color: rgba\(231,184,105,\.72\);/u, 'подсветка и выбор подняты согласованно с базовым правилом')
  assert.doesNotMatch(stylesSource, /^\.spell-option-picker button[ .:]/mu, 'правило без класса панели снова проиграет ландмайну')
  // Разметка, ради которой всё: три пикера живут в колонке описания.
  assert.match(appSource, /className="spell-option-picker" aria-label="Вариант заклинания"/u)
  assert.match(appSource, /className="spell-option-picker weapon-attack-picker" aria-label="Режим атаки оружием"/u)
  assert.match(appSource, /className="spell-option-picker weapon-attack-picker" aria-label="Характеристика атаки оружием"/u)
})

test('Escape закрывает окна интерфейса и возвращает фокус вызвавшей кнопке', () => {
  assert.match(appSource, /export function useDialogEscape/u)
  assert.match(appSource, /invoker\?\.isConnected\) invoker\.focus\(\)/u)
  assert.match(appSource, /useDialogEscape\(\(\) => setSpellbookOpen\(false\), spellbookOpen\)/u)
  assert.match(appSource, /useDialogEscape\(\(\) => setNpcDossier\(null\), Boolean\(npcDossier\)\)/u)
})

test('герой без портрета показывает инициалы поверх своего цвета, а не пустой кружок', () => {
  // Кампания, собранная сырым bootstrap, приходит с пустым `portrait`, и всюду,
  // где стояло `url(${player.portrait})`, оставался пустой цветной кружок.
  assert.match(appSource, /export function heroInitials\(hero: HeroFace \| null \| undefined\): string/u)
  assert.match(appSource, /export function hasHeroPortrait\(hero: HeroFace \| null \| undefined\): boolean/u)
  assert.match(appSource, /export function HeroFaceInitials/u)
  // Фолбэк не «поверх» портрета, а вместо него: инлайновый `backgroundImage`
  // перебил бы любое правило листа стилей, поэтому в этой ветке его нет вовсе.
  assert.match(appSource, /if \(hasHeroPortrait\(hero\)\) \{\s+return \{ \.\.\.extra, backgroundImage: `url\(\$\{hero\?\.portrait\}\)`/u)
  assert.match(appSource, /return \{ \.\.\.extra, \['--face-color' as string\]: hero\?\.color \|\| '#6d5b45' \}/u)
  // Все четыре места из претензии владельца переведены на общий помощник.
  assert.match(appSource, /style=\{heroFaceStyle\(player, \{ '--token': player\.color \} as React\.CSSProperties\)\}/u, 'фишка героя на доске')
  assert.match(appSource, /className="avatar portrait-avatar" data-face=\{heroFaceMode\(player\)\} style=\{heroFaceStyle\(player, \{ '--avatar': player\.color \}/u, 'аватар отряда в сайдбаре')
  assert.match(appSource, /className="initiative-active-avatar portrait" data-face=\{heroFaceMode\(activeHero\)\}/u, 'лента инициативы: активный')
  assert.match(appSource, /className="initiative-avatar portrait" data-face=\{heroFaceMode\(hero\)\}/u, 'лента инициативы: очередь')
  assert.match(rootSource, /className="hud-portrait" data-face=\{heroFaceMode\(player\)\}/u)
  // Ни одного оставшегося безусловного `url()` от поля портрета: пустая строка
  // в нём и была причиной пустых кружков. Место, где адрес портрета вообще
  // превращается в фон, во всём корпусе теперь ровно одно — сам помощник.
  assert.equal((appSource.match(/backgroundImage: `url\(\$\{[A-Za-z?.]*portrait/gu) ?? []).length, 1,
    'адрес портрета собирается только в heroFaceStyle')
  assert.doesNotMatch(appSource, /backgroundImage: 'url\(' \+ player\.portrait/u)
  // Заглушка — слой поверх оправы: наследует её скругление, красится цветом
  // героя и не крадёт клики у кнопок, лежащих на том же портрете. Селектор
  // обязан идти через оправу: правила вида `.inventory-owner b` и
  // `.hero-cluster-face b` весом (0,1,1) перебивали одноклассовое правило и
  // выталкивали инициалы за край кружка своим `min-width`.
  assert.match(stylesSource, /\[data-face="initials"\] > \.hero-face-initials \{[^}]*position: absolute;[^}]*inset: 0;[^}]*min-width: 0;/u)
  assert.match(stylesSource, /\[data-face="initials"\] > \.hero-face-initials \{[^}]*border-radius: inherit;[^}]*background: color-mix\(in srgb, var\(--face-color/u)
  assert.match(stylesSource, /\[data-face="initials"\] > \.hero-face-initials \{[^}]*pointer-events: none;/u)
  assert.doesNotMatch(stylesSource, /^\.hero-face-initials \{/mu, 'без оправы в селекторе вес проигрывает правилам-потомкам соседних блоков')
  assert.match(stylesSource, /\.hero-cluster-face > b \{/u, 'имя героя — только прямой ребёнок, иначе правило ловит и заглушку')
  // Оправе `position: relative` выдаётся правилом нулевого веса: у фишки доски
  // своя `position: absolute`, и обычное правило её бы сломало.
  assert.match(stylesSource, /:where\(\[data-face="initials"\]\) \{ position: relative; \}/u)
})

test('панель героя показывает подписанные ресурсы целиком и растёт с текстом', () => {
  const layout = readFileSync(new URL('../src/table-layout.css', import.meta.url), 'utf8')
  assert.match(appSource, /<span>Движение<\/span>/u)
  assert.match(appSource, /hero-pools-label">Ячейки/u)
  assert.match(appSource, /heroResourceRows\.map\(\(row\)/u)
  assert.match(appSource, /<div className="turn-rail-player-hud">\{playerHud\}<\/div>/u)
  assert.doesNotMatch(rootSource, /className="player-hud-stack"/u)
  assert.match(layout, /\.turn-rail \.hotbar-main\s*\{[^}]*grid-template-columns:[^;]*var\(--ui-readable-scale/u)
  assert.match(layout, /\.player-resource-panel \.hero-resource em\{[^}]*white-space:normal/u)
  assert.match(appSource, /onClick=\{\(\) => setCostFilter\(\(current\) => current === pip\.id \? null : pip\.id\)\}/u)
})
test('бюджет позиций ряда запасов: лёгкие герои целиком, тяжёлый — с чипом «+N ещё»', () => {
  // Сама функция чистая; сторож читает её из исходника и исполняет в песочнице.
  const fn = appSource.match(/export function heroPoolLayout<T extends HeroPoolRow>\(rows: readonly T\[\], budget: number\): \{ visible: T\[\]; hidden: T\[\]; slotCount: number \} \{([\s\S]*?)\n\}/u)
  assert.ok(fn, 'heroPoolLayout должна быть объявлена статически')
  const heroPoolLayout = new Function('rows', 'budget', 'isSpellSlotPool', fn[1].replace(/: (?:T\[\]|number|readonly T\[\])/gu, ''))
  const isSpellSlotPool = (key) => /^spell_slots_[1-9]$/u.test(key)
  const row = (key, current, max) => ({ keys: [key], current, max })
  const tessa = [row('spell_slots_1', 2, 4), row('spell_slots_2', 2, 2), row('arcane_recovery', 1, 1)]
  const paladin = [row('spell_slots_1', 4, 4), row('spell_slots_2', 1, 2), row('channel_divinity', 1, 1), row('lay_on_hands', 25, 25)]
  const stress = [row('spell_slots_1', 3, 4), row('spell_slots_2', 3, 3), row('pact_slots', 1, 2), row('bardic_inspiration', 2, 4), row('sorcery_points', 5, 5)]
  assert.deepEqual(heroPoolLayout(tessa, 4, isSpellSlotPool).hidden, [], 'волшебница видна целиком')
  assert.equal(heroPoolLayout(tessa, 4, isSpellSlotPool).slotCount, 2)
  assert.deepEqual(heroPoolLayout(paladin, 4, isSpellSlotPool).hidden, [], 'паладин укладывается ровно в бюджет')
  const folded = heroPoolLayout(stress, 4, isSpellSlotPool)
  assert.deepEqual(folded.visible.map((entry) => entry.keys[0]), ['spell_slots_1', 'spell_slots_2', 'pact_slots'])
  assert.deepEqual(folded.hidden.map((entry) => entry.keys[0]), ['bardic_inspiration', 'sorcery_points'], 'хвост не короче двух: чип «+N ещё» занимает последнюю позицию')
  // Однополосный вид: бюджет две позиции — одна видимая и чип.
  const band = heroPoolLayout(tessa, 2, isSpellSlotPool)
  assert.deepEqual(band.visible.map((entry) => entry.keys[0]), ['spell_slots_1'])
  assert.equal(band.hidden.length, 2)
})

test('«сюда не дойти» рисуется одной клеткой под курсором, а не ковром по всей карте', () => {
  // Ковровый слой убран из холста вместе со своим видом оверлея.
  assert.doesNotMatch(renderSource, /'command-out-of-range' \| 'move-unavailable'/u, 'вид оверлея на всю карту больше не существует')
  assert.doesNotMatch(renderSource, /Крест недоступной клетки/u)
  assert.match(renderSource, /export type BoardOverlayKind = 'command-range' \| 'command-out-of-range'$/mu)
  assert.doesNotMatch(appSource, /boardOverlay\.push\(\{ x: cell\.x, y: cell\.y, kind: 'move-unavailable' \}\)/u)
  // Признак едет с клеткой, а выбирает клетку наведение внутри самой доски:
  // поднимать его в состояние экрана нельзя — пересобирался бы весь слой боя.
  assert.match(appSource, /const moveBlockedHere = moveUnavailable && !canAimHere && !cellInCommandRange/u)
  assert.match(appSource, /boardHints\.set\(cellKey, \{ title: cellTitle, ariaLabel: cellLabel, blocked: moveBlockedHere \}\)/u)
  assert.match(appSource, /blocked: moveBlockedHere,/u, 'клетка со своим узлом объясняется тем же признаком')
  assert.match(boardSource, /const blockedHoverKey = hoverCell && \(hoverHint\?\.blocked \|\| activeByKey\.get\(hoverKey\)\?\.blocked\) \? hoverKey : ''/u)
  assert.match(boardSource, /const blockedNow = blockedHoverKey !== '' && blockedHoverKey === `\$\{node\.x\},\$\{node\.y\}`/u)
  assert.match(boardSource, /\{blockedNow && <i className="cell-block-mark" aria-hidden="true" \/>\}/u)
  assert.match(boardSource, /\{hoverHint\.blocked && <i className="cell-block-mark" aria-hidden="true" \/>\}/u)
  // Достижимая область как показывалась, так и показывается.
  assert.match(appSource, /canMoveHere && !canAimHere && previewMoveKey === cellKey \? 'move-target' : ''/u)
  assert.match(stylesSource, /\.board-cell\.move-target \{ cursor: crosshair;/u)
  assert.match(stylesSource, /\.board-cell\.move-unavailable \{ cursor: not-allowed;/u)
  assert.match(stylesSource, /\.cell-block-mark \{ position: absolute;/u)
})

test('свет и тени доски выключаются настройкой, не трогая туман войны и механику', () => {
  // Тумблер стоит рядом с «Атмосферным фоном локации» и включён по умолчанию.
  assert.match(appSource, /title="Освещение и тени доски"/u)
  assert.match(appSource, /value=\{boardLighting\} onChange=\{\(\) => onBoardLightingChange\(!boardLighting\)\}/u)
  assert.match(appSource, /Туман войны и правила видимости не меняются/u, 'подпись обещает ровно то, что делает')
  assert.match(rootSource, /const BOARD_LIGHTING_KEY = 'skazanie-board-lighting-v1'/u)
  assert.match(rootSource, /return window\.localStorage\.getItem\(BOARD_LIGHTING_KEY\) !== 'false'/u, 'включён, пока не выключили')
  assert.match(rootSource, /window\.localStorage\.setItem\(BOARD_LIGHTING_KEY, String\(boardLighting\)\) \}, \[boardLighting\]\)/u)
  assert.match(rootSource, /boardLighting=\{boardLighting\}/u)
  // Проп доходит до сцены доски и гасит ровно один слой.
  assert.match(appSource, /lighting=\{boardLighting\}/u)
  assert.match(boardSource, /levelIndex = 0, lighting = true,/u)
  assert.match(boardSource, /propAtlas,\s+lighting,\s+\}/u)
  assert.match(renderSource, /if \(scene\.lighting !== false\) drawLightShading\(context, scene, tile\)/u)
  assert.match(renderSource, /^\s+drawFog\(context, scene, tile\)$/mu, 'туман войны — правило видимости, а не украшение')
  // Свет запечён в тайл, поэтому выключение обязано обесценить кэш.
  assert.match(renderSource, /const light = scene\.lighting === false \? 'n' : 'l'/u)
  assert.match(renderSource, /\$\{tiles\}:\$\{light\}:\$\{tile\.tileX\}/u)
})

test('состояния героя: точки в отряде, слова у себя, временные хиты голубым', () => {
  // Три вещи, без которых за столом не принять решения, читаются из серверной
  // проекции: состояния, концентрация (имя заклинания по эффекту) и временные хиты.
  assert.match(appSource, /export function heroStatusFor\(state: GameState, actorId: string\): HeroStatus/u)
  assert.match(appSource, /state\.mechanics\?\.temporary_hp\?\.\[actorId\]/u)
  assert.match(appSource, /spellNameById\(spellId \? String\(spellId\) : null\) \?\? 'заклинание'/u)
  // Соратники — точками с подсказкой; свой герой — чипами словами в полоске жизни.
  assert.match(rootSource, /className="player-status-dots" title=\{heroStatusSummary\(status\)\}/u)
  assert.match(rootSource, /<i className="concentration" \/>/u)
  assert.match(rootSource, /className="hud-status" role="group" aria-label="Состояния героя"/u)
  assert.match(rootSource, /className="hud-chip concentration"[^>]*><b>К<\/b>\{status\.concentration\}/u)
  assert.match(rootSource, /<em className="hud-temp">\+\{status\.temporaryHp\}<\/em>/u)
  assert.match(stylesSource, /\.hp-line i\.temp \{[^}]*background: #6f9fc6;/u, 'временные хиты — свой цвет, а не продолжение красного')
  assert.match(stylesSource, /\.player-status-dots i\.concentration \{ background: #8ba7bd; \}/u)
})

test('инструменты мастера собраны в меню, на виду остаются пауза и приглашение', () => {
  assert.match(rootSource, /className=\{`invite-button master-menu-button \$\{masterMenuOpen \? 'open' : ''\}`\} aria-haspopup="menu" aria-expanded=\{masterMenuOpen\}/u)
  assert.match(rootSource, /className="master-menu-list" role="menu" aria-label="Инструменты мастера"/u)
  // Откат и переигровка внутри меню сохраняют owner-гейт; опасное «Завершить» — красным и за вторым кликом.
  assert.match(rootSource, /role="menuitem" onClick=\{\(\) => \{ setMasterMenuOpen\(false\); void runCampaignControl\('rewind_turn'\) \}\}/u)
  assert.match(rootSource, /className="danger" onClick=\{\(\) => \{ setMasterMenuOpen\(false\); if \(window\.confirm\(/u)
  assert.match(rootSource, /useDialogEscape\(\(\) => setMasterMenuOpen\(false\), masterMenuOpen\)/u)
  assert.match(rootSource, /document\.addEventListener\('pointerdown', onPointerDown\)/u, 'клик мимо закрывает меню')
  // В шапке больше нет ряда из пяти мастерских кнопок.
  assert.doesNotMatch(rootSource, /className="invite-button"[^\n]*Переиграть сцену/u)
  assert.doesNotMatch(rootSource, /className="invite-button"[^\n]*Играть дальше арками/u)
})

test('названия разделов сохранены, подписи к данным — обычным регистром', () => {
  for (const caps of ['ИСТОРИЯ УРОНА', 'ЗАДАЧИ {quests.length}', '<header>РАУНД', 'ПРОТИВНИК', 'МОДИФИКАТОР', '<span>ВЕХИ</span>', 'ТРЕБУЕТСЯ ПРОВЕРКА', 'БЕЗ СОЗНАНИЯ']) {
    assert.equal(appSource.includes(caps), false, `подпись к данным набрана капсом: ${caps}`)
  }
  for (const kept of ['Хроника', 'ОТРЯД · ', 'ПЕРВЫЕ ШАГИ', 'КНИГА ЗАКЛИНАНИЙ']) {
    assert.equal(appSource.includes(kept), true, `название раздела потерялось: ${kept}`)
  }
  assert.doesNotMatch(stylesSource, /\.turn-resolution \{[^}]*text-transform: uppercase/u)
  assert.doesNotMatch(stylesSource, /\.initiative-status-label \{[^}]*text-transform: uppercase/u)
})
