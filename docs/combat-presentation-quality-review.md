# Quality gate боевой презентации: заклинания и атаки

Дата снимка: 2026-09-19
Статус: **pending** — полный визуальный и аудиопроход не завершён до получения
реальных кадров из `effects_gallery` и записанных SFX. Этот документ фиксирует
матрицу покрытия и предварительные проверки; он не утверждает, что все 439
заклинаний просмотрены индивидуально.

## Объём и источник матрицы

- Заклинания: `data/dndsu-spells-0-6.json`, уровни 0–6, 439 записей.
- Механические подсказки: `data/dndsu-spell-mechanics-overrides.json`.
- Атаки: 29 записей каталога классов с `effect.kind = weapon_attack` в
  `data/dndsu-class-actions-1-12.json`, 39 canonical weapon recipes из
  `tools/equipment-weapon-models.mjs` (включая `net`, без `wand`), 40 runtime
  `main_hand` keys (39 recipes плюс `wand`) и 13 production attack styles:
  `slash`, `pierce`, `bludgeon`, `unarmed`, `natural`, `bow`, `crossbow`,
  `sling`, `dart`, `firearm`, `wand`, `net`, `thrown`.
- Предварительный read-only gate: `pnpm content:audit` зелёный — 439/439
  описаний и 439/439 изображений. Это проверяет контентный каталог, но не
  качество VFX, анимаций или SFX. В механике сейчас 240 `partial`, 191
  `heuristic` и 8 `ruling-only`; эти статусы не переносятся автоматически на
  presentation-status.
- Машиночитаемый `spellVisualAudit()` и его 439-ID тест проходят в
  `node --test test/spell-effects.test.mjs` (34/34). Он проверяет наличие
  `family`, `kind`, `soundFamily` и пояснения для каждой записи; это structural
  coverage, а не просмотр рендера или прослушивание клипа.
- В `public/assets/audio/combat/` есть 53 записанных клипа и `manifest.json`;
  `node tools/audit-combat-presentation.mjs` проходит для 439 spells, 39
  canonical weapon models, 40 attack models (включая `wand`), 13 actor models,
  48 audio profiles и 53 clips; runtime main-hand inventory содержит 40 keys.
  PASS этого инструмента подтверждает контракт,
  пути, фазы и наличие файлов, но не заменяет фактическое прослушивание.

`semantic reviewed` означает каталоговый cross-check. `rendered reviewed`
ставится только после просмотра реального render frame, а `audio reviewed` —
только после фактического прослушивания соответствующего записанного SFX.
`pending` означает отсутствие соответствующего доказательства. `findings`
означает зафиксированное расхождение или кандидат на расхождение, найденный в
read-only preflight; такой статус не означает, что весь пакет проверен.

## Критерии независимой проверки

1. **Смысловая семья.** Цвет, материал, форма и звук должны следовать факту
   эффекта: fire/cold/lightning/healing/control/illusion/flight/protection и
   другие семьи не сводятся к одной школе магии. `fly` не должен выглядеть как
   `shield`; иллюзия не должна выглядеть как лечение; silence не должен звучать
   как оглушающий взрыв.
2. **Геометрия.** Projectile, beam, burst, cone, line, cube, aura и point должны
   соответствовать каталогу и серверному событию. Предпросмотр не обещает
   persistent surface, summon, teleport или статус, если соответствующего
   события нет.
3. **Фазы и порядок.** Для действия проверяются prepare/wind-up, flight или
   movement, contact/impact, outcome и recovery. Урон, лечение, miss, save,
   status, смерть и воскрешение не появляются раньше подтверждённого контакта.
4. **Цель и область.** Сохраняются точная клеточная форма, союзник/враг,
   препятствия, дальность и видимость. Friendly-fire и недопустимая цель должны
   быть различимы в мире без отдельного меню прицеливания.
5. **Результат и состояние.** Dispel, counterspell, remove-curse, death-ward,
   death, revive и обычный damage имеют разные визуальные и звуковые исходы;
   краткий floating result не дублируется старым DOM callout.
6. **Recorded SFX.** Звук принадлежит фазе и семейству действия, начинается и
   заканчивается вместе с cue, не дублируется при 2D/3D и не остаётся после
   отмены prepare. Используются только записанные ассеты проекта; BG3-ассеты не
   скачиваются и не копируются.
7. **Паритет и деградация.** Один ID имеет сопоставимую семантику в 2D и 3D,
   при reduced motion остаётся читаемым статическим акцентом, а производительная
   деградация убирает детали, но не меняет смысл эффекта.

## Первичные ориентиры BG3

- [Making a Basic Spell](https://docs.baldursgate3.game/Making_a_Basic_Spell):
  `PrepareEffect`, `CastEffect`, `HitEffect`, раздельные `TargetRadius` и
  `AreaRadius`, наземный preview и подтверждение результата через combat log.
- [Making a Projectile Spell](https://docs.baldursgate3.game/Making_a_Projectile_Spell):
  prepare до выбора цели, траектория вокруг мебели и стен, ground target и
  проверка места появления.
- [A Little About Combat & Stealth](https://baldursgate3.game/news/a-little-about-combat-stealth_3):
  планирование пошагового хода и синхронизация движения с боевой анимацией.
- [Community Update 15](https://baldursgate3.game/news/community-update-15-absolute-frenzy_49):
  отдельная casting-анимация по классу, а не один универсальный жест.
- [Patch 3](https://baldursgate3.game/news/patch-3-mac-support-magic-mirror-more_93),
  [Patch 4](https://baldursgate3.game/news/patch-4-now-live_96) и
  [Final Patch](https://baldursgate3.game/news/the-final-patch-new-subclasses-photo-mode-and-cross-play_138):
  звук должен быть синхронен с animation/VFX; preparation SFX прекращается при
  снятии выбора; missing или duplicated SFX считаются дефектом.
- [Community Update 16](https://baldursgate3.game/news/community-update-16-of-valour-and-lore_55):
  sound occlusion и attenuation поддерживают приоритет действия в звуковой
  сцене.

Эти материалы задают наблюдаемые принципы, а не требование копировать BG3
ассеты, цвета, модели или звуки.

## Текущий semantic status

Профильный audit и каталоговый cross-check выполнены для всех 439 ID. В этом
слое `semantic reviewed` означает сопоставление `kind/target/areaShape`,
описания и effective override с профилем; это не означает просмотра кадра или
прослушивания SFX. После recheck текущего кода 437 ID не имеют unresolved
semantic finding; 2 ID остаются открытыми: `forbiddance` и
`mordenkainen-s-private-sanctum`. Это число относится только к семантическому
профилю; rendered и audio status остаются `pending`.

### Current unresolved semantic findings

| ID | Остаточная проблема | Рекомендация |
|---|---|---|
| `forbiddance` | Protection channel не несёт явной persistent area geometry при большой зоне запрета входа и урона. | Передать/рисовать persistent ward footprint только вместе с authoritative area event. |
| `mordenkainen-s-private-sanctum` | Family исправлена на protection, но channel остаётся точечным при описанной cube ward зоне. | Передать область ward или явно оставить point-only до механического события. |

### Closed after current-code recheck

`produce-flame`, `disintegrate`, `guardian-of-nature`, `creation`,
`conjure-barrage`, `conjure-volley`, `drawmij-s-instant-summons`,
`magic-circle`, `wither-and-bloom`, `vampiric-touch`, `phantasmal-force`,
`thunder-step`, `guardian-of-faith`, `conjure-elemental`, `magic-jar`,
`fizban-s-platinum-shield`, `planar-binding`, `see-invisibility`,
`shillelagh`, `dispel-magic`, `counterspell`, `investiture-of-ice`,
`investiture-of-flame`, `dispel-evil-and-good`, `net` получили соответствующие
kind/family/variant исправления. У `counterspell` вариант `cancellation` теперь
подавляет купол, похожий на щит; обе записи `investiture` больше не
классифицируются как burst; `phantasmal-force` идёт как иллюзионный channel для
одной цели; варианты dispel используют cancellation cue и нейтральную отмену
вместо обычного impact. Это закрывает semantic mapping; фазовый звук всё ещё
проверяется отдельно. Их rendered/audio status всё ещё `pending`.

### Historical preflight findings

Следующая таблица сохранена как audit trail первоначального preflight. Она не
является текущим списком unresolved; authoritative status выше. Строки
`investiture-of-ice`, `investiture-of-flame`, `counterspell`,
`dispel-magic`, `dispel-evil-and-good` и `phantasmal-force` закрыты текущим
профилем. Их старые рекомендации ниже сохранены только для истории проверки.

| ID | Существенное расхождение | Рекомендация для исправления профиля |
|---|---|---|
| `produce-flame` | Профиль `burst/sphere`, а описание — дальняя атака одним пламенем. | Projectile/attack cue, не AoE burst. |
| `disintegrate` | Профиль `burst/cube`, а описание — один тонкий луч по цели. | Single-target beam/projectile cue; убрать cube footprint. |
| `guardian-of-nature` | Профиль burst из каталожной sphere, а эффект — self transformation/buff. | Channel/aura/transmutation cue без выбора площади. |
| `creation` | Профиль burst/cube, а эффект создаёт один предмет. | Utility/channel cue вокруг точки создания. |
| `investiture-of-ice`, `investiture-of-flame` | Self effects читаются как burst/line area; описаны как длительная оболочка и близкая опасная зона. | Channel/aura с отдельным hazard cue, без ложного target burst. |
| `conjure-barrage`, `conjure-volley` | Regex `conjure` даёт summon family/audio, хотя это шквал оружия и area damage. | Weapon/projectile family и соответствующий launch/impact SFX. |
| `drawmij-s-instant-summons` | Regex `summon` даёт materialize/summon, хотя эффект помечает и возвращает предмет. | Utility/transmutation retrieval cue. |
| `magic-circle` | `kind=teleport` даёт teleport family, хотя это удерживающая защитная область. | Protection/control area cue, без порталов. |
| `mordenkainen-s-private-sanctum` | `kind=teleport` и cube дают teleport family/portal audio, хотя это защитный ward. | Protection/environment persistent area. |
| `counterspell` | Protection/ward dome вместо interrupt/cancel cue. | Control/dispel-style single-target interruption. |
| `dispel-magic` | Restoration family подключает healing-like visual/SFX, хотя действие рассеивает активную магию. | Neutral dispel/control family и cancellation sound. |
| `dispel-evil-and-good` | Restoration family смешивает защиту caster и dismiss/banish-результат. | Разделить protection и dismissal phases либо выбрать доминирующий результат явно. |
| `wither-and-bloom` | Catalog family healing, но effective override исполняет только necrotic area damage; healing часть явно не исполняется. | Necrotic burst с отдельным healing cue только при реальном событии. |
| `vampiric-touch` | Catalog healing field тянет healing family, хотя основной cue — necrotic attack с self-heal rider. | Necrotic projectile/melee cue и вторичный self-heal, не чистое лечение. |
| `phantasmal-force` | Profile burst/cube, а описание говорит о личной иллюзии одной цели. | Single-target illusion/channel; не показывать generic AoE footprint без подтверждённой области. |
| `thunder-step` | Burst профиль и teleport family не выражают одновременно departure teleport и thunder damage в исходной клетке. | Составной cue: departure/arrival portals плюс отдельный thunder impact. |
| `forbiddance` | Protection channel не имеет area geometry при описанной большой постоянной зоне с запретом входа и уроном. | Persistent ward area с явной геометрией и enter/turn-end semantics. |
| `guardian-of-faith` | Burst result не отражает поставленного стража, который ждёт входа врага в радиус. | Summon/ward persistence, затем proximity hit. |
| `conjure-elemental` | `areaShape=cube` заставляет profile быть burst, хотя создаётся один elemental в свободном месте. | Summon channel/materialize в одной точке. |
| `magic-jar` | Buff по умолчанию получает protection/ward, хотя это перенос души и possession. | Necromantic/soul-transfer cue; без shield dome. |
| `fizban-s-platinum-shield` | `kind=summon` и sphere дают summon burst, хотя описание — защитное поле вокруг цели с сопротивлениями. | Protection aura/channel, без materialize/summon cue. |
| `planar-binding` | Binding уже призванного существа получает summon family/audio. | Control/binding cue; не создавать нового summoned actor. |
| `see-invisibility` | `see-invisibility` попал в invisibility family, хотя эффект раскрывает невидимое и является divination. | Divination/focus cue, не растворение силуэта. |
| `shillelagh` | Buff попал в protection/ward, хотя меняет материал и damage profile оружия. | Weapon/transmutation cue с акцентом на зачарованный клинок/посох. |

Особые проверки, которые сейчас прошли semantic preflight без finding:

- `fly`, `levitate`, `feather-fall`, `wind-walk` имеют `flight` family;
- `silence` имеет `control` family, отдельный вариант без частиц и intentional
  silence в audio manifest;
- illusion IDs остаются `illusion`, а `death-ward`, `circle-of-death`,
  `soul-cage`, `revivify`, `raise-dead`, `reincarnate` разделены по protection,
  necrotic и restoration semantics.

Это semantic findings, а не утверждение, что соответствующие кадры уже
просмотрены.

## Bounded weapon-style review

Read-only сопоставление `WEAPON_MODELS`, `equipment-visuals`,
`CombatEffectsLab`, `attackVisualStyle`, `attackVisualStyleForActor` и audio
profiles прошло для 39 canonical recipes, 40 runtime main-hand keys (включая
`net` и `wand`), 7 `:thrown` variants и 13 production styles. `natural`
для beast actor, `unarmed`, `wand`, ranged bows/crossbows/sling/dart/firearm,
reach weapons и отдельные thrown variants (`dagger`, `handaxe`, `javelin`,
`light-hammer`, `spear`, `trident`, `dart`) семантически согласованы.

`net` теперь имеет thrown/capture profile и отдельный contour; это закрывает
прежний mapping finding. `lance` остаётся melee reach/pierce; `natural`
выбирается по beast metadata и не рисует weapon arc. Эти выводы основаны на
mapping и тестах, не на просмотре rendered weapon frames; rendered/audio status
остаётся pending.

## Fireball: исторические кадры не являются текущим evidence

Старые кадры `fireball2d-v2-*` и `fireball3d-final-*` в
`C:/Users/anton/AppData/Local/Temp/skazanie-full-effects-review/` показывают
уже исправленные промежуточные дефекты. Они не доказывают состояние текущего
рендера и не переводят `fireball` из `pending` в `rendered reviewed`.
Актуальный кадр для нового прохода нужно снять заново; аудио по-прежнему не
прослушивалось.

## Дополнительное rendered evidence: Chain Lightning

Источник: свежие browser frames
`C:/Users/anton/AppData/Local/Temp/skazanie-full-effects-review/chain3d-review-05.jpg`,
`chain3d-review-15.jpg` и `chain3d-review-27.jpg`; durable capture:
`C:/Users/anton/AppData/Local/Temp/skazanie-full-effects-review/chain-lightning-review.mp4`
и
`C:/Users/anton/.codex/visualizations/2026/09/17/01a0b0f9-c0fb-7af2-affb-bc287d85da34/chain-lightning-review.mp4`.

| ID | Semantic | Rendered | Audio |
|---|---|---|---|
| `chain-lightning` | reviewed: lightning beam, `chain=true` | reviewed: по свежим кадрам сегментированная цепь читается | pending listening |

В recapture `chain3d-review-05/15/27.jpg` путь стал заметно сегментированным и
зигзагообразным: источник, промежуточный узел и дальняя цель читаются на одном
кадре. Белый электрический core остаётся ярким на доске и больше не выглядит
одной ровной линией. Rendered finding закрыт; прослушивание audio остаётся
`pending`.

## Audio mapping status до прослушивания

Текущий manifest разводит `spell:environment` на записи семейства `wind`, а
`spell:earth` — на записи семейства `earth`; resolver берёт ключ из
`soundFamily` профиля.
Прежний preflight finding о том, что environment IDs получают earth clip,
закрыт на уровне mapping. Это только проверка resolver/manifest: ни один из 53
клипов ещё не считается прослушанным.

## Coverage matrix: spells 0–6

Все ID в строке имеют один общий пакет проверки и пока `pending`. После кадров
пакет можно дробить только там, где есть конкретный finding; нельзя ставить
`reviewed` всей строке по одному удачному представителю.

| Пакет | ID | Status | Evidence / finding |
|---|---|---|---|
| L0 · 44 | `acid-splash`, `control-flames`, `mage-hand`, `magic-stone`, `sword-burst`, `booming-blade`, `friends`, `shillelagh`, `blade-ward`, `vicious-mockery`, `druidcraft`, `green-flame-blade`, `lightning-lure`, `chill-touch`, `mold-earth`, `ray-of-frost`, `minor-illusion`, `true-strike`, `eldritch-blast`, `infestation`, `frostbite`, `fire-bolt`, `primal-savagery`, `dancing-lights`, `toll-the-dead`, `mending`, `thunderclap`, `mind-sliver`, `light`, `sacred-flame`, `word-of-radiance`, `message`, `resistance`, `create-bonfire`, `produce-flame`, `thorn-whip`, `guidance`, `spare-the-dying`, `prestidigitation`, `shape-water`, `thaumaturgy`, `gust`, `shocking-grasp`, `poison-spray` | pending | Gallery frame + recorded SFX pending |
| L1 · 77 | `hellish-rebuke`, `silent-image`, `bless`, `divine-favor`, `witch-bolt`, `thunderwave`, `magic-missile`, `jims-magic-missile`, `compelled-duel`, `cause-fear`, `heroism`, `wrathful-smite`, `hail-of-thorns`, `thunderous-smite`, `dissonant-whispers`, `armor-of-agathys`, `mage-armor`, `earth-tremor`, `animal-friendship`, `tasha-s-caustic-brew`, `tasha-s-hideous-laughter`, `protection-from-evil-and-good`, `beast-bond`, `distort-value`, `silvery-barbs`, `catapult`, `ice-knife`, `frost-fingers`, `healing-word`, `cure-wounds`, `ray-of-sickness`, `disguise-self`, `hunter-s-mark`, `inflict-wounds`, `guiding-bolt`, `illusory-script`, `unseen-servant`, `detect-poison-and-disease`, `detect-evil-and-good`, `detect-magic`, `burning-hands`, `faerie-fire`, `identify`, `entangle`, `ensnaring-strike`, `charm-person`, `purify-food-and-drink`, `feather-fall`, `searing-smite`, `absorb-elements`, `find-familiar`, `comprehend-languages`, `bane`, `expeditious-retreat`, `command`, `jump`, `false-life`, `speak-with-animals`, `arms-of-hadar`, `color-spray`, `hex`, `alarm`, `snare`, `grease`, `longstrider`, `chaos-bolt`, `create-or-destroy-water`, `tenser-s-floating-disk`, `fog-cloud`, `sanctuary`, `zephyr-strike`, `sleep`, `chromatic-orb`, `ceremony`, `goodberry`, `shield`, `shield-of-faith` | pending | Gallery frame + recorded SFX pending |
| L2 · 85 | `pass-without-trace`, `spiritual-weapon`, `continual-flame`, `see-invisibility`, `vortex-warp`, `suggestion`, `air-bubble`, `magic-mouth`, `arcane-lock`, `phantasmal-force`, `augury`, `blindness-deafness`, `flame-blade`, `shatter`, `barkskin`, `dragon-s-breath`, `beast-sense`, `cordon-of-arrows`, `borrowed-knowledge`, `protection-from-poison`, `warding-wind`, `maximilian-s-earthen-grasp`, `healing-spirit`, `branding-smite`, `crown-of-madness`, `levitate`, `moonbeam`, `ray-of-enfeeblement`, `magic-weapon`, `lesser-restoration`, `melf-s-acid-arrow`, `prayer-of-healing`, `nathair-s-mischief`, `skywrite`, `invisibility`, `gentle-repose`, `nystul-s-magic-aura`, `cloud-of-daggers`, `zone-of-truth`, `detect-thoughts`, `knock`, `mirror-image`, `warding-bond`, `scorching-ray`, `spider-climb`, `web`, `aganazzar-s-scorcher`, `pyrotechnics`, `gift-of-gab`, `aid`, `locate-animals-or-plants`, `find-traps`, `locate-object`, `find-steed`, `gust-of-wind`, `animal-messenger`, `summon-beast`, `mind-spike`, `tasha-s-mind-whip`, `flaming-sphere`, `dust-devil`, `spray-of-cards`, `blur`, `heat-metal`, `enthrall`, `jims-glowing-coin`, `rime-s-binding-ice`, `alter-self`, `snilloc-s-snowball-swarm`, `flock-of-familiars`, `darkvision`, `shadow-blade`, `silence`, `rope-trick`, `misty-step`, `darkness`, `enlarge-reduce`, `kinetic-jaunt`, `wither-and-bloom`, `hold-person`, `earthbind`, `enhance-ability`, `calm-emotions`, `warp-sense`, `spike-growth` | pending | High-risk presentation entries include `phantasmal-force`, `silence`, `levitate`, `illusion` and control; gallery pending |
| L3 · 73 | `aura-of-vitality`, `ashardalon-s-stride`, `fast-friends`, `wall-of-water`, `revivify`, `animate-dead`, `antagonize`, `gaseous-form`, `galder-s-tower`, `hypnotic-pattern`, `hunger-of-hadar`, `thunder-step`, `daylight`, `catnap`, `spirit-guardians`, `slow`, `protection-from-energy`, `stinking-cloud`, `erupting-earth`, `enemies-abound`, `counterspell`, `intellect-fortress`, `tiny-servant`, `leomund-s-tiny-hut`, `magic-circle`, `crusader-s-mantle`, `beacon-of-hope`, `melf-s-minute-meteors`, `blink`, `sleet-storm`, `mass-healing-word`, `lightning-arrow`, `lightning-bolt`, `motivational-speech`, `nondetection`, `major-image`, `fireball`, `blinding-smite`, `glyph-of-warding`, `life-transference`, `wall-of-sand`, `water-breathing`, `clairvoyance`, `spirit-shroud`, `fly`, `sending`, `phantom-steed`, `summon-undead`, `summon-shadowspawn`, `summon-fey`, `conjure-animals`, `conjure-barrage`, `call-lightning`, `summon-lesser-demons`, `vampiric-touch`, `tidal-wave`, `feign-death`, `bestow-curse`, `flame-arrows`, `speak-with-dead`, `speak-with-plants`, `dispel-magic`, `plant-growth`, `meld-into-stone`, `remove-curse`, `create-food-and-water`, `incite-greed`, `wind-wall`, `elemental-weapon`, `fear`, `haste`, `water-walk`, `tongues` | pending | High-risk presentation entries include `revivify`, cancellation variants, `major-image`, `life-transference`, `fly` and `remove-curse`; gallery pending |
| L4 · 52 | `aura-of-life`, `aura-of-purity`, `sickening-radiance`, `galder-s-speedy-courier`, `mordenkainen-s-faithful-hound`, `control-water`, `watery-sphere`, `phantasmal-killer`, `greater-invisibility`, `giant-insect`, `ice-storm`, `spirit-of-death`, `vitriolic-sphere`, `gate-seal`, `death-ward`, `banishment`, `fabricate`, `stone-shape`, `mordenkainen-s-private-sanctum`, `stoneskin`, `leomund-s-secret-chest`, `arcane-eye`, `hallucinatory-terrain`, `shadow-of-moil`, `staggering-smite`, `wall-of-fire`, `fire-shield`, `otiluke-s-resilient-sphere`, `charm-monster`, `dimension-door`, `dominate-beast`, `find-greater-steed`, `locate-creature`, `polymorph`, `divination`, `summon-greater-demon`, `summon-aberration`, `summon-construct`, `summon-elemental`, `conjure-woodland-beings`, `conjure-minor-elementals`, `compulsion`, `elemental-bane`, `raulothim-s-psychic-lance`, `freedom-of-movement`, `confusion`, `guardian-of-faith`, `guardian-of-nature`, `storm-sphere`, `blight`, `grasping-vine`, `evard-s-black-tentacles` | pending | High-risk semantics include `spirit-of-death`, `death-ward`, `hallucinatory-terrain`, `dimension-door`; gallery pending |
| L5 · 61 | `swift-quiver`, `dream`, `control-winds`, `maelstrom`, `greater-restoration`, `far-step`, `wrath-of-nature`, `bigby-s-hand`, `tree-stride`, `contagion`, `legend-lore`, `banishing-smite`, `modify-memory`, `infernal-calling`, `immolation`, `wall-of-stone`, `cone-of-cold`, `circle-of-power`, `teleportation-circle`, `rary-s-telepathic-bond`, `mass-cure-wounds`, `scrying`, `insect-plague`, `flame-strike`, `enervation`, `geas`, `cloudkill`, `commune`, `commune-with-nature`, `raise-dead`, `animate-objects`, `planar-binding`, `danse-macabre`, `dominate-person`, `negative-energy-flood`, `antilife-shell`, `transmute-rock`, `summon-draconic-spirit`, `summon-celestial`, `conjure-volley`, `conjure-elemental`, `seeming`, `awaken`, `destructive-wave`, `dawn`, `dispel-evil-and-good`, `reincarnate`, `contact-other-plane`, `hallow`, `holy-weapon`, `wall-of-force`, `synaptic-static`, `passwall`, `creation`, `creating-spelljamming-helm`, `wall-of-light`, `telekinesis`, `steel-wind-strike`, `hold-monster`, `skill-empowerment`, `mislead` | pending | High-risk presentation entries include `raise-dead`, `planar-binding`, `reincarnate`, `hallow`, `mislead`; cancellation rendering remains pending |
| L6 · 47 | `magic-jar`, `move-earth`, `drawmij-s-instant-summons`, `programmed-illusion`, `forbiddance`, `true-seeing`, `soul-cage`, `bones-of-the-earth`, `circle-of-death`, `wall-of-ice`, `arcane-gate`, `mental-prison`, `mass-suggestion`, `otto-s-irresistible-dance`, `investiture-of-wind`, `investiture-of-stone`, `investiture-of-ice`, `investiture-of-flame`, `flesh-to-stone`, `otiluke-s-freezing-sphere`, `primordial-ward`, `heroes-feast`, `planar-ally`, `fizban-s-platinum-shield`, `chain-lightning`, `find-the-path`, `heal`, `harm`, `tasha-s-otherworldly-guise`, `contingency`, `summon-fiend`, `conjure-fey`, `transport-via-plants`, `eyebite`, `scatter`, `disintegrate`, `druid-grove`, `word-of-recall`, `sunbeam`, `create-homunculus`, `create-undead`, `blade-barrier`, `guards-and-wards`, `globe-of-invulnerability`, `wall-of-thorns`, `tenser-s-transformation`, `wind-walk` | pending | High-risk presentation entries include `magic-jar`, `forbiddance`, `soul-cage`, `circle-of-death`, `planar-ally`, `heal`, `wind-walk`; `investiture` channel rendering remains pending |

## Coverage matrix: attack actions

These are catalog entries whose effect is a weapon attack. Their visual review
must still cover the underlying equipment/style variants (`slash`, `pierce`,
`bludgeon`, `unarmed`, `bow`, `crossbow`, `sling`, `dart`, `firearm`, `thrown`),
the server outcome (`hit/miss/critical/blocked`) and the correct timing of the
recorded SFX.

| Package | ID | Status | Evidence / finding |
|---|---|---|---|
| Class weapon-attack actions · 29 | `barbarian-yarost`, `barbarian-bezrassudnaya-ataka`, `barbarian-put-berserka-beshenstvo`, `barbarian-put-bushuyuschego-v-boyu-bronya-bushuyuschego-v-boyu`, `bard-kollegiya-mechey-roscherk-klinka`, `bard-kollegiya-shepotov-psihicheskie-klinki`, `cleric-blagoslovlennye-udary`, `cleric-domen-voyny-boevoy-svyaschennik`, `cleric-domen-poryadka-golos-avtoriteta`, `druid-krug-spor-simbioticheskaya-suschnost`, `druid-krug-spor-gribkovaya-infektsiya`, `fighter-varianty-priemov`, `fighter-misticheskiy-rytsar-boevaya-magiya`, `fighter-rytsar-purpurnogo-drakona-vdohnovlyayuschiy-vsplesk`, `fighter-kavalerist-nepokolebimaya-metka`, `fighter-samuray-boevoy-duh`, `monk-boevye-iskusstva`, `monk-ataka-nadelennaya-tsi`, `monk-put-chetyreh-stihiy-stihiynye-praktiki`, `monk-put-kenseya-put-kenseya`, `monk-put-kenseya-edinstvo-s-klinkom`, `monk-put-astralnogo-tela-ruki-astralnogo-tela`, `ranger-povelitel-zverey-sputnik-sledopyta`, `ranger-sumrachnyy-ohotnik-ugroza-iz-zasady`, `ranger-sumrachnyy-ohotnik-ohotnichya-yarost`, `rogue-klinok-dushi-psihicheskie-klinki`, `warlock-dar-mastera-tsepi`, `wizard-magiya-graviturgii-agressivnoe-prityazhenie`, `wizard-pesn-klinka-pesn-klinka` | pending | Gallery frame + recorded SFX pending |
| Canonical weapon models · 39 | `tools/equipment-weapon-models.mjs` | pending | Every model has an audit row; gallery frame + recorded SFX pending |
| Base physical attack styles · 13 | `slash`, `pierce`, `bludgeon`, `unarmed`, `natural`, `bow`, `crossbow`, `sling`, `dart`, `firearm`, `wand`, `net`, `thrown` | pending | Representative frame for every style and hit/miss outcome pending |

## Read-only preflight findings

These are concrete candidates from catalog + override inspection. They need a
real gallery frame before they become final findings.

| ID(s) | Preflight observation | Status |
|---|---|---|
| `fly`, `levitate`, `feather-fall`, `wind-walk` | The semantic profile resolves them to `flight`; no family mismatch found. | semantic reviewed; render/audio pending |
| `silence` | The override describes a persistent area that deafens and blocks verbal casting; the family resolves to `control`, with a quiet variant and intentional silent audio profile. | semantic reviewed; render/audio pending |
| `minor-illusion`, `silent-image`, `major-image`, `programmed-illusion`, `hallucinatory-terrain`, `disguise-self`, `illusory-script`, `mislead`, `seeming`, `mirror-image`, `blur`, `nystul-s-magic-aura` | Explicit illusion family exists for these IDs; no healing/protection family mismatch found. | semantic reviewed; render/audio pending |
| `dispel-magic`, `counterspell` | Current mapping is restoration/healing-like and protection/ward respectively; both require cancellation/dispersion cues instead of impact damage, explosion or shield dome. | findings; render/audio pending |
| `remove-curse`, `lesser-restoration`, `greater-restoration`, `purify-food-and-drink`, `gentle-repose`, `spare-the-dying`, `revivify`, `raise-dead`, `reincarnate` | Restoration/revival statuses need distinct resolve/death/revive presentation; a generic green heal cue is insufficient. | findings; gallery confirmation pending |
| `death-ward`, `soul-cage`, `spirit-of-death`, `circle-of-death` | These names share “death” but have different meanings: protection, soul capture, summon-like effect, and necrotic area damage. The current families are distinct; rendered status cues remain pending. | semantic reviewed; render/audio pending |
| `phantasmal-force` | Its catalog kind is `summon`, while its description is a personal psychic illusion; the profile family is corrected to illusion, but the cube/burst geometry remains a finding. | findings; render/audio pending |
| `hallow`, `forbiddance`, `planar-ally` | Catalog kinds/targets are broad (`teleport` or `utility`) while the described results are warding or summoning. Verify geometry and material from the actual event, not the fallback kind. | findings; gallery confirmation pending |

## Evidence ledger

| Evidence | State | What it can establish |
|---|---|---|
| `pnpm content:audit` on 2026-09-19 | reviewed | Catalog count, descriptions and image presence only |
| Official BG3 Toolkit/Larian references above | reviewed | Targeting/VFX/SFX principles, not this repository's render output |
| Старые fireball2d-v2/fireball3d-final кадры | исторические | Показывают промежуточный дефект и не доказывают текущий render |
| Свежие `chain3d-review-*.jpg` frames | reviewed for one targeted cue | Подтверждают только текущую 3D-цепь молний и её геометрию |
| `chain-lightning-review.mp4` сохранённая запись | доступна | Длительность и последовательность записи доступны для targeted review; полный просмотр матрицы не выполнен |
| `admin / effects_gallery` real render frames | pending | Per-ID 2D/3D visual, phase and geometry evidence |
| `audio_assets` + `combat_audio` recorded SFX package | pending | Per-ID phase, family, stop/loop and mix evidence |

The quality gate remains **pending** until the gallery and recorded SFX evidence
are available. No status in the package tables should be upgraded by inference
from a neighbouring spell or by a union-level test.
