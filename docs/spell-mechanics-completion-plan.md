# План завершения механики заклинаний 0–6 круга

Исторический срез 19 сентября 2026. Текущие результаты и зелёный gate — в
[журнале общих механизмов](combat-foundations-progress.md), дальнейший порядок —
в [плане v3](combat-completion-plan-v3.md). Указанные ниже пробелы относятся
к исходному снимку и перед новой реализацией сверяются с текущим кодом.

Документ составлен по локальному корпусу `dnd.su`, который лежит в
`data/dndsu-spells-0-6.json`, и по серверным исправлениям
`data/dndsu-spell-mechanics-overrides.json`. Он описывает фактическое
покрытие и порядок следующей работы. Это не обещание, что любой текст карточки
уже стал правилом движка.

## Снимок корпуса и доказательства

На 19 сентября 2026 года в корпусе 439 уникальных карточек: 44 заговора, 77
заклинаний 1 круга, 85 — 2 круга, 73 — 3 круга, 52 — 4 круга, 61 — 5 круга и
47 — 6 круга. У каждой карточки непустое русское описание и ссылка
`https://www.dnd.su/spells/`. В корпусе нет отдельного поля `components` или
`material`; сведения о компонентах иногда находятся только в пересказе
`description`. Поэтому компонентная проверка пока невозможна как машинное
правило и не должна маскироваться под реализованную механику.

Из 439 карточек 249 имеют серверный override. Их статус и статус остальных
карточек вычисляются одинаково в `server/combat-spells.mjs`:

| Статус | Количество | Значение |
| --- | ---: | --- |
| `partial` | 240 | Сервер выполняет объявленную безопасную часть; остаток должен быть назван в `supportNote` или в тесте. |
| `heuristic` | 191 | Нет авторитетного обработчика; команда блокируется до расхода ресурса. |
| `ruling-only` | 8 | Для применения необходимо отдельное решение владельца и новый доменный примитив. |
| `verified` | 0 | Полностью проверенных карточек сейчас нет. |

Распределение по кругам:

| Круг | `partial` | `heuristic` | `ruling-only` | Всего |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 32 | 12 | 0 | 44 |
| 1 | 49 | 25 | 3 | 77 |
| 2 | 46 | 37 | 2 | 85 |
| 3 | 38 | 33 | 2 | 73 |
| 4 | 31 | 21 | 0 | 52 |
| 5 | 23 | 38 | 0 | 61 |
| 6 | 21 | 25 | 1 | 47 |
| **Итого** | **240** | **191** | **8** | **439** |

Повторяемые проверки источника и формы карточек:

```powershell
pnpm spells:verify
node --test test/dnd-combat-coverage.test.mjs test/spell-override-audit.test.mjs
node --test test/dndsu-2014-content.test.mjs test/spell-descriptions.test.mjs
```

Сейчас `pnpm spells:verify` сообщает `ok: true`, `checked: 249`,
`catalog: 439`, `corrections: 402`: 124 исправления вида карточки, 85 цели,
78 состояний без механических следствий, 37 спасбросков, 34 формулы урона, 25
дальностей и 19 типов урона. Это аудит согласованности локального снимка и
движка. Полный live-проход metadata через dnd.su прочитал 439/439 страниц:
`partial: 0`, `unavailable: 0`, mismatch после нормализации ritual-пометки: 0.
Это не построчная семантическая вычитка всех описаний. История ручной вычитки описаний и
первичные ссылки перечислены в
[`docs/spell-description-corrections-2026-09-08.md`](spell-description-corrections-2026-09-08.md).

В raw catalog `kind` остаётся результатом автоматического извлечения и служит
диагностикой. В merged profile effective kind берётся после применения
override; именно он используется Rules Engine и AV-профилем. Поэтому списки
ниже группируются по merged kind, а расхождение raw/merged не означает две
разные механики.

## Что уже является общим правилом

Новый spell не должен получать отдельный обработчик в UI. Авторитетный путь
состоит из следующих существующих владельцев:

| Примитив | Владелец | Что уже проверяется | Точный остаток |
| --- | --- | --- | --- |
| Каталог, класс, круг, ячейка | `server/combat-spells.mjs` | 12 классов × 12 уровней, подготовка, известные заклинания, pact slots | У карточек нет машинных компонентов и стоимости материалов. |
| Допуск и цель | `server/rules-engine.mjs`, `assertMechanicsSupported`, `spellTargetsAt` | права, живость, дальность, видимость, союзник/враг, площадь и крупные фишки | Нет цели `object`, выбора предмета и высоты; `point` не заменяет предметный идентификатор. |
| Атака заклинанием | ветка `CastSpell` `kind: attack` | d20, укрытие, высота, advantage/disadvantage, крит, урон, реакции | Нет общего контракта для каждого особого режима атаки и многократного действия в последующие ходы. |
| Спасбросок | ветки `save`, `area-save`, `debuff` | СЛ, иммунитеты, legendary resistance, half-on-save, условия | Отдельные повторные/выборочные спасброски надо объявлять полями override и покрывать по карточке. |
| Урон и лечение | `resolveDamagePayload`, ветки `damage`/`healing` | сопротивление, уязвимость, иммунитет, временные хиты, replay | Нет универсального правила особого урона при нарушении приказа, выходе из иллюзии или смерти. |
| Длящаяся область | `SpellAreaCreated`, `SpellAreaRemoved`, `areaEntryConsequences`, `areaTurnConsequences` | сроки, концентрация, вход, начало/конец хода, линии и базовые формы | Нет общего движения области, заряда применений, высоты/цилиндра и стен с разрушаемыми секциями. |
| Условия | reducer условий и `conditionAttackModifiers` | состояния из allowlist, длительность, повторные saves, break-on-damage | Состояние-маркер без зарегистрированного следствия всё ещё не является правилом. |
| Призыв | `SummonedCreatureCreated` и очередь инициативы | управляемый summon, концентрация, footprint, ход и базовая атака | Нет выбора опубликованной формы, общего приказа, неповиновения и небоевого companion-сенсора. |
| Телепорт | ветка `teleport` и `ActorMoved.teleport` | пустая клетка, дальность, LOS, old-origin для `thunder-step` | Нет переноса группы, межпланового состояния и высоты. |
| Долгое накладывание | `castingTimeMinutes`, `long_cast` guard | вне боя можно двигать мировое время, в бою карточка отклоняется | Все 56 `long_cast` карточек остаются `heuristic`/`ruling-only`; для них нет per-spell rule path. |
| Предвыбор и AV | `src/spell-targeting.ts`, `spell-effects.ts`, 2D/3D board | визуальная область, подтверждённый результат, replay-safe события | AV-профиль не открывает механику. Галерея не считается доказательством server rule. |

## Полный список `partial`

Ниже каждый из 240 ID встречается ровно один раз. kind в строке — merged
effective kind после применения override, а не сырой catalog kind. Ключ строки
имеет форму «круг | kind | количество | id,...»; это намеренно оставлено в
машинно читаемом виде, чтобы список можно было сверить с JSON без ручной
интерпретации.

```text
0 | area-save   |  4 | sword-burst,thunderclap,word-of-radiance,create-bonfire
0 | attack      | 10 | booming-blade,green-flame-blade,chill-touch,ray-of-frost,eldritch-blast,fire-bolt,primal-savagery,produce-flame,thorn-whip,shocking-grasp
0 | buff        |  8 | magic-stone,shillelagh,blade-ward,true-strike,light,resistance,guidance,spare-the-dying
0 | save        | 10 | acid-splash,vicious-mockery,lightning-lure,infestation,frostbite,toll-the-dead,mind-sliver,sacred-flame,gust,poison-spray
1 | area-damage |  2 | color-spray,sleep
1 | area-save   |  9 | thunderwave,earth-tremor,tasha-s-caustic-brew,frost-fingers,burning-hands,faerie-fire,entangle,arms-of-hadar,grease
1 | attack      |  6 | witch-bolt,ice-knife,ray-of-sickness,inflict-wounds,guiding-bolt,chromatic-orb
1 | buff        | 18 | bless,divine-favor,heroism,wrathful-smite,hail-of-thorns,thunderous-smite,armor-of-agathys,mage-armor,hunter-s-mark,ensnaring-strike,searing-smite,expeditious-retreat,false-life,hex,sanctuary,zephyr-strike,shield,shield-of-faith
1 | damage      |  1 | magic-missile
1 | debuff      |  6 | compelled-duel,cause-fear,tasha-s-hideous-laughter,charm-person,bane,command
1 | healing     |  2 | healing-word,cure-wounds
1 | save        |  3 | hellish-rebuke,dissonant-whispers,catapult
1 | utility     |  2 | silvery-barbs,absorb-elements
2 | area-damage |  4 | cordon-of-arrows,cloud-of-daggers,silence,spike-growth
2 | area-save   | 10 | shatter,moonbeam,web,aganazzar-s-scorcher,gust-of-wind,flaming-sphere,dust-devil,rime-s-binding-ice,snilloc-s-snowball-swarm,wither-and-bloom
2 | attack      |  3 | ray-of-enfeeblement,melf-s-acid-arrow,scorching-ray
2 | buff        | 13 | pass-without-trace,barkskin,protection-from-poison,warding-wind,branding-smite,magic-weapon,lesser-restoration,invisibility,mirror-image,aid,blur,kinetic-jaunt,enhance-ability
2 | damage      |  1 | heat-metal
2 | debuff      |  3 | blindness-deafness,hold-person,calm-emotions
2 | save        |  6 | suggestion,maximilian-s-earthen-grasp,crown-of-madness,mind-spike,tasha-s-mind-whip,enlarge-reduce
2 | summon      |  2 | spiritual-weapon,summon-beast
2 | teleport    |  1 | misty-step
2 | utility     |  3 | healing-spirit,knock,darkness
3 | area-damage |  1 | wall-of-sand
3 | area-save   | 14 | hypnotic-pattern,hunger-of-hadar,spirit-guardians,stinking-cloud,erupting-earth,melf-s-minute-meteors,sleet-storm,lightning-bolt,fireball,conjure-barrage,call-lightning,tidal-wave,wind-wall,fear
3 | attack      |  1 | vampiric-touch
3 | buff        | 10 | ashardalon-s-stride,intellect-fortress,crusader-s-mantle,beacon-of-hope,lightning-arrow,blinding-smite,spirit-shroud,flame-arrows,elemental-weapon,haste
3 | debuff      |  1 | slow
3 | healing     |  2 | mass-healing-word,life-transference
3 | save        |  1 | antagonize
3 | summon      |  5 | summon-undead,summon-shadowspawn,summon-fey,conjure-animals,summon-lesser-demons
3 | teleport    |  1 | thunder-step
3 | utility     |  2 | counterspell,dispel-magic
4 | area-save   |  7 | sickening-radiance,control-water,ice-storm,vitriolic-sphere,wall-of-fire,storm-sphere,evard-s-black-tentacles
4 | buff        |  9 | aura-of-life,aura-of-purity,greater-invisibility,death-ward,shadow-of-moil,fire-shield,polymorph,freedom-of-movement,guardian-of-nature
4 | save        |  8 | watery-sphere,phantasmal-killer,banishment,otiluke-s-resilient-sphere,charm-monster,dominate-beast,raulothim-s-psychic-lance,blight
4 | summon      |  6 | mordenkainen-s-faithful-hound,summon-greater-demon,summon-aberration,summon-construct,summon-elemental,conjure-woodland-beings
4 | teleport    |  1 | dimension-door
5 | area-save   | 10 | maelstrom,cone-of-cold,insect-plague,flame-strike,cloudkill,transmute-rock,conjure-volley,dawn,synaptic-static,wall-of-light
5 | attack      |  2 | bigby-s-hand,contagion
5 | buff        |  2 | greater-restoration,holy-weapon
5 | damage      |  1 | steel-wind-strike
5 | debuff      |  1 | hold-monster
5 | save        |  4 | immolation,enervation,dominate-person,negative-energy-flood
5 | summon      |  3 | animate-objects,summon-draconic-spirit,summon-celestial
6 | area-save   |  7 | bones-of-the-earth,circle-of-death,wall-of-ice,otiluke-s-freezing-sphere,sunbeam,blade-barrier,wall-of-thorns
6 | buff        |  4 | investiture-of-wind,investiture-of-ice,investiture-of-flame,tenser-s-transformation
6 | healing     |  1 | heal
6 | save        |  8 | mental-prison,mass-suggestion,otto-s-irresistible-dance,flesh-to-stone,chain-lightning,harm,eyebite,disintegrate
6 | summon      |  1 | summon-fiend
```

`partial` — не единый уровень качества. Остаточные расхождения уже записаны
в `supportNote` у сложных карточек; наиболее важные группы таковы:

- `cordon-of-arrows`, `guardian-of-faith`, `hail-of-thorns`,
  `melf-s-minute-meteors`, `flame-arrows`, `holy-weapon` требуют общего
  примитива ограниченных применений/зарядов;
- `flaming-sphere`, `storm-sphere`, `moonbeam`, `cloudkill`, `watery-sphere`,
  `control-water`, `melf-s-minute-meteors`, `sunbeam` требуют управляемого
  повторного действия или перемещения длящегося эффекта;
- семейство `summon-*`, `animate-objects`, `conjure-animals`,
  `summon-lesser-demons`, `summon-greater-demon`, `conjure-woodland-beings`,
  `wall-of-light`, `dawn` уже имеют безопасную часть, но не все формы,
  размеры, поведение и выбор существ из описания;
- `banishment`, `freedom-of-movement`, `aura-of-purity`, `warding-wind`,
  `silence`, `otiluke-s-resilient-sphere`, `investiture-*`, `spirit-shroud`,
  `haste`, `slow` зависят от более точных взаимодействий условий, типов атаки,
  компонентов или движения;
- `mass-healing-word`, `life-transference`, `mental-prison`, `mass-suggestion`,
  `steel-wind-strike` требуют отдельного per-target или multi-step контракта;
- `wall-of-fire`, `wall-of-ice`, `wall-of-thorns`, `blade-barrier`,
  `maelstrom`, `bones-of-the-earth`, `disintegrate` имеют остаточные вопросы
  по разрушаемым секциям, форме, высоте, притягиванию или специальному
  результату при нулевых хитах.

У остальных `partial` безопасная ветка покрыта тестами, но полного per-ID
перечня взаимодействий ещё нет. Нельзя повышать их до `verified` только по
тому, что в карточке совпали `kind`, `range` и формула урона.

## Полный список заблокированных карточек

Следующие строки содержат все 191 heuristic ID. Здесь отсутствие override —
само по себе воспроизводимый blocker: нет доверенного серверного контракта,
который можно было бы проверить. Группировка по merged effective kind и
кругу не означает, что два заклинания внутри группы имеют одинаковые правила;
сырой catalog kind остаётся только диагностикой парсера.

```text
0 | buff    | 2 | friends,dancing-lights
0 | utility | 10 | control-flames,mage-hand,druidcraft,mold-earth,minor-illusion,mending,message,prestidigitation,shape-water,thaumaturgy
1 | attack  | 2 | jims-magic-missile,chaos-bolt
1 | buff    | 6 | animal-friendship,protection-from-evil-and-good,beast-bond,unseen-servant,find-familiar,ceremony
1 | debuff  | 1 | snare
1 | utility | 16 | silent-image,distort-value,disguise-self,illusory-script,detect-poison-and-disease,detect-evil-and-good,purify-food-and-drink,comprehend-languages,jump,speak-with-animals,alarm,longstrider,create-or-destroy-water,tenser-s-floating-disk,fog-cloud,goodberry
2 | area-save | 2 | dragon-s-breath,spray-of-cards
2 | attack | 1 | flame-blade
2 | buff | 7 | see-invisibility,beast-sense,nathair-s-mischief,warding-bond,pyrotechnics,jims-glowing-coin,rope-trick
2 | damage | 2 | alter-self,shadow-blade
2 | debuff | 1 | enthrall
2 | healing | 1 | prayer-of-healing
2 | summon | 2 | phantasmal-force,flock-of-familiars
2 | teleport | 1 | vortex-warp
2 | utility | 20 | continual-flame,air-bubble,magic-mouth,arcane-lock,augury,borrowed-knowledge,skywrite,gentle-repose,nystul-s-magic-aura,zone-of-truth,detect-thoughts,spider-climb,locate-animals-or-plants,find-traps,locate-object,find-steed,animal-messenger,darkvision,earthbind,warp-sense
3 | area-save | 1 | glyph-of-warding
3 | attack | 1 | bestow-curse
3 | buff | 10 | wall-of-water,animate-dead,gaseous-form,catnap,protection-from-energy,tiny-servant,motivational-speech,major-image,clairvoyance,feign-death
3 | damage | 1 | meld-into-stone
3 | debuff | 1 | fast-friends
3 | healing | 1 | aura-of-vitality
3 | summon | 1 | phantom-steed
3 | teleport | 1 | magic-circle
3 | utility | 16 | galder-s-tower,daylight,enemies-abound,leomund-s-tiny-hut,blink,nondetection,water-breathing,sending,speak-with-dead,speak-with-plants,plant-growth,remove-curse,create-food-and-water,incite-greed,water-walk,tongues
4 | area-damage | 1 | guardian-of-faith
4 | buff | 2 | stoneskin,grasping-vine
4 | damage | 1 | elemental-bane
4 | debuff | 1 | compulsion
4 | save | 1 | staggering-smite
4 | summon | 3 | arcane-eye,find-greater-steed,conjure-minor-elementals
4 | teleport | 1 | mordenkainen-s-private-sanctum
4 | utility | 11 | galder-s-speedy-courier,giant-insect,spirit-of-death,gate-seal,fabricate,stone-shape,leomund-s-secret-chest,hallucinatory-terrain,locate-creature,divination,confusion
5 | area-damage | 1 | destructive-wave
5 | attack | 1 | wrath-of-nature
5 | buff | 10 | swift-quiver,control-winds,infernal-calling,wall-of-stone,circle-of-power,danse-macabre,awaken,telekinesis,skill-empowerment,mislead
5 | damage | 2 | banishing-smite,geas
5 | debuff | 2 | modify-memory,scrying
5 | healing | 1 | mass-cure-wounds
5 | save | 2 | dream,contact-other-plane
5 | teleport | 3 | far-step,teleportation-circle,hallow
5 | utility | 16 | tree-stride,legend-lore,rary-s-telepathic-bond,commune,commune-with-nature,raise-dead,planar-binding,antilife-shell,conjure-elemental,seeming,dispel-evil-and-good,reincarnate,wall-of-force,passwall,creation,creating-spelljamming-helm
6 | buff | 8 | magic-jar,drawmij-s-instant-summons,investiture-of-stone,primordial-ward,heroes-feast,tasha-s-otherworldly-guise,create-undead,wind-walk
6 | damage | 1 | create-homunculus
6 | summon | 2 | fizban-s-platinum-shield,conjure-fey
6 | teleport | 4 | forbiddance,arcane-gate,scatter,word-of-recall
6 | utility | 10 | move-earth,programmed-illusion,true-seeing,planar-ally,find-the-path,contingency,transport-via-plants,druid-grove,guards-and-wards,globe-of-invulnerability
```

Восемь `ruling-only` карточек — отдельная блокирующая группа:

```text
1 | utility | feather-fall,detect-magic,identify
2 | utility | levitate,gift-of-gab
3 | utility | revivify,fly
6 | buff    | soul-cage
```

Полнота этих списков уже сверена машинно: строки `partial` дают 240 ID без
дубликатов и точно совпадают с вычисленным статусом из двух JSON-файлов; строки
`heuristic` дают 191 ID без дубликатов; восемь ID `ruling-only` перечислены
отдельно. При изменении каталога проверку следует повторить тем же правилом:

```js
const status = (id) => overrides[id]?.mechanicsSupport ?? (overrides[id] ? 'partial' : 'heuristic')
const expected = spells.filter((spell) => status(spell.id) === wanted).map((spell) => spell.id)
const listed = rows.flatMap((row) => row.ids)
assert.deepEqual([...new Set(listed)].sort(), expected.sort())
```

## Точная карта отсутствующих примитивов

Один ID может иметь несколько пробелов. Ниже перечислены доменные причины,
которые следует ставить в следующий override или ADR; `heuristic` нельзя
снимать простой заменой статуса.

### 1. Долгое накладывание и ритуал

Все 56 карточек с `actionType: long_cast` пока заблокированы. Существующий
код умеет запретить их в бою и передвинуть мировые минуты вне боя, но не
разрешает карточку без проверенного эффекта. Полный список:

```text
mending,distort-value,illusory-script,identify,find-familiar,alarm,snare,ceremony,magic-mouth,augury,prayer-of-healing,find-steed,flock-of-familiars,animate-dead,galder-s-tower,tiny-servant,leomund-s-tiny-hut,magic-circle,motivational-speech,glyph-of-warding,clairvoyance,phantom-steed,gate-seal,fabricate,mordenkainen-s-private-sanctum,hallucinatory-terrain,find-greater-steed,conjure-minor-elementals,dream,legend-lore,infernal-calling,teleportation-circle,scrying,geas,commune,commune-with-nature,raise-dead,planar-binding,conjure-elemental,awaken,reincarnate,contact-other-plane,hallow,creation,magic-jar,drawmij-s-instant-summons,forbiddance,heroes-feast,planar-ally,find-the-path,contingency,conjure-fey,create-homunculus,create-undead,guards-and-wards,wind-walk
```

Это policy/command gap только для времени и экономики накладывания; полное
разблокирование всё равно требует отдельного per-spell эффекта. Ритуал не
должен автоматически означать бесплатное применение.

### 2. Компоненты, материальные предметы и стоимость — blocker source-pack

У всех 439 записей отсутствует структурное поле компонентов. В 79 описаниях
есть слова о компоненте, цене, порошке, камне или другом материале:

```text
control-flames,magic-stone,friends,shillelagh,mold-earth,mending,light,thorn-whip,shape-water,silent-image,heroism,earth-tremor,disguise-self,bane,create-or-destroy-water,zephyr-strike,ceremony,continual-flame,arcane-lock,augury,borrowed-knowledge,moonbeam,zone-of-truth,warding-bond,alter-self,silence,misty-step,kinetic-jaunt,wither-and-bloom,calm-emotions,ashardalon-s-stride,fast-friends,revivify,antagonize,galder-s-tower,intellect-fortress,beacon-of-hope,nondetection,water-breathing,summon-lesser-demons,meld-into-stone,create-food-and-water,incite-greed,water-walk,ice-storm,banishment,fabricate,stone-shape,stoneskin,leomund-s-secret-chest,hallucinatory-terrain,divination,summon-greater-demon,guardian-of-nature,wrath-of-nature,legend-lore,wall-of-stone,raise-dead,animate-objects,planar-binding,awaken,dispel-evil-and-good,reincarnate,hallow,creation,creating-spelljamming-helm,magic-jar,move-earth,drawmij-s-instant-summons,true-seeing,soul-cage,bones-of-the-earth,investiture-of-stone,heroes-feast,fizban-s-platinum-shield,contingency,scatter,create-homunculus,create-undead
```

Список является кандидатом на проверку, а не утверждением, что каждое
совпадение — именно обязательный компонент. Перед реализацией нужен
versioned source-pack из dnd.su с полями `verbal`, `somatic`, `material`,
`materialCost`, `consumed`, `focus`, `ritualText`; затем серверная проверка
наличия расходуемого предмета до `ResourceSpent`, UI-подсказка и тест replay.

### 3. Объект сцены, контейнер и предмет

У движка нет цели `object` и единого события «магическое свойство объекта
изменилось». Это блокирует `mage-hand`, `control-flames`, `mending`,
`arcane-lock`, `continual-flame`, `magic-mouth`, `stone-shape`, `fabricate`,
`leomund-s-secret-chest`, `create-or-destroy-water`, `purify-food-and-drink`,
`create-food-and-water`, `move-earth`, `drawmij-s-instant-summons` и часть
`knock`/`light`. Двери, контейнеры и реквизит уже имеют отдельные
server-owned state paths; следующий шаг должен связать их через существующий
`OperateSceneObject`/`SceneObjectStateChanged`, а не создавать второй объектный
движок.

### 4. Высота, падение, полёт и межплановое состояние — ruling/model blocker

Карта плоская, клетки не имеют высоты, а падение не создаёт события. Поэтому
`feather-fall`, `fly`, `levitate` остаются `ruling-only`; `jump`, `spider-climb`,
`water-walk`, `wind-walk`, `meld-into-stone`, `gaseous-form`, `tree-stride`,
`transport-via-plants`, `teleportation-circle`, `arcane-gate`, `scatter`,
`word-of-recall`, `forbiddance`, `hallow` и `mordenkainen-s-private-sanctum`
нельзя разблокировать одним визуальным эффектом. Нужны высота/слои,
переходы между планами, укрытие и падение как отдельные event/reducer
примитивы.

### 5. Иллюзия, память, язык, знание и приказ

Сервер не хранит проверяемый слой «что существо видит/знает/помнит», не имеет
обязательства существа и не моделирует содержание ответа. Сюда относятся
`friends`, `minor-illusion`, `silent-image`, `phantasmal-force`,
`nathair-s-mischief`, `major-image`, `programmed-illusion`, `mislead`,
`modify-memory`, `suggestion`, `fast-friends`, `compulsion`, `confusion`,
`geas`, `mass-suggestion`, `message`, `magic-mouth`, `comprehend-languages`,
`zone-of-truth`, `detect-thoughts`, `speak-with-dead`, `sending`, `tongues`,
`dream`, `commune`, `divination`, `legend-lore`, `rary-s-telepathic-bond`,
`scrying`, `true-seeing`, `find-the-path` и `contact-other-plane`. Нужны
bounded memory/observation/obligation contracts и viewer projection; текст
модели не может сам подтвердить такой эффект.

### 6. Спутники, формы, поведение и выбор статблока

Общий summon создаёт одну серверную приближенную форму. Не хватает выбора
формы, официального статблока, команд, автономного поведения и условий
неповиновения. Блок затрагивает `find-familiar`, `unseen-servant`, `find-steed`,
`phantom-steed`, `flock-of-familiars`, `animate-dead`, `tiny-servant`,
`giant-insect`, `arcane-eye`, `find-greater-steed`, `conjure-minor-elementals`,
`conjure-elemental`, `conjure-fey`, `create-homunculus`, `create-undead`,
`planar-ally`, `spirit-of-death`, `infernal-calling`, `danse-macabre` и
`fizban-s-platinum-shield`. Вариант существа должен быть выбран UI и
проверен сервером до создания `SummonedCreatureCreated`.

### 7. Движение и повторное действие длящегося эффекта

`SpellAreaCreated` сейчас хранит область, но не имеет общего авторитетного
`MoveSpellArea`/`ActivateSpellEffect` контракта. Поэтому в полной форме
заблокированы `dragon-s-breath`, `storm-sphere`, `control-water`, `wall-of-water`,
`flaming-sphere` (частичная карточка), `moonbeam` (частичная карточка),
`cloudkill` (частичная карточка), `watery-sphere` (частичная карточка),
`melf-s-minute-meteors` (частичная карточка), `sunbeam` (частичная карточка),
`sleet-storm`, `control-winds`, `wrath-of-nature`, `wall-of-stone`,
`wall-of-ice`, `wall-of-thorns`, `bones-of-the-earth` и `investiture-*`.
Нужно различать перенос центра, повторное действие, вход/конец хода и
изменение формы; простое изменение `center` в клиенте запрещено.

### 8. Ограниченные заряды и одноразовые триггеры

В активной области нет общего `usesRemaining`/`triggerBudget`. Из-за этого
`cordon-of-arrows`, `guardian-of-faith`, `melf-s-minute-meteors`,
`hail-of-thorns`, `flame-arrows`, `holy-weapon`, `guardian-of-nature`,
`glyph-of-warding`, `soul-cage` и `swift-quiver` нельзя честно считать
полными даже при наличии базового урона или условия. Заряд должен уменьшаться
событием в том же commit, что и подтверждённый триггер, а не по таймеру UI.

### 9. Жизненный цикл смерти и альтернативное тело

В бою не сохраняется точный момент смерти как игровая минута, а
`ResolveHeroDeath` владеет возвращением героя. Это блокирует `revivify` и
`soul-cage`. Переселение души и формы также требуют атомарного состояния тела:
`magic-jar`, `alter-self`, `gaseous-form`, `meld-into-stone`, `polymorph`,
`tasha-s-otherworldly-guise`, `create-homunculus`, `reincarnate`.

## Первая очередь вертикальных срезов

Ниже четыре среза с максимальным повторным использованием. Они не повышают
статус карточек автоматически: каждая карточка после внедрения получает
собственный override, описание расхождений и сценарии.

### Срез A — авторитетное движение и повторное действие длящейся области

Пилот: `flaming-sphere`, `storm-sphere`, `moonbeam`, `cloudkill`; затем
`watery-sphere`, `control-water`, `wall-of-water`.

Definition of done:

1. Команда `MoveSpellArea` или эквивалентный versioned command проходит только
   для живого владельца концентрации, проверяет action/bonus action, дальность,
   LOS, карту, форму и отсутствие клиентских координат вне server projection.
2. Сервер создаёт `SpellAreaMoved` с `from`, `to`, `effect_id`, фазой и
   `source_rule_ids`; reducer меняет ровно одну запись active effect.
3. Триггеры входа/конца хода используют новый центр; повторный idempotency key
   возвращает прежний commit, replay/restart сохраняет центр и срок.
4. Потеря концентрации и `dispel-magic` удаляют перемещённую область; старые
   события без `from/to` продолжают воспроизводиться.
5. UI показывает выбор клетки на карте и текущий контур без отдельного
   плавающего меню; 2D/3D используют одну проекцию. Тестируются права,
   отказ по дальности/LOS, союзники, туман и конфликт версии.

### Срез B — заряды, боеприпасы и одноразовые последствия эффекта

Пилот: `cordon-of-arrows`, `guardian-of-faith`, `melf-s-minute-meteors`,
`hail-of-thorns`, `flame-arrows`, затем `holy-weapon` и `soul-cage` после
решения жизненного цикла смерти.

Definition of done:

1. Профиль области/условия объявляет `usesMaximum`, `usesRemaining` и
   `triggerKind`; значения проверяются из каталога, а не из клиента.
2. `SpellEffectChargeSpent` создаётся атомарно с `DamageApplied`,
   `AttackResolved` или подтверждённым `ConditionAdded`; повторный commit не
   списывает заряд дважды.
3. Нулевой запас удаляет или деактивирует эффект. Урон, промах, спасбросок,
   крит, resistance/immunity и смерть цели имеют отдельные тесты.
4. Replay/restart/idempotency дают тот же остаток зарядов и журнал боя;
   projection не раскрывает скрытый запас врага.
5. UI показывает оставшийся запас только владельцу и предлагает действие на
   карте, без самовольного запуска эффекта из анимации.

### Срез C — цель-объект и магическое состояние реквизита

Пилот: `arcane-lock`, `mage-hand`, `mending`, `continual-flame`, `control-flames`,
`create-or-destroy-water`, `purify-food-and-drink`; `knock` остаётся образцом
для совместимости с уже существующими дверями и контейнерами.

Definition of done:

1. Ввести versioned `object_id` в command contract, но использовать текущие
   server-owned scene props, doors и containers; клиент не присылает произвольный
   объект или его состояние.
2. Валидация проверяет вид объекта, дистанцию, LOS, доступность, владельца,
   material component и action/long-cast policy. Несовместимый объект
   отклоняется до расхода ячейки.
3. Событие `SceneObjectMagicChanged` (или расширение существующего
   `SceneObjectStateChanged`) содержит spell id, старое/новое состояние,
   срок, источник правила и visibility. Reducer/replay/restart сохраняют ровно
   одну запись.
4. `dispel-magic`, разрушение объекта, продолжительный отдых и истечение
   срока имеют явные последствия. Ловушки и добыча не обходятся магией.
5. UI выбирает существующий объект прямо на карте, описывает отказ и не
   создаёт отдельного режима «Применить». Покрываются дверь, контейнер,
   реквизит, недоступный объект, скрытый объект и повторная команда.

### Срез D — безопасные долгие применения и компонентный контракт

Пилот после расширения source-pack: `find-familiar`, `find-steed`,
`phantom-steed`, `mending`, `continual-flame`, `arcane-lock`, `ceremony`;
сложные 56 `long_cast` карточек не разблокируются автоматически.

Definition of done:

1. Версионированный dnd.su source-pack добавляет структурные компоненты,
   стоимость, расходование, фокус, ritual и точное время. Текст описания
   остаётся справочным и не парсится регулярным выражением в бою.
2. `CastSpell` до `ResourceSpent` атомарно проверяет внебоевое время,
   компонент в inventory, владение/настройку, цель и отсутствие конфликта
   концентрации. В бою `long_cast` отклоняется тем же кодом, что сейчас.
3. События фиксируют `casting_time_minutes`, использованный компонент,
   spell id и rule ids; replay/idempotency не повторяют расход предмета или
   продвижение мирового времени.
4. UI показывает карточку времени и недостающий компонент, но не делает
   локальную задержку заменой серверного времени. После commit обновляются
   журнал, ресурсы и эффекты.
5. Каждый пилот имеет success/refusal/permissions/idempotency/replay тесты и
   ссылку на конкретную карточку dnd.su. Остальные long-cast карточки остаются
   заблокированными.

## Порядок проверки каждой следующей карточки

Для любого нового override сначала сверить русское описание и первичную
карточку dnd.su, затем определить расхождения редакций. После этого пройти
одну и ту же последовательность:

1. каталог: id, круг, класс, range, target, action type, concentration,
   components и duration;
2. command: права, цель, дальность, видимость, action economy, ресурс и
   серверная provenance;
3. rule: d20/формула/иммунитеты/conditions/geometry/trigger;
4. events: SpellCast, rolls, result, resources, concentration и special
   effect с versioned payload;
5. reducer: состояние после commit, срок, удаление, смерть, rest и
   взаимодействия областей;
6. replay/restart/idempotency и viewer projection;
7. основной 2D/3D UI: предвыбор клетки, cancel, подтверждённый результат,
   отсутствие скрытых координат и корректный звук/AV;
8. `pnpm spells:verify`, focused tests, затем `pnpm verify`.

Пока карточка не прошла этот путь, она остаётся `partial`, `heuristic` или
`ruling-only` по текущему контракту. Визуальная галерея всех 439 карточек,
наличие звука и совпадение с примером Baldur's Gate 3 не являются доказательством
механики или правильности взаимодействий.
