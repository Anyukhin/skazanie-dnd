# План иконок: 157 действий без рисунка

Приложение к [`icon-plan-2026-10.md`](icon-plan-2026-10.md), группа A. Строка — один файл
`public/assets/ui/action-icons/<id>.png`. Промпт: «предмет промпта» + блок `[СТИЛЬ]` из
[`icon-prompts.md`](icon-prompts.md), раздел «Стиль». Состав сверяется с кодом:
`node tools/action-icon-gaps.mjs --check` падает, если в интерфейсе появилось действие без
рисунка и без строки здесь.

Семейства, которые обязаны различаться силуэтом, а не цветом: семь «Божественных каналов»
паладина (у каждой клятвы свой образ), девятнадцать приёмов Мастера боевых искусств, три части
астрального тела монаха, две «Псионические силы» (воин — кулак в пузыре, плут — глаз между
кинжалами).

| № | Файл | Название | Тип | Класс · подкласс | Предмет промпта |
|---|---|---|---|---|---|
| 1 | `barbarian-put-berserka-beshenstvo.png` | БЕШЕНСТВО | ▲ бонус | Варвар · Путь берсерка | A scarred clenched fist gripping a short notched axe whose blade is wreathed in angry crimson heat-haze; reads as UNCONTROLLED FRENZY. |
| 2 | `barbarian-put-burevestnika-aura-buri.png` | АУРА БУРИ | ▲ бонус | Варвар · Путь буревестника | A swirling ring of grey storm wind with one jagged white-gold lightning fork rising from its centre. |
| 3 | `barbarian-put-bushuyuschego-v-boyu-bronya-bushuyuschego-v-boyu.png` | БРОНЯ БУШУЮЩЕГО В БОЮ | ▲ бонус | Варвар · Путь бушующего в бою | A dark iron breastplate bristling with long sharp spikes, one spike tip glinting red. |
| 4 | `barbarian-put-bushuyuschego-v-boyu-nalet-bushuyuschego-v-boyu.png` | НАЛЁТ БУШУЮЩЕГО В БОЮ | ▲ бонус | Варвар · Путь бушующего в бою | A spiked iron boot in a forward charging stride with three short dust streaks behind it. |
| 5 | `barbarian-put-velikana-probuzhdenie-moschi.png` | Пробуждение мощи | ▲ бонус | Варвар · Путь великана | A huge grey stone giant hand hurling a small dark humanoid silhouette upward. |
| 6 | `barbarian-put-velikana-stihiynyy-tesak.png` | Стихийный тесак | ▲ бонус | Варвар · Путь великана | A heavy cleaver-shaped axe blade whose edge is half flame and half frost, split down the middle. |
| 7 | `barbarian-put-dikoy-magii-dikaya-magiya.png` | Дикая магия | ▲ бонус | Варвар · Путь дикой магии | A carved bone tribal totem crackling with erratic violet and green wild-magic sparks. |
| 8 | `barbarian-put-dikoy-magii-nestabilnaya-otdacha.png` | Нестабильная отдача | реакция | Варвар · Путь дикой магии | A cracked rune stone bursting apart into jagged violet shards flying outward. |
| 9 | `barbarian-put-zverya-forma-zverya.png` | Форма зверя | реакция | Варвар · Путь зверя | A muscular forearm turning into a bestial limb with coarse fur and three long curved claws. |
| 10 | `barbarian-put-zverya-zaraznaya-yarost.png` | Заразная ярость | реакция | Варвар · Путь зверя | A single long beast fang dripping glowing red rage like venom. |
| 11 | `barbarian-put-predka-hranitelya-schit-predkov.png` | ЩИТ ПРЕДКОВ | реакция | Варвар · Путь предка-хранителя | A translucent pale-blue ghostly round shield held by a spectral ancestral hand. |
| 12 | `barbarian-put-totemnogo-voina-totemnyy-duh.png` | ТОТЕМНЫЙ ДУХ | ▲ бонус | Варвар · Путь тотемного воина | A carved wooden totem pole topped with a snarling bear head, feathers tied below. |
| 13 | `barbarian-put-fanatika-fanatichnoe-prisutstvie.png` | ФАНАТИЧНОЕ ПРИСУТСТВИЕ | ▲ бонус | Варвар · Путь фанатика | A curved war horn blasting three broad golden radiant sound waves. |
| 14 | `bard-kollegiya-doblesti-boevoe-vdohnovenie.png` | БОЕВОЕ ВДОХНОВЕНИЕ | реакция | Бард · Коллегия доблести | A lute neck crossed with a short sword, a small golden spark where they cross. |
| 15 | `bard-kollegiya-duhov-istorii-duhov.png` | Истории духов | реакция | Бард · Коллегия духов | A skull-shaped candle lantern with a pale ghostly wisp curling out of its eye sockets. |
| 16 | `bard-kollegiya-duhov-istorii-s-togo-sveta.png` | Истории с того света | ▲ бонус | Бард · Коллегия духов | An old open book with a pale ghostly hand rising out of its pages. |
| 17 | `bard-kollegiya-znaniy-ostroe-slovtso.png` | ОСТРОЕ СЛОВЦО | реакция | Бард · Коллегия знаний | A sharp silver quill nib slicing like a blade, three ink droplets flying from its edge. |
| 18 | `bard-kollegiya-krasnorechiya-trevozhaschie-slova.png` | Тревожащие слова | ▲ бонус | Бард · Коллегия красноречия | A pale theatre mask with a jagged crack across it and one dark ink tear. |
| 19 | `bard-kollegiya-mechey-roscherk-klinka.png` | росчерк КЛИНКа | реакция | Бард · Коллегия мечей | A thin rapier tracing one bright golden flourish arc around itself. |
| 20 | `bard-kollegiya-ocharovaniya-mantiya-vdohnoveniya.png` | МАНТИЯ ВДОХНОВЕНИЯ | реакция | Бард · Коллегия очарования | A billowing fey cloak scattered with pink-gold sparkles, shown from behind. |
| 21 | `bard-kollegiya-ocharovaniya-mantiya-velichiya.png` | МАНТИЯ ВЕЛИЧИЯ | ▲ бонус | Бард · Коллегия очарования | A small golden crown floating above a glowing violet cloak collar. |
| 22 | `bard-kollegiya-sozidaniya-ozhivlyayuschee-vystuplenie.png` | Оживляющее выступление | реакция | Бард · Коллегия созидания | A small wooden puppet figure lifted and animated by glowing golden strings. |
| 23 | `bard-kollegiya-shepotov-mantiya-shepotov.png` | МАНТИЯ ШЁПОТОВ | реакция | Бард · Коллегия шёпотов | An empty dark hood exhaling a pale ghostly face-shaped wisp of mist. |
| 24 | `cleric-domen-buri-gnev-buri.png` | ГНЕВ БУРИ | реакция | Жрец · Домен бури | A dark storm cloud releasing one thick downward lightning bolt. |
| 25 | `cleric-domen-voyny-boevoy-svyaschennik.png` | БОЕВОЙ СВЯЩЕННИК | ▲ бонус | Жрец · Домен войны | A heavy flanged mace with a holy sun emblem cast into its head. |
| 26 | `cleric-domen-voyny-bozhestvennyy-kanal-blagoslovenie-boga-voyny.png` | БОЖЕСТВЕННЫЙ КАНАЛ: БЛАГОСЛОВЕНИЕ БОГА ВОЙНЫ | реакция | Жрец · Домен войны | A radiant golden gauntlet gripping a sword from behind and guiding its point forward. |
| 27 | `cleric-domen-magii-bozhestvennyy-kanal-ograzhdenie-magiey.png` | БОЖЕСТВЕННЫЙ КАНАЛ: ОГРАЖДЕНИЕ МАГИЕЙ | реакция | Жрец · Домен магии | A circular silver ward glyph pushing back a dark shadowy wisp. |
| 28 | `cleric-domen-mira-zaschitnaya-svyaz.png` | Защитная связь | реакция | Жрец · Домен мира | Two clasped hands bound together by a softly glowing golden cord. |
| 29 | `cleric-domen-obmana-bozhestvennyy-kanal-dvulichnost.png` | БОЖЕСТВЕННЫЙ КАНАЛ: ДВУЛИЧНОСТЬ | ▲ бонус | Жрец · Домен обмана | Two identical hooded silhouettes side by side, one solid, one translucent violet. |
| 30 | `cleric-domen-poryadka-golos-avtoriteta.png` | Голос авторитета | реакция | Жрец · Домен порядка | A judge's wooden gavel striking a block, a ring of golden light at the impact. |
| 31 | `cleric-domen-poryadka-voploschenie-zakona.png` | Воплощение закона | ▲ бонус | Жрец · Домен порядка | An ornate bronze scales of justice, perfectly balanced. |
| 32 | `cleric-domen-prirody-sderzhivanie-stihiy.png` | СДЕРЖИВАНИЕ СТИХИЙ | реакция | Жрец · Домен природы | A large green leaf curved like a shield, catching a small flame and a frost shard. |
| 33 | `cleric-domen-sveta-zaschischayuschaya-vspyshka.png` | ЗАЩИЩАЮЩАЯ ВСПЫШКА | реакция | Жрец · Домен света | An open palm releasing a bright white-gold flash burst. |
| 34 | `cleric-domen-sumerek-shagi-nochi.png` | Шаги ночи | ▲ бонус | Жрец · Домен сумерек | Dark feathered wings unfolding above a thin silver crescent moon. |
| 35 | `cleric-domen-upokoeniya-krug-smerti.png` | КРУГ СМЕРТИ | ▲ бонус | Жрец · Домен упокоения | A ring of pale bone with a single small skull set at its top. |
| 36 | `cleric-domen-upokoeniya-strazh-na-poroge-smerti.png` | СТРАЖ НА ПОРОГЕ СМЕРТИ | реакция | Жрец · Домен упокоения | A pale-gold iron lantern held up before an arched stone crypt door. |
| 37 | `druid-krug-dikogo-ognya-prizhigayuschee-plamya.png` | Прижигающее пламя | реакция | Друид · Круг дикого огня | A small flame cupped in a curled green leaf, closing a stitched wound beneath it. |
| 38 | `druid-krug-dikogo-ognya-prizyv-duha-dikogo-ognya.png` | Призыв духа дикого огня | реакция | Друид · Круг дикого огня | A small fox-like spirit made of glowing embers and flame. |
| 39 | `druid-krug-zvezd-kosmicheskoe-znamenie.png` | Космическое знамение | реакция | Друид · Круг звёзд | A bronze star-chart disc with one bright star and a thin crescent engraved on it. |
| 40 | `druid-krug-zvezd-zvezdnyy-oblik.png` | Звёздный облик | ▲ бонус | Друид · Круг звёзд | A luminous star constellation forming the shape of a drawn bow. |
| 41 | `druid-krug-luny-boevoy-dikiy-oblik.png` | БОЕВОЙ ДИКИЙ ОБЛИК | ▲ бонус | Друид · Круг луны | A snarling bear head beneath a pale full moon. |
| 42 | `druid-krug-pastyrya-totem-duhov.png` | ТОТЕМ ДУХОВ | реакция | Друид · Круг пастыря | A carved spirit pole with a glowing translucent hawk perched on top. |
| 43 | `druid-krug-snov-skrytye-puti.png` | СКРЫТЫЕ ПУТИ | ▲ бонус | Друид · Круг снов | A small glowing archway of flowers and vines framing a soft fey portal. |
| 44 | `druid-krug-snov-uteshenie-letnego-dvora.png` | УТЕШЕНИЕ ЛЕТНЕГО ДВОРА | ▲ бонус | Друид · Круг снов | A cupped hand releasing drifting golden summer pollen under a tiny sun. |
| 45 | `druid-krug-spor-gribkovaya-infektsiya.png` | Грибковая инфекция | реакция | Друид · Круг спор | Pale mushrooms sprouting from a cracked grey skull. |
| 46 | `druid-krug-spor-oreol-spor.png` | Ореол спор | реакция | Друид · Круг спор | A ring of drifting green-grey spores encircling one mushroom. |
| 47 | `druid-krug-spor-rasprostranenie-spor.png` | Распространение спор | ▲ бонус | Друид · Круг спор | A large mushroom cap bursting into a thick cloud of spores. |
| 48 | `fighter-kavalerist-derzhat-stroy.png` | ДЕРЖАТЬ СТРОЙ | реакция | Воин · Кавалерист | A lance planted in the ground at an angle, braced, with a short pennant. |
| 49 | `fighter-kavalerist-nepokolebimaya-metka.png` | НЕПОКОЛЕБИМАЯ МЕТКА | ▲ бонус | Воин · Кавалерист | A kite shield with a bold red target sigil painted on its face. |
| 50 | `fighter-kavalerist-zaschitnyy-manevr.png` | ЗАЩИТНЫЙ МАНЕВР | реакция | Воин · Кавалерист | A raised kite shield deflecting a sword strike, one bright spark at contact. |
| 51 | `bait-and-switch.png` | Обман и смена | свободно | Воин · Мастер боевых искусств | Two curved arrows swapping places around a single upright dagger. |
| 52 | `brace.png` | Удержание позиции | реакция | Воин · Мастер боевых искусств | A spear braced into the ground, tip angled forward toward the viewer. |
| 53 | `disarming-attack.png` | Обезоруживающая атака | ● действие | Воин · Мастер боевых искусств | A sword spinning out of an open steel gauntlet. |
| 54 | `distracting-strike.png` | Отвлекающий удар | ● действие | Воин · Мастер боевых искусств | A short blade striking with a small golden starburst flash beside it. |
| 55 | `evasive-footwork.png` | Уклонение ногами | свободно | Воин · Мастер боевых искусств | A leather boot sidestepping with two curved motion arcs. |
| 56 | `feinting-attack.png` | Финт | ▲ бонус | Воин · Мастер боевых искусств | A rapier pointing one way while a faint ghostly copy of it points the other. |
| 57 | `goading-attack.png` | Провоцирующая атака | ● действие | Воин · Мастер боевых искусств | A sword point jabbing toward a small angry red spark. |
| 58 | `grappling-strike.png` | Захватывающий удар | ▲ бонус | Воин · Мастер боевых искусств | An armoured hand clutching a length of chain after a strike. |
| 59 | `lunging-attack.png` | Выпад | ● действие | Воин · Мастер боевых искусств | A longsword thrusting forward in a long straight lunge with a motion streak. |
| 60 | `maneuvering-attack.png` | Маневрирующая атака | ● действие | Воин · Мастер боевых искусств | A sword with a curved golden arrow sweeping around it, guiding movement. |
| 61 | `menacing-attack.png` | Устрашающая атака | ● действие | Воин · Мастер боевых искусств | A blade reflecting one fearsome glowing red eye. |
| 62 | `parry.png` | Парирование | реакция | Воин · Мастер боевых искусств | Two swords meeting edge to edge in an X, one bright spark at the contact. |
| 63 | `precision-attack.png` | Точная атака | свободно | Воин · Мастер боевых искусств | A sword tip resting exactly on the centre of a small bullseye. |
| 64 | `pushing-attack.png` | Толкающая атака | ● действие | Воин · Мастер боевых искусств | A round shield bashing forward with one heavy push arrow behind it. |
| 65 | `quick-toss.png` | Быстрый бросок | ▲ бонус | Воин · Мастер боевых искусств | A throwing dagger flying from an open hand with a short motion streak. |
| 66 | `rally.png` | Воодушевление | ▲ бонус | Воин · Мастер боевых искусств | A war banner raised high on a pole, rippling. |
| 67 | `riposte.png` | Ответный удар | реакция | Воин · Мастер боевых искусств | A sword curving back in a counter-thrust arc after a parry. |
| 68 | `sweeping-attack.png` | Размашистая атака | ● действие | Воин · Мастер боевых искусств | A greatsword with one wide horizontal arc trail. |
| 69 | `trip-attack.png` | Подсекающая атака | ● действие | Воин · Мастер боевых искусств | A sword hooking behind an ankle, a boot tipping off balance. |
| 70 | `fighter-misticheskiy-luchnik-stranstvuyuschaya-strela.png` | СТРАНСТВУЮЩАЯ СТРЕЛА | ▲ бонус | Воин · Мистический лучник | An arrow with a glowing arcane rune on its shaft flying along a curved path. |
| 71 | `fighter-misticheskiy-rytsar-boevaya-magiya.png` | БОЕВАЯ МАГИЯ | ▲ бонус | Воин · Мистический рыцарь | A longsword crossed with a glowing violet arcane rune circle. |
| 72 | `fighter-misticheskiy-rytsar-svyaz-s-oruzhiem.png` | СВЯЗЬ С ОРУЖИЕМ | ▲ бонус | Воин · Мистический рыцарь | A sword hilt tied to an open palm by a thin glowing violet thread. |
| 73 | `fighter-psi-voin-adept-telekinetik.png` | Адепт-телекинетик | ▲ бонус | Воин · Пси-воин | A translucent violet psychic hand pushing a heavy stone block. |
| 74 | `fighter-psi-voin-psionicheskaya-sila.png` | Псионическая сила | реакция | Воин · Пси-воин | A gauntleted fist inside a violet psionic shimmer bubble. |
| 75 | `fighter-runnyy-rytsar-mosch-velikana.png` | Мощь великана | ▲ бонус | Воин · Рунный рыцарь | A huge rune-etched stone gauntlet, glowing runes on the knuckles. |
| 76 | `fighter-runnyy-rytsar-runicheskiy-schit.png` | Рунический щит | реакция | Воин · Рунный рыцарь | A round shield carved with one large glowing giant rune. |
| 77 | `fighter-rytsar-purpurnogo-drakona-vdohnovlyayuschiy-vsplesk.png` | ВДОХНОВЛЯЮЩИЙ ВСПЛЕСК | реакция | Воин · Рыцарь Пурпурного дракона | A purple dragon banner on a short pole with a golden burst behind it. |
| 78 | `fighter-rytsar-eha-eho-muchenik.png` | ЭХО-МУЧЕНИК | реакция | Воин · Рыцарь Эха | A grey translucent duplicate warrior silhouette stepping in front of a solid one. |
| 79 | `fighter-rytsar-eha-manifest-eha.png` | МАНИФЕСТ ЭХа | реакция | Воин · Рыцарь Эха | A shimmering grey echo of plate armour with no wearer, beside a sword. |
| 80 | `fighter-samuray-boevoy-duh.png` | БОЕВОЙ ДУХ | ▲ бонус | Воин · Самурай | A katana with a bright golden spirit flame running along its blade. |
| 81 | `monk-put-astralnogo-tela-lik-astralnogo-tela.png` | Лик астрального тела | ▲ бонус | Монах · Путь астрального тела | A serene translucent pale-blue astral face mask, eyes glowing. |
| 82 | `monk-put-astralnogo-tela-ruki-astralnogo-tela.png` | Руки астрального тела | ▲ бонус | Монах · Путь астрального тела | Two translucent pale-blue spectral arms ending in clenched fists. |
| 83 | `monk-put-astralnogo-tela-tors-astralnogo-tela.png` | Торс астрального тела | реакция | Монах · Путь астрального тела | A translucent pale-blue spectral torso armour with glowing seams. |
| 84 | `monk-put-voshodyaschego-drakona-aspekt-virma.png` | АСпект вирма | ▲ бонус | Монах · Путь восходящего дракона | A coiled dragon emblem with a faint ring-shaped aura around it. |
| 85 | `monk-put-voshodyaschego-drakona-uchenik-drakona.png` | Ученик дракона | реакция | Монах · Путь восходящего дракона | A single large dragon scale held in a wrapped monk hand. |
| 86 | `monk-put-kenseya-put-kenseya.png` | ПУТЬ КэНСЕЯ | ▲ бонус | Монах · Путь кэнсэя | A bamboo-handled longbow with an elegant arrow and one ink brush stroke behind it. |
| 87 | `monk-put-kenseya-zaostrennyy-klinok.png` | ЗАОСТРЕННЫЙ КЛИНОК | ▲ бонус | Монах · Путь кэнсэя | A katana blade with one bright honing gleam running along its edge. |
| 88 | `monk-put-otkrytoy-ladoni-tehniki-otkrytoy-ladoni.png` | ТЕХНИКИ ОТКРЫТОЙ ЛАДОНИ | реакция | Монах · Путь открытой ладони | An open palm releasing one circular ki shockwave ring. |
| 89 | `monk-put-pyanogo-mastera-pyanaya-pohodka.png` | ПЬЯНАЯ ПОХОДКА | реакция | Монах · Путь пьяного мастера | A swaying gourd flask with spiral motion lines around it. |
| 90 | `monk-put-solnechnoy-dushi-luch-siyayuschego-solntsa.png` | ЛУЧ СИЯЮЩЕГО СОЛНЦА | ▲ бонус | Монах · Путь солнечной души | A fist releasing a straight golden radiant sun bolt. |
| 91 | `monk-put-solnechnoy-dushi-udar-pylayuschey-dugi.png` | УДАР ПЫЛАЮЩЕЙ ДУГИ | ▲ бонус | Монах · Путь солнечной души | A burning crescent arc of fire trailing from a fist. |
| 92 | `monk-put-teni-shag-teni.png` | ШАГ ТЕНИ | ▲ бонус | Монах · Путь тени | A footprint dissolving into dark shadow smoke. |
| 93 | `paladin-klyatva-drevnih-bozhestvennyy-kanal.png` | БОЖЕСТВЕННЫЙ КАНАЛ | реакция | Паладин · Клятва древних | Living green vines with leaves coiling tightly around a sword blade. |
| 94 | `paladin-klyatva-iskupleniya-aura-zaschitnika.png` | АУРА Защитника | реакция | Паладин · Клятва искупления | A shield casting a soft golden halo over a smaller figure behind it. |
| 95 | `paladin-klyatva-iskupleniya-bozhestvennyy-kanal.png` | БОЖЕСТВЕННЫЙ КАНАЛ | реакция | Паладин · Клятва искупления | A white olive branch laid across a sheathed sword. |
| 96 | `paladin-klyatva-korony-bozhestvennaya-predannost.png` | БОЖЕСТВЕННАЯ ПРЕДАННОСТЬ | реакция | Паладин · Клятва короны | A shield with a small crown on it taking a blow meant for another. |
| 97 | `paladin-klyatva-korony-bozhestvennyy-kanal.png` | БОЖЕСТВЕННЫЙ КАНАЛ | ▲ бонус | Паладин · Клятва короны | A golden crown emitting radiant rays. |
| 98 | `paladin-klyatva-mesti-bozhestvennyy-kanal.png` | БОЖЕСТВЕННЫЙ КАНАЛ | ▲ бонус | Паладин · Клятва мести | A blood-red wax seal stamped with a sword, a crack across it. |
| 99 | `paladin-klyatva-mesti-neumolimyy-mstitel.png` | НЕУМОЛИМЫЙ МСТИТЕЛЬ | реакция | Паладин · Клятва мести | An armoured boot striding forward leaving a red vengeance trail. |
| 100 | `paladin-klyatva-predannosti-bozhestvennyy-kanal.png` | БОЖЕСТВЕННЫЙ КАНАЛ | реакция | Паладин · Клятва преданности | A sword glowing with pure white holy light along the whole blade. |
| 101 | `paladin-klyatva-slavy-bozhestvennyy-kanal.png` | Божественный канал | ▲ бонус | Паладин · Клятва славы | A laurel wreath encircling a radiant golden sun. |
| 102 | `ranger-naezdnik-na-dreyke-dreyk-kompanon.png` | Дрейк-компаньон | реакция | Следопыт · Наездник на дрейке | A small drake head exhaling a short tongue of fire. |
| 103 | `ranger-ohotnik-dobycha-ohotnika.png` | ДОБЫЧА ОХОТНИКА | реакция | Следопыт · Охотник | A barbed hunting arrow laid across a stag skull. |
| 104 | `ranger-povelitel-zverey-isklyuchitelnaya-dressirovka.png` | ИСКЛЮЧИТЕЛЬНАЯ ДРЕССИРОВКА | ▲ бонус | Следопыт · Повелитель зверей | A leather leash coiled around a bone whistle beside a paw print. |
| 105 | `ranger-povelitel-zverey-pervichnyy-sputnik.png` | Первичный спутник | реакция | Следопыт · Повелитель зверей | A spectral green wolf head made of primal light. |
| 106 | `ranger-povelitel-zverey-sputnik-sledopyta.png` | СПУТНИК СЛЕДОПЫТА | реакция | Следопыт · Повелитель зверей | A hawk landing on a leather-gloved forearm. |
| 107 | `ranger-povelitel-zverey-zverinaya-yarost.png` | ЗВЕРИНАЯ ЯРОСТЬ | ● действие | Следопыт · Повелитель зверей | Two beast claw slashes crossing in an X. |
| 108 | `ranger-strannik-gorizonta-efirnyy-shag.png` | ЭФИРНЫЙ ШАГ | ▲ бонус | Следопыт · Странник горизонта | A translucent footprint fading into a silver mist portal. |
| 109 | `ranger-strannik-gorizonta-planarnyy-voin.png` | ПЛАНАРНЫЙ ВОИН | ▲ бонус | Следопыт · Странник горизонта | An arrowhead glowing with silver force energy. |
| 110 | `ranger-strannik-fey-zamanivayuschiy-tryuk.png` | Заманивающий трюк | реакция | Следопыт · Странник фей | A swirling fey ribbon twisting around a small smiling mask. |
| 111 | `ranger-ubiytsa-chudovisch-dobycha-ubiytsy.png` | ДОБЫЧА УБИЙЦЫ | ▲ бонус | Следопыт · Убийца чудовищ | A crossbow bolt aimed at a monster's slit-pupil eye. |
| 112 | `ranger-ubiytsa-chudovisch-vrag-zaklinatelya.png` | ВРАГ ЗАКЛИНАТЕЛЯ | реакция | Следопыт · Убийца чудовищ | A wooden wand snapped in two by an arrow. |
| 113 | `ranger-hranitel-roya-izvivayuschayasya-volna.png` | Извивающаяся волна | ▲ бонус | Следопыт · Хранитель роя | A swirling swarm of tiny insects forming one curling wave. |
| 114 | `rogue-vor-bystrye-ruki.png` | БЫСТРЫЕ РУКИ | ▲ бонус | Плут · Вор | Nimble gloved fingers snatching a small coin pouch. |
| 115 | `rogue-klinok-dushi-klinki-dushi.png` | Клинки души | ▲ бонус | Плут · Клинок души | Twin translucent violet psychic daggers crossed. |
| 116 | `rogue-klinok-dushi-psihicheskie-klinki.png` | Психические клинки | ▲ бонус | Плут · Клинок души | A single translucent violet dagger made of light, flying point first. |
| 117 | `rogue-klinok-dushi-psionicheskaya-sila.png` | Псионическая сила | ▲ бонус | Плут · Клинок души | A glowing violet psionic eye floating between two small daggers. |
| 118 | `rogue-kombinator-master-taktiki.png` | МАСТЕР ТАКТИКИ | ▲ бонус | Плут · Комбинатор | A carved chess knight standing on a small tactical map. |
| 119 | `rogue-misticheskiy-lovkach-uluchshennaya-volshebnaya-ruka.png` | УЛУЧШЕННАЯ ВОЛШЕБНАЯ РУКА | ▲ бонус | Плут · Мистический ловкач | A translucent glowing spectral hand lifting an iron key. |
| 120 | `rogue-skaut-zachinschik.png` | ЗАЧИНЩИК | реакция | Плут · Скаут | A light leather boot springing backward away from a sword point. |
| 121 | `rogue-syschik-pronitsatelnyy-boy.png` | ПРОНИЦАТЕЛЬНЫЙ БОЙ | ▲ бонус | Плут · Сыщик | A brass magnifying lens held over a dagger blade. |
| 122 | `rogue-syschik-vnimatelnyy-vzglyad.png` | ВНИМАТЕЛЬНЫЙ ВЗГЛЯД | ▲ бонус | Плут · Сыщик | One watchful eye seen through a brass magnifying lens. |
| 123 | `rogue-fantom-chastitsa-dushi-usopshego.png` | Частица души усопшего | реакция | Плут · Фантом | A small glass vial holding a swirling pale soul. |
| 124 | `sorcerer-aberrantnyy-razum-telepaticheskaya-rech.png` | Телепатическая речь | ▲ бонус | Чародей · Аберрантный разум | A pale brain-like coral with thin tendrils reaching outward. |
| 125 | `sorcerer-dikaya-magiya-podchinenie-udachi.png` | ПОДЧИНЕНИЕ УДАЧИ | реакция | Чародей · Дикая магия | A twisted golden die with chaotic violet sparks around it (no visible numbers). |
| 126 | `sorcerer-zavodnaya-dusha-vosstanovlenie-balansa.png` | Восстановление баланса | реакция | Чародей · Заводная душа | A brass clockwork balance scale built from gears. |
| 127 | `sorcerer-lunnoe-charodeystvo-ubyvanie-i-rost.png` | Убывание И Рост | ▲ бонус | Чародей · Лунное чародейство | Three moon phases in a row: crescent, half, full. |
| 128 | `sorcerer-tenevaya-magiya-gonchaya-durnogo-znameniya.png` | ГОНЧАЯ ДУРНОГО ЗНАМЕНИЯ | ▲ бонус | Чародей · Теневая магия | A black shadow hound head with two glowing pale eyes. |
| 129 | `sorcerer-shtormovoe-koldovstvo-burnaya-magiya.png` | БУРНАЯ МАГИЯ | ▲ бонус | Чародей · Штормовое колдовство | A small whirlwind lifting the hem of a cloak. |
| 130 | `sorcerer-shtormovoe-koldovstvo-upravlenie-shtormom.png` | УПРАВЛЕНИЕ ШТОРМОМ | ▲ бонус | Чародей · Штормовое колдовство | A raised hand commanding a small lightning-charged storm cloud. |
| 131 | `breath-weapon.png` | Оружие дыхания | ● действие | Драконорождённый | A dragon head in profile exhaling a wide cone of elemental breath. |
| 132 | `warlock-arhifeya-charuyuschaya-zaschita.png` | ЧАРУЮЩАЯ ЗАЩИТА | реакция | Колдун · Архифея | A rose with long thorns curled into the shape of a shield. |
| 133 | `warlock-arhifeya-feyskoe-prisutstvie.png` | Фейское присутствие | ● действие | Колдун · Архифея | A glowing fey crown of flowers with sharp radiant sparkles. |
| 134 | `warlock-arhifeya-tumannoe-ischeznovenie.png` | ТУМАННОЕ ИСЧЕЗНОВЕНИЕ | реакция | Колдун · Архифея | A hooded figure dissolving into silver mist from the feet up. |
| 135 | `warlock-bezdonnyy-schupaltse-iz-glubin.png` | Щупальце из глубин | ▲ бонус | Колдун · Бездонный | A spectral sea-green tentacle rising from dark water. |
| 136 | `warlock-bezdonnyy-zaschitnyy-izgib.png` | Защитный изгиб | реакция | Колдун · Бездонный | A tentacle coiled protectively around a small round shield. |
| 137 | `warlock-vedmovskoy-klinok-proklyatie-vedmovskogo-klinka.png` | ПРОКЛЯТИЕ ВЕДЬМОВСКОГО КЛИНКА | ▲ бонус | Колдун · Ведьмовской клинок | A black blade with one glowing violet curse sigil on it. |
| 138 | `warlock-vedmovskoy-klinok-proklyatyy-dospeh.png` | ПРОКЛЯТЫЙ ДОСПЕХ | реакция | Колдун · Ведьмовской клинок | A dark breastplate etched with glowing violet hex runes. |
| 139 | `warlock-velikiy-drevniy-entropicheskaya-opeka.png` | ЭНТРОПИЧЕСКАЯ ОПЕКА | реакция | Колдун · Великий Древний | A swirling eldritch eye deflecting an incoming arrow. |
| 140 | `warlock-geniy-sosud-geniya.png` | Сосуд гения | ▲ бонус | Колдун · Гений | An ornate brass oil lamp emitting a curl of blue smoke. |
| 141 | `warlock-geniy-spasitelnyy-sosud.png` | Спасительный сосуд | ▲ бонус | Колдун · Гений | A glass bottle with a tiny glowing sanctuary room inside. |
| 142 | `warlock-geniy-stihiynyy-dar.png` | Стихийный дар | ▲ бонус | Колдун · Гений | A genie ring set with four small gems: flame, wave, stone, wind. |
| 143 | `warlock-nebozhitel-lechaschiy-svet.png` | ЛЕЧАЩИЙ СВЕТ | ▲ бонус | Колдун · Небожитель | An open palm releasing soft golden healing motes. |
| 144 | `warlock-nezhit-omertvevshaya-obolochka.png` | Омертвевшая оболочка | реакция | Колдун · Нежить | A withered skeletal ribcage glowing faint necrotic green. |
| 145 | `warlock-nezhit-uzhasayuschiy-oblik.png` | Ужасающий облик | ▲ бонус | Колдун · Нежить | A ghostly skull mask wreathed in green flames. |
| 146 | `wizard-voennaya-magiya-magicheskoe-otrazhenie.png` | МАГИЧЕСКОЕ ОТРАЖЕНИЕ | реакция | Волшебник · Военная магия | A glowing hexagonal arcane ward deflecting an arrow. |
| 147 | `wizard-magiya-graviturgii-agressivnoe-prityazhenie.png` | АГРЕССИВНОЕ ПРИТЯЖЕНИЕ | реакция | Волшебник · Магия гравитургии | A dark gravity orb with curved field lines pulling an arrow toward it. |
| 148 | `wizard-magiya-hronurgii-hrono-sdvig.png` | ХРОНО-СДВИГ | реакция | Волшебник · Магия хронургии | A brass astrolabe clock face whose hands sweep backward, a faint afterimage behind. |
| 149 | `wizard-orden-pistsov-probuzhdenie-razuma.png` | Пробуждение разума | ▲ бонус | Волшебник · Орден писцов | A floating spectral book spirit with one glowing eye on its cover. |
| 150 | `wizard-orden-pistsov-volshebnoe-pero.png` | Волшебное перо | ▲ бонус | Волшебник · Орден писцов | A floating glowing quill writing a short arcane line by itself. |
| 151 | `wizard-pesn-klinka-pesn-klinka.png` | Песнь клинка | ▲ бонус | Волшебник · Песнь клинка | An elegant rapier wrapped in a flowing silver melody ribbon. |
| 152 | `wizard-pesn-klinka-pesn-zaschity.png` | Песнь защиты | реакция | Волшебник · Песнь клинка | A rapier crossed with a shimmering translucent arcane shield. |
| 153 | `wizard-shkola-illyuzii-sobstvennaya-illyuzornost.png` | СОБСТВЕННАЯ ИЛЛЮЗОРНОСТЬ | реакция | Волшебник · Школа Иллюзии | A mirror-image duplicate figure shattering into glass shards. |
| 154 | `wizard-shkola-ograzhdeniya-proektsiya-zaschity.png` | ПРОЕКЦИЯ ЗАЩИТЫ | реакция | Волшебник · Школа Ограждения | A glowing arcane shield projected sideways from an outstretched palm. |
| 155 | `wizard-shkola-ocharovaniya-instinktivnoe-ocharovanie.png` | ИНСТИНКТИВНОЕ ОЧАРОВАНИЕ | реакция | Волшебник · Школа Очарования | A hypnotic spiral eye with a soft pink swirl. |
| 156 | `fighter-indomitable.png` | Упорство | клиент | Воин | A dented steel helmet standing unbowed, one golden glint on its crest. |
| 157 | `paladin-aura-of-protection.png` | Аура защиты | клиент | Паладин | A radiant golden aura ring around a shield emblem. |
