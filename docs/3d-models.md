# 3D-фигурки участников боя

Тактическая механика остаётся серверной. 3D-слой получает только уже видимого
участника и рисует его поверх клетки. Если каталог или файл модели недоступны,
остаётся встроенная миниатюра. При ошибке WebGL вся доска возвращается в 2D.

## Готовые модели — 12 сентября 2026

Путник (`traveler`, Peasant) и следопыт (`ranger`, Ranger) собраны из бесплатных
Standard-наборов Quaternius Universal Base Characters, Modular Character
Outfits Fantasy и Universal Animation Library. Одежда соединена с головой
базового персонажа; высота 1.25 клетки, с небольшим естественным изменением
силуэта в позе ожидания. GLB содержат по шесть исходных клипов:
`Idle_Loop`, `Walk_Loop`, `Sword_Attack`, `Spell_Simple_Shoot`, `Hit_Chest`,
`Death01`. Рост и координаты игры не зависят от root motion.

С 2 октября 2026 их заменили герои с причёсками (раздел «Герои реалистичных
пропорций» ниже); путник и следопыт остались ручным выбором. Бесплатные исходники
не содержат готовых Knight/Wizard: их названия не присваиваются этим моделям.
Лицензия CC0, источники и SHA-256 сохранены в
`public/assets/models/quaternius/NOTICE.json`. Исходные архивы не входят в Git.

Подготовка отдельного кандидата:

```bash
node tools/import-quaternius-actors.mjs --out tmp/quaternius-actor-candidate
```

Для другого расположения исходников есть `--base-dir`, `--outfit-dir`,
`--ual-file`, `--base-archive`, `--outfit-archive`, `--animation-archive`.
Инструмент проверяет закреплённые хеши, уменьшает текстуры до 512 пикселей,
проверяет автономность GLB и пишет модели вместе с происхождением в кандидата.
Он не меняет действующий каталог. Принятые файлы получают новые имена с хешем,
после чего их записи и права добавляются в общий каталог.

### Новые production-актеры

Скелет, гоблин и волк по умолчанию берутся из локального immutable-набора
`/assets/models/quaternius/actors-b892de8fd4f015796032/`; маг этого набора
(`hooded-mage`) с 2 октября 2026 — только ручной выбор. Старые восемь
ключей сохранены как ручной выбор и fallback. Источники, хеши производных GLB,
лицензии и runtime-проверки находятся в
`public/assets/models/quaternius/actors-b892de8fd4f015796032/NOTICE.json`.

| Ключ | Профиль и рост | Модель и rig | Реальные клипы / sockets |
| --- | --- | --- | --- |
| `hooded-mage` | mage · 1.25 | Ranger Quaternius с капюшоном; палитра одежды blue-violet | шесть UAL1-клипов; `hand_l`, `hand_r` |
| `wolf` | beast · 0.8 | Ultimate Animated Animal Pack; 51 bone | `Attack`, `Death`, `Idle`, `Walk`, hit-react и дополнительные; sockets нет |
| `goblin-quaternius` | goblin · 0.95 | Ultimate Animated Character Pack; 23 bone | `Idle`, `Walk`, `SwordSlash`, `RecieveHit`, `Death`; native `FistL/FistR` aliases |
| `skeleton-quaternius` | skeleton · 1.25 | Animated Monster Pack; 17 bone | `SkeletonArmature|Skeleton_Attack/Death/Running/Spawn/Idle`; native sockets на `_end` |

Все четыре GLB самодостаточны. В source animation удалены scale-каналы,
способные отменить `fitToHeight`; root-motion X/Z заморожен в рамках исходного
rig, статическое положение модели сохранено. У мага цвет меняется только в
зелёной области `MI_Ranger` baseColor PNG; яркость складок сохраняется, skin,
metal, boots, normal и ORM остаются исходными. У гоблина и скелета голова
уменьшена геометрически в bind pose до 0.78 и 0.65 соответственно.

Проверка production-набора выполняется частью `test/actor-models.test.mjs`:

```bash
node --test test/actor-models.test.mjs
```

Подключены четыре модели Kay Lousberg / KayKit из официальных наборов
[Adventurers](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0)
и [Skeletons](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0).
Оба набора распространяются по CC0; оригинальные тексты лицензий сохранены
рядом с моделями в `public/assets/models/kaykit/`.

| Ключ каталога | Готовая модель | Комплект внешности |
| --- | --- | --- |
| `warrior` | `kaykit/knight.glb` | Рыцарь с мечом и круглым щитом |
| `mage` | `kaykit/mage.glb` | Волшебник с посохом и книгой |
| `rogue` | `kaykit/rogue.glb` | Плут с двумя кинжалами |
| `skeleton` | `kaykit/skeleton-warrior.glb` | Скелет в шлеме; без оружия |

Модели KayKit 1.0 остаются в каталоге и доступны в меню «Фигурки» как ручной
выбор (подпись «· KayKit 1.0»). С 2 октября 2026 первыми для героев и скелетов
стоят фигурки KayKit 2.0 — см. следующий раздел. Все модели обслуживаются локально;
обращения к автору или GitHub во время игры не нужны.

Исходные версии закреплены: Adventurers —
`672074b73ba276876a19e8816ecdc5241817ab47`, Skeletons —
`15b62b9bad122f72926c10fb14d622c73819fa54`. Подготовка воспроизводится командой:

```bash
node tools/import-kaykit-models.mjs
node tools/register-asset-rights.mjs --all-under models
```

Инструмент скачивает файлы с этих коммитов, оставляет по шесть клипов
(`idle`, `walk`, `attack`, `cast`, `hit`, `death`), убирает одновременный показ
запасных мечей, щитов и арбалетов и вырезает неиспользуемые двоичные блоки.
Текстуры сохраняются без изменений внутри GLB. Четыре игровых файла занимают
около 2,3 МБ вместо 15,7 МБ исходников. Хеши готовых файлов зафиксированы в
`data/asset-rights.json`; инструмент также выводит хеши исходных загрузок.

Внешность KayKit стилизованная. При отсутствии новых данных оформления
сохраняется прежний комплект модели. С `appearance.equipment` версии 1 он
заменяется условным публичным комплектом. Версия 2 использует `equipmentUrl`
нейтральной основы и отдельные модели надетых вещей; [покрытие и контракт](visible-equipment.md).
Полные исходные наборы анимаций не загружаются
в игру. Для лука без подходящего клипа есть собственная поза прицеливания;
клипы меча, пистолета и арбалета для выстрела из лука не используются.

## KayKit Adventurers 2.0 и Skeletons 1.1 — 2 октября 2026

Десять анимированных фигурок из бесплатных наборов Kay Lousberg (CC0):
Adventurers 2.0 Free, Skeletons 1.1 Free и Character Animations 1.1 Free.
Все на общем риге Rig_Medium (23 кости, `handslot.l/.r`). Неизменяемый выпуск —
`public/assets/models/kaykit/characters-1d877e478221c89c84d8/`: десять GLB,
три лицензии и `NOTICE.json` (архивы, их SHA-256, хеши выходных файлов,
источник каждого клипа).

| Ключ | Профиль · рост | Встроенный комплект | Байт |
| --- | --- | --- | ---: |
| `kaykit-knight` | warrior · 1.34 | меч, геральдический щит; забрало снято | 600 116 |
| `kaykit-barbarian` | warrior · 1.34 | двуручный топор | 644 776 |
| `kaykit-mage` | mage · 1.49 | посох, книга | 622 448 |
| `kaykit-rogue` | rogue · 1.22 | два кинжала | 661 436 |
| `kaykit-ranger` | rogue · 1.27 | лук в левой руке, колчан | 748 116 |
| `kaykit-rogue-hooded` | rogue · 1.22 | два кинжала | 633 712 |
| `kaykit-skeleton-warrior` | skeleton · 1.45 | топор, большой щит | 760 944 |
| `kaykit-skeleton-rogue` | skeleton · 1.29 | клинок | 682 848 |
| `kaykit-skeleton-mage` | skeleton · 1.47 | посох | 668 736 |
| `kaykit-skeleton-minion` | skeleton · 1.21 | клинок, малый щит | 693 024 |

Рост — один масштаб рига на всех (тело без шляпы ≈ 1.22 клетки), поэтому шляпа
мага и рога шлема скелета дают большую высоту записи, а не уменьшают тело.
Стена — 0.95. Габарит считается без встроенного оружия: в T-позе двуручный
топор торчит ниже стоп.

**Клипы.** Из 139 клипов Rig_Medium встроены 14 (у скелетов — 15 + общий
`Attack`). Каналы привязаны по имени кости; единичный масштаб и каналы,
совпадающие с покоем кости, не переносятся. Удар и выстрел перетаймлены:
момент контакта (наибольшая скорость кисти) приходится на 0.3 такта ближнего
удара и на 0.2 такта выстрела — как контакт и выпуск на доске.

| Клип в GLB | Источник | Поза · вариант |
| --- | --- | --- |
| `Idle` | Idle_A (скелеты — Skeletons_Idle) | idle |
| `Walk` | Walking_A (скелеты — Skeletons_Walking) | walk |
| `Run` | Running_A | walk · run (доска пока не вызывает) |
| `Attack_Slash` | Melee_1H_Attack_Slice_Diagonal | attack · рубящее (по умолчанию) |
| `Attack_Stab` | Melee_1H_Attack_Stab | attack · колющее (кинжал, рапира, копьё…) |
| `Attack_Chop` | Melee_1H_Attack_Chop | attack · дробящее, посох |
| `Attack_TwoHanded` | Melee_2H_Attack_Chop | attack · двуручное (двуручный меч/топор/молот, глефа, алебарда, палица) |
| `Attack_Unarmed` | Melee_Unarmed_Attack_Punch_A | attack · без оружия |
| `Ranged_Bow` | Ranged_Bow_Release | ranged-attack · лук (по умолчанию) |
| `Ranged_Crossbow` | Ranged_2H_Shoot | ranged-attack · арбалет |
| `Ranged_Throw` | Throw | ranged-attack · бросок |
| `Cast` | Ranged_Magic_Shoot | cast |
| `Hit` | Hit_A | hit |
| `Death` | Death_A (скелеты — Skeletons_Death, рассыпаются; root X/Z погашен) | death |
| `Spawn` | Skeletons_Spawn_Ground (только скелеты) | spawn (доска пока не вызывает) |
| `Attack` | псевдоним клипа образа: варвар — двуручный, маг и скелет-маг/воин — дробящий, плуты — колющий | attack без внешности |

Вариант выбирается по снаряжению на момент удара (`attack_visual` / внешность):
`main_hand.model_key` → стиль. Без внешности играет клип образа модели.
Арбалет и бросок не подменяют лук: у модели без клипа `Ranged_Bow` выстрел из
лука остаётся локальной позой прицеливания.

**Снаряжение.** Встроенные вещи — статические меши `KayKitGear_*` на handslot
(ориентация KayKit: клинок вдоль оси Y ладони, вперёд в стойке). Как и у
KayKit 1.0, они видны только без серверной внешности; с внешностью v1 их
заменяет условный комплект, с v2 — модели надетых вещей. Запись каталога
`outfit: "builtin"` означает, что костюм вылеплен в модели: слой экипировки v2
рисует на ней только `main_hand`, `off_hand` и `focus`, без доспеха, плаща и
украшений поверх костюма. `equipmentUrl` у этих записей нет — внешность v2
рисуется на самой фигурке. Лук из инвентаря на риге KayKit уходит в левую
ладонь, если она свободна, и ложится вдоль оси Z handslot, как лук KayKit:
под это собраны клипы Ranged_Bow.

**Выбор по умолчанию снят 2 октября 2026.** Владелец счёл чиби-пропорции
слишком мультяшными: все записи `kaykit-*` помечены `auto: false` и открываются
только по ключу — из меню «Фигурки», примерки или сохранённого выбора в
браузере. Автоподбор ведёт к героям реалистичных пропорций (следующий раздел).
Механизм уточнения варианта внутри серверного профиля прежний: герой — по
классу (`archetype`), враг — только по словам показанного имени, не
совпадающим со словами первой записи профиля.

Подготовка воспроизводится из архивов itch.io (их размер и SHA-256 закреплены
в инструменте):

```bash
node tools/import-kaykit-models.mjs --v2 [--archives tmp/asset-src] [--out <каталог>]
node tools/register-asset-rights.mjs --all-under models/kaykit/characters-1d877e478221c89c84d8
```

Проверка — `test/actor-models.test.mjs` (разбор клипов, контейнер и NOTICE,
все позы, стопы на полу, +Z, выбор клипа по оружию, `outfit`, выбор варианта
внутри профиля) и `test/equipment-rig.test.mjs` (лук на риге KayKit).

## Герои реалистичных пропорций — 2 октября 2026

Шесть фигур из уже закреплённых Standard-архивов Quaternius (CC0): одежда
Modular Character Outfits Fantasy, голова и причёски Universal Base Characters
(«Rigged to Head Bone»), шесть клипов Universal Animation Library 1. Новых
загрузок не было. Выпуск — `public/assets/models/quaternius/heroes-<хеш>/`,
происхождение, SHA-256 всех входов и отчёт сборки — в его `NOTICE.json`.

| Ключ | Профиль · рост | Что это | Автоподбор | Размер |
| --- | --- | --- | --- | ---: |
| `hero-male` | warrior · 1.3 | одежда Peasant, стрижка и борода; основа под надетые вещи (`equipmentUrl` = сам файл) | fighter, paladin, barbarian, monk, обычный гуманоид-враг | 2,17 МиБ |
| `hero-female` | warrior · 1.3 | Peasant, длинные волосы; основа под вещи | только вручную | 2,02 МиБ |
| `mage-male` | mage · 1.3 | одежда Ranger в капюшоне, ткань перекрашена в сине-фиолетовый, седая борода, без наплечника; `outfit: builtin` | wizard, sorcerer, warlock, cleric, druid, bard | 2,76 МиБ |
| `mage-female` | mage · 1.3 | то же, женская фигура | только вручную | 2,78 МиБ |
| `ranger-male` | rogue · 1.3 | зелёная одежда Ranger в капюшоне, борода; `outfit: builtin` | rogue, ranger, scout, archer, assassin | 2,79 МиБ |
| `ranger-female` | rogue · 1.3 | Ranger без капюшона, причёска с пучками; `outfit: builtin` | только вручную | 2,88 МиБ |

Скелет по умолчанию — `skeleton-quaternius` (человеческие пропорции,
низкополигональная гранёная поверхность), гоблин и волк — прежние Quaternius.

**Пол.** В данных персонажа поля пола нет (ни в `Player`, ни в создании
персонажа, ни в серверной внешности). Поэтому автоподбор берёт мужской
вариант, а женский выбирается в меню «Фигурки» или в примерке; выбор живёт в
`skazanie-3d-models:<кампания>` браузера. Чтобы выбирать пол автоматически,
нужно серверное поле внешности героя — это изменение схемы, оно отложено до
решения владельца.

**Причёски.** Текстуры волос в наборе серые и рассчитаны на оттенок
материала. Без него брови прежних фигур были белыми, а головы — лысыми. Сборщик
добавляет к голове меши причёсок того же 65-костного рига и задаёт
`baseColorFactor` материалов `MI_Hair_*`: тёмно-русый, каштановый, рыжий,
седой, чёрный (`HAIR_TINTS`).

**Размер.** Прежний путник весил 3,4 МиБ, следопыт — 4,5 МиБ. Сборщик убирает то,
что рантайм не читает: вершинные цвета (во всём наборе белые), UV-каналы кроме
нулевого, недостижимые узлы (снятый капюшон, наплечник), каналы анимации,
совпадающие с позой покоя, и сворачивает постоянные каналы в один ключ.
`JOINTS_0` хранится байтами, `WEIGHTS_0` — нормализованными байтами (ядро
glTF), `NORMAL` — нормализованными байтами через `KHR_mesh_quantization`
(поддерживается GLTFLoader three.js). Roughness-карты уменьшены до 256 px,
остальные текстуры — как у прежних фигур (BaseColor 512, нормали 256).

Сборка воспроизводится байт в байт:

```bash
node tools/import-quaternius-actors.mjs --heroes --out tmp/heroes   # кандидат с NOTICE и id выпуска
# каталог из NOTICE.immutableRelease.id копируется в public/assets/models/quaternius/
node tools/register-asset-rights.mjs --all-under models/quaternius/heroes-<хеш>
node tools/register-asset-rights.mjs models/manifest.json
```

**Каталог.** Поле `auto: false` в записи `manifest.json` означает «только
ручной выбор»: `resolveModelProfile` пропускает такие записи во всех
автоматических путях (серверный профиль, точный класс, профиль по тексту,
запасной профиль), но явный `modelKey` по-прежнему находит любую запись.
Так помечены все `kaykit-*`, KayKit 1.0 (`warrior`, `mage`, `rogue`,
`skeleton`) и прежние лысые Quaternius (`traveler`, `ranger`, `hooded-mage`,
`human-female`). Ни один ключ не удалён, поэтому выбор, сохранённый игроком в
браузере, продолжает работать; на сервере модель не хранится. Примерка
(`EquipmentPreview`) по умолчанию показывает «По персонажу» — ту же фигуру,
что и доска, а не путника.

Проверка — `test/actor-models.test.mjs` (выпуск и NOTICE, ≤ 3 МиБ, причёски и
их оттенок, клипы, стопы на полу, +Z, сокеты `hand_l/hand_r`, шесть разных
поз, автоподбор без `auto: false`) и `test/import-quaternius-actors.test.mjs`
(сборка из архивов совпадает с опубликованным выпуском; пропускается без
архивов в `tmp/`).

## Звери Easy Enemies — 9 октября 2026

Пять зверей Quaternius «Animated Easy Enemies» (январь 2019, CC0 по странице
пака на itch.io; файла лицензии в архиве нет — это записано в `NOTICE.json` и
`LICENSE.txt` выпуска). Пак выпущен только в FBX: `tools/import-easy-enemies.mjs`
переводит его в GLB средствами three.js (`FBXLoader` → `GLTFExporter`),
меняет материалы Phong на PBR того же цвета и убирает префикс арматуры из
имён клипов. Выпуск — `public/assets/models/quaternius/creatures-<хеш>/`.

| Ключ | Профиль · рост | Подбирается по словам имени | Клипы |
| --- | --- | --- | --- |
| `rat` | beast · 0.5 | крыса, крысы, крыс, rat | Idle, Walk, Run, Attack, Death |
| `spider` | beast · 0.45 | паук, пауки, паучиха, spider | Idle, Walk, Attack, Death |
| `wasp` | beast · 0.6 | оса, осы, шершень, wasp | Flying, Attack, Death |
| `frog` | beast · 0.45 | лягушка, жаба, frog, toad | Idle, Attack, Death |
| `snake` | beast · 0.7 | змея, змей, гадюка, питон, удав, snake, viper | Idle, Walk, Attack (смерти в паке нет) |

Рост — для среднего размера; крошечная крыса и большой паук 2×2 получают свой
через `appearance.stature` и площадь (`figureHeightFor`). Сервер относит врага
к профилю `beast` по целому слову имени (`BEAST_WORDS` в
`server/actor-appearance.mjs`: «Крысолов» и «Осада» — не звери) или по типу
существа `beast` из стат-блока; замаскированное имя не раскрывается. Внутри
профиля фигурку выбирает слово показанного имени (`refineWithinProfile`); волк
остаётся первой записью и общим зверем — медведь и кабан рисуются им.

```bash
node tools/import-easy-enemies.mjs --publish   # из tmp/asset-src/dl-quaternius-animated-easy-enemies
node tools/register-asset-rights.mjs models/quaternius/creatures-<хеш>/<файл> ... models/manifest.json
```

Проверка — `test/creature-models.test.mjs`.

## API клиента

```ts
const actor = await createActorModel({
  id: 'hero-1',
  label: 'Илья',
  kind: 'hero',
  archetype: 'fighter',
  modelKey: 'warrior', // необязательно, подходит для выбора в браузере
  appearance: { version: 1, profile: 'warrior', equipment: 'sword-shield' },
}, { manifest })

scene.add(actor)
actor.id // идентификатор Three.js; игровой идентификатор — actor.actorId
actor.idle?.(performance.now() / 1000)
actor.update(deltaSeconds)
actor.setEquipment('bow') // визуальный комплект, не команда экипировки
actor.setPose('ranged-attack', .5)
actor.dispose() // перед удалением из сцены
```

`ActorModel` — это `THREE.Group` с feet-origin: после нормализации нижняя точка
находится на `y = 0`, центр по X/Z — в начале группы. Высота по умолчанию —
1.4 единицы клетки; production Quaternius задаёт 1.25 для мага и скелета,
0.95 для гоблина и 0.8 для волка. У procedural-модели есть `idle`, `walk`,
`attack`, `ranged-attack`, `cast`, `hit`, `death`; поза `spawn` у неё
совпадает с покоем. У GLB доступны все восемь методов (`spawn` — появление,
у скелетов KayKit — подъём из земли): найденный source clip проигрывается напрямую, а для отсутствующего
клипа используется idle-поза; `ranged-attack` использует локальное прицеливание
при наличии подходящего rig. Выдуманные bow/cast-клипы не добавляются.

Для списка выбора используется чистая функция:

```ts
const choices = availableActorModels(manifest)
// [{ key, label, profile, source: 'procedural' | 'glb', actorIds, archetypes }]
```

В готовой 3D-доске выбор находится в `3D → Фигурки → Участник / Модель`.
Компонент хранит записи вида `{ [actorId]: modelKey }` в `localStorage` по
ключу `skazanie-3d-models:<campaignId>`. Передавать выбранный ключ нужно как
`modelKey` во входе фигурки; серверное состояние и `actorId` при этом не
изменяются. Для автоматического назначения
используется порядок `modelKey` → разрешённый сервером `appearance.profile` →
прежние `actorIds`/архетип/имя/тип. Сервер строит `actor_appearances` после
проверки видимости, не передавая закрытый инвентарь или скрытую личность NPC.

`AttackResolved.payload.attack_visual` фиксирует `version: 1` и `equipment`
на момент атаки. Проекция фильтрует участников и траекторию, BattleLog хранит
разрешённый снимок для повторного подключения. Доска выбирает позу и эффект
по `attack_kind` и этому снимку, а по завершении возвращает текущий комплект.
Поздняя загрузка GLB следует той же активной реплике. Старые события без
снимка используют совместимый общий эффект. Все эти поля описывают только
оформление; расход ресурсов и попадание определяет Rules Engine.

## Добавление GLB

1. Положить самодостаточный `.glb` в `public/assets/models/`. В GLB должны быть
   встроены binary buffer, изображения и материалы; внешние `.bin`, текстуры,
   `http(s)`, `//` и `..` ссылки запрещены.
2. В `manifest.json` заменить `url: null` у нужной записи на путь вида
   `/assets/models/my-warrior.glb` и оставить `profile`, стабильный `key` и
   `rights.source`, `rights.license`, `rights.attribution`.
3. `actorIds` и `archetypes` сохраняют назначения для клиентов без серверного
   `appearance`. При наличии разрешённого профиля выбирается первая запись
   этого профиля: прежняя привязка не должна раскрывать замаскированную личность.
   Один `actorId` не может принадлежать двум записям.
4. В браузере при необходимости выбрать запись из `availableActorModels` и
   сохранить только её `key` локально.

Каталог и GLB ограничены по размеру и времени загрузки. `validateModelManifest`
проверяет форму и права до запроса, а `validateGlbContainer` проверяет заголовок,
JSON chunk и отсутствие внешних ресурсов до передачи данных Three.js. Загруженные
байты кэшируются; `clearActorModelCache()` очищает их. Каждый созданный Group
владеет собственными геометриями, материалами и текстурами, поэтому его `dispose`
безопасен для соседних фигурок.

Резервные шесть процедурных профилей — оригинальная low-poly стилизация с оружием,
головными деталями, конечностями, цветовым кольцом и базовыми позами. Это
визуальный fallback, а не ассеты Baldur's Gate 3. GLB без нужного клипа сохраняет
idle-позу для этой команды; WebGL-ошибка обрабатывается внешней доской и
переводит весь вид обратно в 2D.

После добавления GLB нужно зарегистрировать каждый файл в общем реестре
идентичности (права в manifest не заменяют хеш):

```bash
node tools/register-asset-rights.mjs --all-under models
```

Перед регистрацией проверьте лицензию, атрибуцию и право на распространение.
Команда обновляет только записи для `public/assets/models`; статус прав в
`data/asset-rights.json` меняется владельцем осознанно.

## Модели окружения и изображения для 2D

У предметов отдельный каталог — `public/assets/models/environment/manifest.json`.
Он использует те же `assetId`, что серверная генерация: `chair`, `barrel`,
`tree_oak` и другие. Здесь нет назначений героям; меню «Фигурки» продолжает
управлять только участниками боя.

Источники библиотеки:

- [Fantasy Props MegaKit Standard — Quaternius](https://quaternius.com/packs/fantasypropsmegakit.html), CC0: текстурированные предметы для средневековой обстановки.
- [Nature Kit — Kenney](https://kenney.nl/assets/nature-kit), CC0: пни, брёвна, костры, изгороди, статуи и сталагмиты.
- [Stylized Nature MegaKit (Standard) — Quaternius](https://quaternius.itch.io/stylized-nature-megakit), CC0: деревья, ели, сухие деревья, кусты, папоротник, трава, цветы, грибы и валуны. С выпуска `5f884daa35bf2ebe49f61f75` заменяет гранёные деревья и кусты Nature Kit.
- [KayKit Dungeon Remastered — Kay Lousberg](https://github.com/KayKit-Game-Assets/KayKit-Dungeon-Remastered-1.0), CC0: бочки, бочонок, ящики, сундуки с открываемой крышкой, настенный факел, колонна, монеты и обломки — в стиле фигурок KayKit.
- [Graveyard Kit — Kenney](https://kenney.nl/assets/graveyard-kit), CC0: могилы (холм с надгробием собран из двух файлов набора), каменный саркофаг, урны и обломки; палитра приглушена под склеп.

Это стилизованное окружение, а не реалистичные ассеты Baldur’s Gate 3.
Модели подготовлены как самодостаточные GLB; исходные архивы не входят в
репозиторий. Происхождение, лицензии и SHA-256 исходников записаны рядом с
файлами. `pnpm models:prepare --out tmp/environment-candidate-1` проверяет
закреплённые хеши архивов, импортирует локальные исходники и применяет палитру.
Три дополнительных набора описаны в `tools/environment-packs.mjs` и по
умолчанию читаются из `tmp/asset-src/` (`--packs-root` задаёт другой каталог).
Новые наборы дают только варианты существующих видов реестра: новых `assetId`
они не добавляют, проходимость и взаимодействия по-прежнему задаёт реестр.
Промежуточные файлы находятся в кандидате, а действующие ассеты не перезаписываются.

Виды сверху создаёт `tools/render-prop-model-atlas.mjs`, вызываемый подготовкой.
Он использует те же игровые GLB и исходные повороты; полученные кадры `topdown.png` подключаются
к обычной 2D-доске. Габарит, поворот, масштаб и выбор варианта совпадают между
двумя режимами. После проверки `pnpm models:publish --dir tmp/environment-candidate-1`
публикует неизменяемые файлы и переключает каталог, сохраняя старые адреса.
Полный порядок работы — [генерация 2D/3D](3d-generation.md).

Запись с пустым `assetIds` хранится в библиотеке, но не участвует в генерации.
Для добавления нового вида игрового предмета по-прежнему нужен существующий
реестр и серверные правила; один GLB сам по себе не добавляет взаимодействий.
