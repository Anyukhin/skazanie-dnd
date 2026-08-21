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

test('ресурсный кластер героя рисуется только в бою и читает серверную экономику хода', () => {
  // Кластер живёт внутри карточки действий, слева от плиток, и появляется
  // ровно там, где появляется экономика хода — в бою.
  assert.match(appSource, /\{combatActive && <div className="hotbar-hero-cluster"/u)
  assert.match(stylesSource, /\.hotbar-hero-cluster \{/u)
  // Ни одного собственного счётчика: пипсы и полоса движения выведены из той же
  // `action_economy`, что и плашка над картой.
  assert.match(appSource, /const economy = combat\.action_economy\?\.\[turnActorId\]/u)
  assert.match(appSource, /const heroPips: Array<\{ id: HotbarCostFilter/u)
  assert.match(appSource, /\{ id: 'action', label: 'Действие', ready: actionReady \|\| weaponAttackReady/u)
  assert.match(appSource, /\{ id: 'bonus_action', label: 'Бонус', ready: bonusReady/u)
  assert.match(appSource, /\{ id: 'reaction', label: 'Реакция', ready: reactionReady/u)
  assert.match(appSource, /weaponAttacksAllowed > 1 \? `атаки \$\{weaponAttacksUsed\}\/\$\{weaponAttacksAllowed\}`/u, 'Дополнительная атака показана подписью, а не вторым пипсом')
  assert.match(appSource, /const heroResourceRows = Object\.entries\(activeResources\)/u, 'ячейки и классовые запасы читаются перебором, а не списком-хардкодом')
  assert.match(appSource, /\.filter\(\(entry\) => entry\.max > 0\)/u, 'ряда без содержимого быть не должно')
  assert.match(appSource, /hero-cluster-move \$\{movementAvailable && remainingFeet > 0 \? 'ready' : 'spent'\}/u)
  // Каждый пипс объясняет себя и мышью, и скринридером.
  assert.match(appSource, /title=\{`\$\{pip\.label\}: \$\{pip\.ready \? 'доступно' : 'потрачено'\}/u)
  assert.match(appSource, /aria-label=\{`\$\{pip\.label\}: \$\{pip\.ready \? 'доступно' : 'потрачено'\}/u)
  assert.match(appSource, /title=\{heroResourceTitle\(row\.keys, row\.current, row\.max\)\}/u)
  // Фигуры пипсов различают ресурс формой, а не только цветом.
  assert.match(stylesSource, /\.hero-pip-shape \{[^}]*clip-path: circle/u)
  assert.match(stylesSource, /\.hero-pip\.bonus_action \.hero-pip-shape \{ clip-path: polygon/u)
  assert.match(stylesSource, /\.hero-pip\.reaction \.hero-pip-shape \{ clip-path: polygon/u)
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
  assert.match(appSource, /className="hero-cluster-avatar" data-face=\{heroFaceMode\(activeHero\)\}/u, 'ресурсный кластер панели')
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

test('ресурсный кластер упакован в три плотных ряда и вмещает имя запаса целиком', () => {
  // Ширина под самое длинное имя запаса, одна колонка, плотная сетка.
  assert.match(stylesSource, /\.hotbar-hero-cluster \{[^}]*max-width: 236px;/u)
  assert.match(stylesSource, /\.hotbar-hero-cluster \{[^}]*max-height: 100%;/u, 'высота — ровно под ряды плиток карточки')
  assert.match(stylesSource, /\.hotbar-hero-cluster \{[^}]*display: grid;[^}]*gap: 5px;/u)
  assert.doesNotMatch(stylesSource, /\.hotbar-hero-cluster \{[^}]*grid-template-columns:/u, 'вторая колонка и была той самой пустотой')
  // Строка 1: аватар 26–28px, имя и сразу три пипса в одном ряду. У имени есть
  // пол ширины: без него подпись «атаки 1/2» у Дополнительной атаки съедала
  // строку и от имени героя оставались две буквы под многоточием.
  assert.match(stylesSource, /\.hero-cluster-face \{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*align-items: center;/u)
  assert.match(stylesSource, /\.hero-cluster-face > b \{[^}]*flex: 1 1 auto; min-width: 64px;/u)
  assert.match(stylesSource, /\.hero-cluster-avatar \{ width: 27px; height: 27px;/u)
  assert.match(appSource, /<span className="hero-cluster-avatar"[\s\S]{0,240}?<b title=\{activeName\}>\{activeName\}<\/b>\s+<div className="hero-cluster-pips"/u)
  // Строка 2: короткая полоса движения и число футов сразу за ней.
  assert.match(stylesSource, /\.hero-cluster-move \{[^}]*grid-template-columns: minmax\(0, 64px\) auto;[^}]*justify-content: start;/u)
  // Строка 3+: чипы запасов полными словами, перенос — целыми чипами.
  assert.match(stylesSource, /\.hero-resource em \{[^}]*max-width: 176px;/u, '88px резали «магическое в…» посередине слова')
  assert.match(stylesSource, /\.hero-cluster-resources \{[^}]*flex-wrap: wrap;[^}]*gap: 4px 6px;/u)
  assert.match(stylesSource, /\.hero-resource \{[^}]*max-width: 100%;[^}]*overflow: hidden;[^}]*white-space: nowrap;/u)
  // Поведение пипсов правка не трогала: те же подсказки и тот же фильтр.
  assert.match(appSource, /className=\{`hero-pip \$\{pip\.id\} \$\{pip\.ready \? 'ready' : 'spent'\} \$\{costFilter === pip\.id \? 'filtering' : ''\}`\}/u)
  assert.match(appSource, /onClick=\{\(\) => setCostFilter\(\(current\) => current === pip\.id \? null : pip\.id\)\}/u)
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
