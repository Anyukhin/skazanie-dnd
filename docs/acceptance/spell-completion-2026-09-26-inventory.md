# Инвентаризация завершения заклинаний — 26 сентября 2026

Это read-only срез каталога D&D 2014, а не заявление о готовности игры. Он
снят с `HEAD 3eeb0dbd602f22f8683e8af5322a1b1a24d08694` и текущего dirty дерева
ветки `codex/combat-wave10` командой:

```text
pnpm spells:acceptance --details
```

Отчёт acceptance строится из единственного `data/dndsu-spells-0-6.json` и
effective-профилей `server/combat-spells.mjs`. Наличие `supportStatus`, AV-
профиля, текста, иконки или маршрута на сайте не переводит карточку в
`verified` и не доказывает, что все ветки её правила исполняются.

## Текущий счётчик

| Показатель | Сейчас | Что именно считается |
| --- | ---: | --- |
| Карточки каталога | 439 | Круги 0–6: 44 / 77 / 85 / 73 / 52 / 61 / 47 |
| `partial` | 248 | Сервер исполняет названную безопасную часть, остаток открыт |
| `heuristic` | 183 | Нет доверенного server-owned rule path; применение блокируется |
| `ruling-only` | 8 | Нужна отдельная доменная модель или принятое ruling; применение блокируется |
| `verified` | 0 | Полного статуса в effective-каталоге нет |
| Заблокировано до расхода | 191 | `heuristic + ruling-only` |
| Принято по всем измерениям | 0 | `accepted: true` требует rules, playerPath, resilience, permissions и presentation |
| Спецификация | 435 inventory-only / 4 pilot-draft | Ни одна карточка не имеет `reviewed`-спецификации |

Исходная контрольная точка `9277df0` имела 240 `partial`, 191 `heuristic` и
8 `ruling-only`. В текущем dirty срезе из заблокированной группы в `partial`
перешли `longstrider`, `borrowed-knowledge`, `prayer-of-healing`,
`spray-of-cards`, `protection-from-energy`, `mass-cure-wounds`,
`destructive-wave` и `skill-empowerment`; это не полная
приёмка. Evidence `longstrider` остаётся `stale`, потому что его отпечатки
относятся к старому дереву.

### Контент и представление

| Слой | Состояние | Граница утверждения |
| --- | ---: | --- |
| Русские описания | 439 / 439 | `test/spell-descriptions.test.mjs`; 90–599 знаков, без дублей и машинных маркеров, это краткий пересказ, не specification |
| Подробности для чтения | 439 / 439 | Собственные пересказы после перекрёстной сверки; 164 текста усиления и 275 явных отсутствий. `test/spell-reader-contract.test.mjs` |
| Подклассы источника | 439 / 439 проверены | 204 непустых списка, у 235 отдельных строк нет; это не расширение доступных игровых подклассов |
| Локальные карточки сайта | 439 / 439 | `audit-content-presentation.mjs`: описания и локальные изображения присутствуют |
| Machine-readable effective profiles | 439 / 439 | Есть id, круг, школа, классы, дальность, время, длительность, target, kind, actionType, damage/healing/save/conditions по применимости, V/S/M |
| Source cache facts | 439 / 439 | Все обязательные source facts наблюдены и сверены; `sourceBooks` отсутствует в 62 retry-записях, в локальном каталоге поле заполнено для 439 / 439 |
| Структурированные компоненты | 439 / 439 | `componentsSchemaVersion: 1`; 413 verbal, 376 somatic, 233 material |
| Материальные требования | 220 разрешены / 13 unresolved | Наличие поля не означает, что конкретный расход и весь набор уже проверены |
| Авторские отчисления | 3 | `jims-magic-missile`, `gift-of-gab`, `jims-glowing-coin`; отдельная оплата ещё не является общей приёмкой |
| Spell icons | 439 / 439 | 532 PNG action-icons всего: 439 spell ID и 93 runtime action ID; манифест проверяет обе стороны |
| Combat presentation structure | PASS | 172 визуальных профиля, 42 группы повторного использования, 53 audio clips |
| Browser/audio acceptance | pending | Структурный аудит не заменяет ручной 2D/3D проход двумя игроками и прослушивание |

Тринадцать неразрешённых материальных наборов:

```text
protection-from-evil-and-good, augury, warding-bond, magic-circle,
clairvoyance, galder-s-speedy-courier, leomund-s-secret-chest, legend-lore,
scrying, magic-jar, find-the-path, create-homunculus, create-undead
```

По смысловым полям остаются 16 raw-карточек без полной геометрии области; после
слияния effective-профилей нерешённой остаётся только `guardian-of-faith`.
В прежнем кэше не было подклассов. Их повторно сверили по карточкам dnd.su,
включая подтверждённые страницы 2014 на прежних адресах. Метаданные и
отпечатки читательских текстов — в
[отчёте источников](spell-reader-source-receipt-2026-09-26.json).

## Полные ID-группы по effective status

Группы ниже составлены из последнего acceptance-среза. Формат строки:
`круг | effective kind | количество | spell_id`. ID внутри строки не означают
одинаковый остаток правил; `kind` нужен для воспроизводимого разбиения каталога.

### `partial` — 248

```text
0 | area-save | 4 | sword-burst,thunderclap,word-of-radiance,create-bonfire
0 | attack | 10 | booming-blade,green-flame-blade,chill-touch,ray-of-frost,eldritch-blast,fire-bolt,primal-savagery,produce-flame,thorn-whip,shocking-grasp
0 | buff | 8 | magic-stone,shillelagh,blade-ward,true-strike,light,resistance,guidance,spare-the-dying
0 | save | 10 | acid-splash,vicious-mockery,lightning-lure,infestation,frostbite,toll-the-dead,mind-sliver,sacred-flame,gust,poison-spray
1 | area-damage | 2 | color-spray,sleep
1 | area-save | 9 | thunderwave,earth-tremor,tasha-s-caustic-brew,frost-fingers,burning-hands,faerie-fire,entangle,arms-of-hadar,grease
1 | attack | 6 | witch-bolt,ice-knife,ray-of-sickness,inflict-wounds,guiding-bolt,chromatic-orb
1 | buff | 19 | bless,divine-favor,heroism,wrathful-smite,hail-of-thorns,thunderous-smite,armor-of-agathys,mage-armor,hunter-s-mark,ensnaring-strike,searing-smite,expeditious-retreat,false-life,hex,longstrider,sanctuary,zephyr-strike,shield,shield-of-faith
1 | damage | 1 | magic-missile
1 | debuff | 6 | compelled-duel,cause-fear,tasha-s-hideous-laughter,charm-person,bane,command
1 | healing | 2 | healing-word,cure-wounds
1 | save | 3 | hellish-rebuke,dissonant-whispers,catapult
1 | utility | 2 | silvery-barbs,absorb-elements
2 | area-damage | 4 | cordon-of-arrows,cloud-of-daggers,silence,spike-growth
2 | area-save | 11 | shatter,moonbeam,web,aganazzar-s-scorcher,gust-of-wind,flaming-sphere,dust-devil,spray-of-cards,rime-s-binding-ice,snilloc-s-snowball-swarm,wither-and-bloom
2 | attack | 3 | ray-of-enfeeblement,melf-s-acid-arrow,scorching-ray
2 | buff | 13 | pass-without-trace,barkskin,protection-from-poison,warding-wind,branding-smite,magic-weapon,lesser-restoration,invisibility,mirror-image,aid,blur,kinetic-jaunt,enhance-ability
2 | damage | 1 | heat-metal
2 | debuff | 3 | blindness-deafness,hold-person,calm-emotions
2 | healing | 1 | prayer-of-healing
2 | save | 6 | suggestion,maximilian-s-earthen-grasp,crown-of-madness,mind-spike,tasha-s-mind-whip,enlarge-reduce
2 | summon | 2 | spiritual-weapon,summon-beast
2 | teleport | 1 | misty-step
2 | utility | 4 | borrowed-knowledge,healing-spirit,knock,darkness
3 | area-damage | 1 | wall-of-sand
3 | area-save | 14 | hypnotic-pattern,hunger-of-hadar,spirit-guardians,stinking-cloud,erupting-earth,melf-s-minute-meteors,sleet-storm,lightning-bolt,fireball,conjure-barrage,call-lightning,tidal-wave,wind-wall,fear
3 | attack | 1 | vampiric-touch
3 | buff | 11 | ashardalon-s-stride,protection-from-energy,intellect-fortress,crusader-s-mantle,beacon-of-hope,lightning-arrow,blinding-smite,spirit-shroud,flame-arrows,elemental-weapon,haste
3 | debuff | 1 | slow
3 | healing | 2 | mass-healing-word,life-transference
3 | save | 1 | antagonize
3 | summon | 5 | summon-undead,summon-shadowspawn,summon-fey,conjure-animals,summon-lesser-demons
3 | teleport | 1 | thunder-step
3 | utility | 2 | counterspell,dispel-magic
4 | area-save | 7 | sickening-radiance,control-water,ice-storm,vitriolic-sphere,wall-of-fire,storm-sphere,evard-s-black-tentacles
4 | buff | 9 | aura-of-life,aura-of-purity,greater-invisibility,death-ward,shadow-of-moil,fire-shield,polymorph,freedom-of-movement,guardian-of-nature
4 | save | 8 | watery-sphere,phantasmal-killer,banishment,otiluke-s-resilient-sphere,charm-monster,dominate-beast,raulothim-s-psychic-lance,blight
4 | summon | 6 | mordenkainen-s-faithful-hound,summon-greater-demon,summon-aberration,summon-construct,summon-elemental,conjure-woodland-beings
4 | teleport | 1 | dimension-door
5 | area-save | 11 | maelstrom,cone-of-cold,insect-plague,flame-strike,cloudkill,transmute-rock,conjure-volley,destructive-wave,dawn,synaptic-static,wall-of-light
5 | attack | 2 | bigby-s-hand,contagion
5 | buff | 3 | greater-restoration,holy-weapon,skill-empowerment
5 | damage | 1 | steel-wind-strike
5 | debuff | 1 | hold-monster
5 | healing | 1 | mass-cure-wounds
5 | save | 4 | immolation,enervation,dominate-person,negative-energy-flood
5 | summon | 3 | animate-objects,summon-draconic-spirit,summon-celestial
6 | area-save | 7 | bones-of-the-earth,circle-of-death,wall-of-ice,otiluke-s-freezing-sphere,sunbeam,blade-barrier,wall-of-thorns
6 | buff | 4 | investiture-of-wind,investiture-of-ice,investiture-of-flame,tenser-s-transformation
6 | healing | 1 | heal
6 | save | 8 | mental-prison,mass-suggestion,otto-s-irresistible-dance,flesh-to-stone,chain-lightning,harm,eyebite,disintegrate
6 | summon | 1 | summon-fiend
TOTAL |  | 248 |
```

### `heuristic` — 183

```text
0 | buff | 2 | friends,dancing-lights
0 | utility | 10 | control-flames,mage-hand,druidcraft,mold-earth,minor-illusion,mending,message,prestidigitation,shape-water,thaumaturgy
1 | attack | 2 | jims-magic-missile,chaos-bolt
1 | buff | 6 | animal-friendship,protection-from-evil-and-good,beast-bond,unseen-servant,find-familiar,ceremony
1 | debuff | 1 | snare
1 | utility | 15 | silent-image,distort-value,disguise-self,illusory-script,detect-poison-and-disease,detect-evil-and-good,purify-food-and-drink,comprehend-languages,jump,speak-with-animals,alarm,create-or-destroy-water,tenser-s-floating-disk,fog-cloud,goodberry
2 | area-save | 1 | dragon-s-breath
2 | attack | 1 | flame-blade
2 | buff | 7 | see-invisibility,beast-sense,nathair-s-mischief,warding-bond,pyrotechnics,jims-glowing-coin,rope-trick
2 | damage | 2 | alter-self,shadow-blade
2 | debuff | 1 | enthrall
2 | summon | 2 | phantasmal-force,flock-of-familiars
2 | teleport | 1 | vortex-warp
2 | utility | 19 | continual-flame,air-bubble,magic-mouth,arcane-lock,augury,skywrite,gentle-repose,nystul-s-magic-aura,zone-of-truth,detect-thoughts,spider-climb,locate-animals-or-plants,find-traps,locate-object,find-steed,animal-messenger,darkvision,earthbind,warp-sense
3 | area-save | 1 | glyph-of-warding
3 | attack | 1 | bestow-curse
3 | buff | 9 | wall-of-water,animate-dead,gaseous-form,catnap,tiny-servant,motivational-speech,major-image,clairvoyance,feign-death
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
5 | attack | 1 | wrath-of-nature
5 | buff | 9 | swift-quiver,control-winds,infernal-calling,wall-of-stone,circle-of-power,danse-macabre,awaken,telekinesis,mislead
5 | damage | 2 | banishing-smite,geas
5 | debuff | 2 | modify-memory,scrying
5 | save | 2 | dream,contact-other-plane
5 | teleport | 3 | far-step,teleportation-circle,hallow
5 | utility | 16 | tree-stride,legend-lore,rary-s-telepathic-bond,commune,commune-with-nature,raise-dead,planar-binding,antilife-shell,conjure-elemental,seeming,dispel-evil-and-good,reincarnate,wall-of-force,passwall,creation,creating-spelljamming-helm
6 | buff | 8 | magic-jar,drawmij-s-instant-summons,investiture-of-stone,primordial-ward,heroes-feast,tasha-s-otherworldly-guise,create-undead,wind-walk
6 | damage | 1 | create-homunculus
6 | summon | 2 | fizban-s-platinum-shield,conjure-fey
6 | teleport | 4 | forbiddance,arcane-gate,scatter,word-of-recall
6 | utility | 10 | move-earth,programmed-illusion,true-seeing,planar-ally,find-the-path,contingency,transport-via-plants,druid-grove,guards-and-wards,globe-of-invulnerability
TOTAL |  | 183 |
```

### `ruling-only` — 8

```text
1 | utility | 3 | detect-magic,identify,feather-fall
2 | utility | 2 | levitate,gift-of-gab
3 | utility | 2 | revivify,fly
6 | utility | 1 | soul-cage
TOTAL |  | 8 |
```

## Отсутствующие общие примитивы

Ниже группы пересекаются: один ID может ждать одновременно компонент, длительное
накладывание, высоту и собственный эффект. Число в скобках — `blocked /
partial` внутри именно этой группы, а не новые уникальные карточки.

### 1. Длительное накладывание, ритуал и прерывание — 57 (57 / 0)

Нужен один versioned `CastSpellStarted → CastSpellCompleted/Canceled` с
серверными минутами, боевой блокировкой, фокусом, материалом, потерей действия,
идемпотентностью и восстановлением после restart. Он не должен автоматически
разблокировать эффект, но даст честный общий путь для:

```text
mending,distort-value,illusory-script,identify,find-familiar,alarm,snare,
ceremony,magic-mouth,augury,prayer-of-healing,find-steed,flock-of-familiars,
animate-dead,galder-s-tower,tiny-servant,leomund-s-tiny-hut,magic-circle,
motivational-speech,glyph-of-warding,clairvoyance,phantom-steed,gate-seal,
fabricate,mordenkainen-s-private-sanctum,hallucinatory-terrain,find-greater-steed,
conjure-minor-elementals,dream,legend-lore,infernal-calling,
teleportation-circle,scrying,geas,commune,commune-with-nature,raise-dead,
planar-binding,conjure-elemental,awaken,reincarnate,contact-other-plane,hallow,
creation,magic-jar,drawmij-s-instant-summons,forbiddance,heroes-feast,
planar-ally,find-the-path,contingency,conjure-fey,druid-grove,create-homunculus,
create-undead,guards-and-wards,wind-walk
```

### 2. Перемещение и повторное действие области — 20 (5 / 15)

Нужны `MoveSpellArea`/`ActivateSpellEffect`, `SpellAreaMoved` с origin и
phase, новый центр в триггерах входа и конца хода, LOS, action economy,
концентрация, `dispel-magic`, replay и projection. Текущая `circle-grid-v2`
закрывает растеризацию для `fireball` и `mass-cure-wounds`, но не этот
жизненный цикл.

```text
blocked: dragon-s-breath,wall-of-water,control-winds,wrath-of-nature,wall-of-stone
partial: storm-sphere,control-water,flaming-sphere,moonbeam,cloudkill,
  watery-sphere,melf-s-minute-meteors,sunbeam,sleet-storm,wall-of-ice,
  wall-of-thorns,bones-of-the-earth,investiture-of-wind,investiture-of-ice,
  investiture-of-flame
```

### 3. Ограниченные заряды и одноразовые триггеры — 10 (4 / 6)

Нужны `usesMaximum`, `usesRemaining`, `triggerKind` и атомарное
`SpellEffectChargeSpent` в том же commit, что и урон/условие. Нулевой запас
должен деактивировать эффект, а projection скрывать чужой запас.

```text
blocked: guardian-of-faith,glyph-of-warding,swift-quiver,soul-cage
partial: cordon-of-arrows,melf-s-minute-meteors,hail-of-thorns,flame-arrows,
  holy-weapon,guardian-of-nature
```

### 4. Цель-объект и магическое состояние сцены — 16 (14 / 2)

Нужны `object_id` из server-owned doors/containers/props и
`SceneObjectMagicChanged` (либо расширение существующего события) с проверкой
вида объекта, LOS, срока, компонента, разрушения и `dispel-magic`. В текущем
effective-каталоге нет ни одного `target: object`; point-target сам по себе
не доказывает объектную механику.

```text
blocked: mage-hand,control-flames,mending,arcane-lock,continual-flame,
  magic-mouth,stone-shape,fabricate,leomund-s-secret-chest,
  create-or-destroy-water,purify-food-and-drink,create-food-and-water,
  move-earth,drawmij-s-instant-summons
partial: knock,light
```

### 5. Высота, падение и межплановый переход — 18 (18 / 0)

Нужны height/layer в клетке, досягаемость и укрытие в объёме, падение как
событие, а для транспорта — адресат/план и сохранённое прибытие. Один VFX или
изменение скорости не заменяет этот примитив.

```text
ruling-only: feather-fall,fly,levitate
heuristic: jump,spider-climb,water-walk,wind-walk,meld-into-stone,gaseous-form,
  tree-stride,transport-via-plants,teleportation-circle,arcane-gate,scatter,
  word-of-recall,forbiddance,hallow,mordenkainen-s-private-sanctum
```

### 6. Наблюдение, память, язык и обязательство существа — 32 (30 / 2)

Нужен bounded state для того, что видит/знает/помнит существо, язык,
обязательство и viewer-safe projection. Текст Рассказчика не может быть
доказательством приказа или забывания.

```text
blocked: friends,minor-illusion,silent-image,phantasmal-force,nathair-s-mischief,
  major-image,programmed-illusion,mislead,modify-memory,fast-friends,compulsion,
  confusion,geas,message,magic-mouth,comprehend-languages,zone-of-truth,
  detect-thoughts,speak-with-dead,sending,tongues,dream,commune,divination,
  legend-lore,rary-s-telepathic-bond,scrying,true-seeing,find-the-path,
  contact-other-plane
partial: suggestion,mass-suggestion
```

### 7. Выбор формы и жизненный цикл спутника — 35 (20 / 15)

Нужны bounded allowlist опубликованных форм, `SummonedCreatureCreated` с
выбранным profile, команды владельца, автономный ход, концентрация, footprint,
неповиновение, срок вне боя/при смене сцены и replay. Приближённый generic
summon не подтверждает полный статблок карточки.

```text
blocked: find-familiar,unseen-servant,find-steed,phantom-steed,
  flock-of-familiars,animate-dead,tiny-servant,giant-insect,arcane-eye,
  find-greater-steed,conjure-minor-elementals,conjure-elemental,conjure-fey,
  create-homunculus,create-undead,planar-ally,spirit-of-death,infernal-calling,
  danse-macabre,fizban-s-platinum-shield
partial: summon-beast,summon-undead,summon-shadowspawn,summon-fey,
  conjure-animals,summon-lesser-demons,summon-greater-demon,summon-aberration,
  summon-construct,summon-elemental,conjure-woodland-beings,animate-objects,
  summon-draconic-spirit,summon-celestial,summon-fiend
```

### 8. Момент смерти, тело и душа — 10 (9 / 1)

Нужны `DeathMarked` с мировым временем, атомарные body/soul transitions,
предел времени, согласие и возврат той же сущности. `ResolveHeroDeath` нельзя
обходить вторым resurrect-путём.

```text
blocked: revivify,soul-cage,magic-jar,alter-self,gaseous-form,meld-into-stone,
  tasha-s-otherworldly-guise,create-homunculus,reincarnate
partial: polymorph
```

### 9. Сложные компоненты и платежи — 13 + 3

Нужен versioned source-pack и проверка набора предметов до `ResourceSpent`:
альтернативы, количество, расходование, отдельные стоимости, фокусы и
отчисление A. Пока `componentRequirements` только описывает разрыв и не делает
все эти карточки принятыми. Список 13 unresolved приведён в начале документа;
отдельные A — `jims-magic-missile`, `gift-of-gab`, `jims-glowing-coin`.

## Приоритет следующих минимальных handlers

Порядок ниже максимизирует повторное использование, но не повышает статус всех
ID автоматически. Каждый handler обязан пройти command → rule → event → reducer
→ projection → UI и получить отдельный per-ID паспорт.

| Очередь | Минимальный серверный контракт | Семейство |
| ---: | --- | --- |
| 1 | `SpellAreaMoved` + `SpellEffectTriggered` | 20 ID; одновременно закрывает origin, новый центр, повторный action, entry/end-turn и dispel |
| 2 | `SpellEffectChargeSpent` | 10 ID; общий atomic trigger/uses/replay путь |
| 3 | `SceneObjectMagicChanged` | 16 ID; использует существующие doors/containers/props |
| 4 | `CastSpellStarted/Completed/Canceled` + material-set check | 57 long-cast ID и 13 сложных component sets; per-spell effect остаётся отдельным |
| 5 | `SummonProfileSelected` + summon expiry/commands | 35 ID; сначала `summon-beast`/один опубликованный профиль, затем формы |
| 6 | `Observation/Memory/Obligation` bounded state | 32 ID; сначала один проверяемый effect, например `suggestion`, затем массовые варианты |
| 7 | `HeightLayer/Fall/Transit` | 18 ID; после этого можно оценивать fly/levitate/feather-fall и телепорты честно |
| 8 | `DeathMarked/BodySoulTransition` | 10 ID; prerequisite для `revivify`/`soul-cage`/reincarnate |

Короткий `MoveSpellArea` не должен заодно реализовывать объектную цель,
вертикаль или выбор статблока. Это разные источники истины; смешивание их в
одном обработчике снова создаст видимость покрытия без устойчивого replay.

## Проверка среза

В этом состоянии выполнены read-only проверки:

```text
pnpm spells:acceptance                         PASS, schema problems: 0
pnpm spells:verify                             PASS, 257 overrides / 439 cards
node tools/audit-content-presentation.mjs      PASS, descriptions 439/439, images 439/439
node tools/audit-combat-presentation.mjs       PASS structure, spells 439, profiles 172, groups 42, audio 53
test/spell-descriptions.test.mjs               PASS
test/action-icon-manifest.test.mjs             PASS (6/6)
```

Предыдущий профильный запуск acceptance/icon/presentation дал 19/21 зелёных
тестов из-за старых ожиданий `partial: 242, heuristic: 189`. Контрактные
ожидания синхронизированы с текущим effective-каталогом: `partial: 248`,
`heuristic: 183`, `ruling-only: 8`, `blocked: 191`. Этот документ остаётся
read-only срезом; итоговый статус должен подтверждаться свежим `pnpm verify`.

Пока не выполнены per-ID source/specification, refusal-before-spending,
HTTP/UI, replay/restart/idempotency, permissions и ручная двухпользовательская
2D/3D/audio-приёмка, остаётся честный итог: каталог, описания, профили и иконки
полны, а рабочая механика — 248 partial, 191 blocked, 0 accepted.
