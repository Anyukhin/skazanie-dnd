# Bounded audit атак: оружие, исход и презентация

Дата снимка: 2026-09-19
Статус: **ограниченный audit**. Проверена цепочка `catalog → Rules Engine →
AttackResolved → cue → 2D/3D/audio`. Это структурная и функциональная проверка
пакета атак; она не заменяет просмотр 49 живых кадров и прослушивание всех
профилей.

## Точный объём

Пакет галереи содержит 49 production strike entries:

- 40 `main_hand` keys: 39 canonical weapon recipes из
  `tools/equipment-weapon-models.mjs` и `wand`;
- 7 отдельных вариантов метания: `dagger`, `handaxe`, `javelin`,
  `light-hammer`, `spear`, `trident`, `dart`;
- `unarmed` и `natural`.

Канонические и production keys:

`battleaxe`, `blowgun`, `club`, `dagger`, `dart`, `flail`, `glaive`,
`greataxe`, `greatclub`, `greatsword`, `halberd`, `hand-crossbow`, `handaxe`,
`heavy-crossbow`, `javelin`, `lance`, `light-crossbow`, `light-hammer`,
`longbow`, `longsword`, `mace`, `maul`, `morningstar`, `musket`, `net`, `pike`,
`pistol`, `quarterstaff`, `rapier`, `scimitar`, `shortbow`, `shortsword`,
`sickle`, `sling`, `spear`, `trident`, `wand`, `war-pick`, `warhammer`, `whip`.

Полный union renderer — 13 стилей:

`slash`, `pierce`, `bludgeon`, `unarmed`, `natural`, `bow`, `crossbow`,
`sling`, `dart`, `firearm`, `wand`, `net`, `thrown`.

## Проверенная цепочка

1. `server/item-catalog.mjs` и `itemAttackProfile()` дают авторитетные mode,
   ability, куб урона, тип урона, normal/long range, reach и ammunition.
2. `server/rules-engine.mjs` принимает только серверный профиль, проверяет
   дальность, линию атаки, КД, critical, mirror-image block и расход стрел.
3. `AttackResolved` сохраняет `attack_kind`, `attack_visual` v2 с безопасным
   frozen loadout, `trajectory`, `critical`, `mirror_image_intercepted`,
   `damage_type` и исход попадания.
4. `combatAnimationCuesFromEvents()` строит единый strike cue. `attackOutcome()`
   читает только серверные `hit`, `critical` и `blocked`; `attackVisualStyle()`
   читает snapshot, а `attackVisualStyleForActor()` выбирает `natural` по
   публичному beast metadata.
5. 2D `TacticalBoard` использует launch `.2` для projectile и contact `.3` для
   melee; 3D `board3d-effects` использует ту же frozen trajectory, отдельные
   bolt/bullet/dart/stone/thrown projectile и style arc.
6. `combat-audio.ts` выбирает `attack:<style>` и фазы `cast/launch/impact`,
   `miss`, `critical`, `blocked`. Manifest содержит профиль для всех 13 стилей;
   пустые стартовые фазы объявлены как intentional silence.

Оружейная модель отвечает только за внешний вид. Наличие GLB не означает, что
Rules Engine умеет сделать такую атаку.

## Матрица стилей

| Стиль | Покрытие | Функциональный статус | Презентационный статус |
|---|---|---|---|
| `slash` | топоры, мечи, серпы, кнут | server profile и hit/miss/critical/blocked | 2D/3D arc, `attack:slash`; структурно проверено, кадры pending |
| `pierce` | кинжалы, копья, рапиры, пики, копья всадника | server profile и reach для reach-моделей | 2D/3D thrust, `attack:pierce`; структурно проверено, кадры pending |
| `bludgeon` | дубины, молоты, булавы, посохи | server profile | 2D/3D blunt profile, `attack:bludgeon`; структурно проверено, кадры pending |
| `unarmed` | безоружный удар | server attack path без item snapshot | 2D/3D unarmed hit и impact audio; структурно проверено, кадры pending |
| `natural` | укус/когти beast actor | server action profile; стиль выводится по публичному actor metadata | 2D/3D natural claws, `attack:natural`; структурно проверено, кадры pending |
| `bow` | shortbow/longbow | ammo map для стрел, расход на промахе и попадании | launch/contact, `attack:bow`; структурно проверено, кадры pending |
| `crossbow` | light/hand/heavy crossbow | ammo map для болтов | bolt projectile, `attack:crossbow`; структурно проверено, кадры pending |
| `sling` | sling | ammo map для sling bullets | stone projectile, `attack:sling`; структурно проверено, кадры pending |
| `dart` | dart/blowgun | dart — метание без ammo, blowgun — needles ammo | dart projectile, `attack:dart`; структурно проверено, кадры pending |
| `firearm` | pistol/musket | firearm bullets map, loading profile и range | bullet projectile, launch/impact, `attack:firearm`; структурно проверено, кадры pending |
| `wand` | wand model | visual key и ranged profile; механика конкретного wand зависит от item/spell path | ranged orb, `attack:wand`; структурно проверено, кадры pending |
| `net` | author model без catalog recipe | **P1 gap:** authoritative `MakeAttack` не имеет combat profile; нет damage/restrained rule | 2D/3D cloth contour и `attack:net` существуют только для preview/cue |
| `thrown` | 7 thrown variants и прочее `properties.thrown` | **P2 limitation:** hero thrown item не списывается и не имеет recovery event | projectile/spin, launch/contact, `attack:thrown`; структурно проверено, кадры pending |

## Подтверждённые gaps

### P1 — сеть есть в визуальном каталоге, но отсутствует в Rules Engine

`materializeCatalogItem('srd_5_2_1:net')` возвращает описательную вещь без
`combat` profile. `itemAttackProfile()` поэтому не строится, а
`resolveCommand(MakeAttack)` отклоняет попытку с `INVALID_WEAPON_PROFILE` до
броска. Для сети нет authoritative damage/condition ветки и нет события,
которое накладывает `restrained` или позволяет снять сеть по правилу.

Доказательство: одноразовая проверка каталога и `resolveCommand`; визуальные
проверки в `test/combat-effects-lab.test.mjs` и `test/board3d-effects.test.mjs`
подтверждают только preview/model/cue. Это главный функциональный разрыв в
49-entry пакете.

### P2 — расход брошенного оружия героя не зафиксирован

`heroAmmunitionExpenditure()` возвращает `null` для режима `thrown`, поэтому
`AmmunitionSpent` создаётся только для оружия с ammunition catalog. Брошенный
героем копьё, кинжал или топор остаётся в inventory с прежним quantity; отдельного
события потери, возврата или подбора нет. Это отличается от NPC-пути, где
неэкипированный пучок thrown weapon расходуется, а одно экипированное копьё
намеренно остаётся у существа.

Доказательство: `test/hero-ammunition.test.mjs` явно закрепляет отсутствие
`AmmunitionSpent` для брошенного копья; `server/npc-equipment.mjs` и
`test/npc-equipment.test.mjs` показывают отдельную политику для NPC. Это
объявленная граница текущей механики, но для полноценной боевой модели нужен
единый контракт `throw/consume/recover`.

## Что проверено без найденного функционального расхождения

- **Reach:** `glaive`, `halberd`, `lance`, `pike`, `whip` дают `melee` и 10
  футов из каталожного профиля; opportunity attack использует профиль оружия,
  а не базовые 5 футов. Доказательство — `itemAttackProfile()` и
  `test/weapon-armor-profiles.test.mjs`.
- **Thrown mode/snapshot:** `attack_kind: thrown`, `attack_mode`,
  `attack_ability`, `attack_visual` и trajectory фиксируются до replay;
  `test/weapon-armor-profiles.test.mjs` и `test/attack-visual-event.test.mjs`
  проходят.
- **Firearm:** pistol/musket имеют server profiles, range 30/40, long range
  90/120, firearm-bullets ammo map; 2D/3D выбирают bullet и audio launch/contact
  phases. Прямого отдельного runtime теста pistol/musket с пустым и последним
  pouch в текущем bounded наборе нет — это риск для следующего QA, а не
  подтверждённый баг.
- **Natural:** `actorAppearanceFor()` публикует profile `beast`, а
  `attackVisualStyleForActor()` выбирает `natural` и не рисует weapon arc.
  Доказательство — `test/board3d-effects.test.mjs` и
  `test/combat-audio.test.mjs`.
- **Miss/critical/blocked:** серверные markers доходят до 2D/3D и audio;
  critical удваивает damage expression, mirror-image даёт `blocked` без урона.
  Доказательство — `test/board3d-effects.test.mjs`,
  `test/attack-visual-event.test.mjs`, `test/combat-audio.test.mjs`.
- **Recorded SFX:** 13 attack profiles и 53 clips проходят manifest/audit
  проверку, но это проверка ссылок, фаз и длительности. Человеческое
  прослушивание и полный просмотр 49 live renders не заявляются.

## Выполненные проверки

Focused run: 67 тестов зелёные:

```text
node --test test/combat-effects-lab.test.mjs test/board3d-effects.test.mjs \
  test/hero-ammunition.test.mjs test/weapon-armor-profiles.test.mjs \
  test/attack-visual-event.test.mjs test/combat-audio.test.mjs \
  test/combat-presentation-coverage.test.mjs
```

Дополнительно зелёные 10 тестов моделей/контрактов:

```text
node --test test/equipment-weapon-models.test.mjs \
  test/build-equipment-models.test.mjs test/weapon-attack-ui-contract.test.mjs
```

`node tools/audit-combat-presentation.mjs` ранее прошёл со структурными counts
`spells=439`, `weapons=39`, `actorModels=13`, `audioClips=53`. Общий
`pnpm verify` для этого bounded audit не запускался.
