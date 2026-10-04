# План иконок и картинок: единый стиль и закрытие пробелов

**Статус:** план от 2026-10-04, исполнение не начато. Документ одновременно и бриф для
исполнителя: его можно отдать агенту целиком. Дополнения — в разделе 13 «Журнал плана».
**Приоритет:** P1 (группы A, D, F), P2 (B, C, E), P3 (G).
**Область:** генерация изображений, их регистрация в реестре прав, документы
происхождения и тесты на наличие. Подключение новых папок к интерфейсу — отдельный
этап 7, выполнять только если владелец разрешит его в этой же задаче.

Макеты интерфейса, ради которых часть иконок нужна: холст
https://claude.ai/artifact/F5kia5hzhWkKJPPy9tXmm3 (доски «Ход в бою», «Исследование»,
«Проверка: волшебник 12»). Значки, нарисованные там тонкими линиями, — заглушки.
Группа B заменяет их нормальными иконками.

Приложения:

- [`icon-plan-2026-10-actions.md`](icon-plan-2026-10-actions.md) — 157 строк «файл →
  предмет промпта» для группы A;
- `tools/action-icon-gaps.mjs` — считает действия без рисунка тем же `combatActionsFor`,
  что кормит интерфейс, и сверяет их с таблицей приложения:
  `node tools/action-icon-gaps.mjs --check`.

---

## 0. Что показал аудит (2026-10-04)

Цифры получены скриптами по файлам, а не на глаз.

| Группа | Есть | Состояние |
|---|---|---|
| Заклинания, `ui/action-icons` | 439 из 439 | рисованные, единый стиль — не трогать |
| Действия классов **без подкласса** | 93 | есть, не трогать |
| Действия **подклассов** на 12-м уровне | 0 из 155 | **нет иконок** — показывается клетка атласа по регулярке |
| Служебные действия (ход, движение, книга, смена оружия, взаимодействие, переговоры) | — | всегда клетка атласа `action-atlas-v1.webp` |
| Состояния (39 подписей) | 0 файлов | точка CSS, Unicode-знак или первая буква подписи |
| Предметы каталога `items/item-srd-5-2-1-*` | 145 из 145 | **38 из них — плоские векторные заглушки** (RGBA, рисует `tools/generate-component-item-images.mjs`) среди 107 рисованных |
| Стартовые вещи `items/starter-2014` | 20 | рисованные; 20 из 64 описаний в `data/starter-item-presentation.json` занимают картинки у заклинаний (барабан → thunderwave, лютня → bardic-inspiration, святой символ → bless, книги → identify) |
| Эмблемы классов | 12 из 12 | единый стиль — не трогать |
| Портреты рас `species/` | 10 | рисованные, тёмный фон; у каждой расы один пол |
| Роли NPC `npcs/roles/` | 8 | **светлый пергаментный фон** — выбивается из тёмной гаммы; владелец светлые фоны не принимает |
| Существа `enemies/` | 105 | рисованные, покрытие 100% |
| Призванные существа | 0 | фишка рисует значок `Sparkles` из lucide |
| `party-portraits.png`, `items/item-atlas.png`, `items/norvin-map.png` | — | в `ATTRIBUTION.md` происхождение **неизвестно, «DO NOT DISTRIBUTE»** — заменить своей генерацией |

Противоречия в документах о происхождении. Перегенерировать эти файлы не нужно, но в
отчёте их надо назвать:

- `ATTRIBUTION.md` называет портреты рас «UNKNOWN», а `docs/species-portrait-prompts.json` — генерацией ImageGen 2026-09-05;
- 11 портретов из `docs/assets-to-regenerate.md` (гоблин, орк, скелет…) там числятся удалёнными, а `docs/enemy-art-pipeline.md` называет их генерацией ImageGen. `ATTRIBUTION.md` при этом пишет, что они скачаны с dnd.su.

## 1. Правила (читать до первой генерации)

- Прочитать: `AGENTS.md` целиком, `docs/icon-prompts.md` целиком (контракт и стиль
  иконок действий — **главный эталон**), `docs/icon-generation-checkpoint.md`,
  `docs/enemy-art-pipeline.md`, `docs/npc-portrait-assets.md`,
  `docs/content-starter-art-2026-09-08.md`, `docs/class-icon-assets.md`, `ATTRIBUTION.md`.
- Перед началом: ветка от `main` (`art/icons-2026-10`), `git status` чистый; чужие
  правки в дереве — стоп и вопрос владельцу.
- **Без новых зависимостей.** Pillow для пост-обработки уже есть в системном Python;
  PNG в Node — `tools/png-codec.mjs`.
- **Генератор.** Встроенный ImageGen агента. Если его нет, можно
  `tools/generate-enemy-portrait.mjs` через RouterAI (`DND_IMAGE_MODEL`), но **только
  после согласия владельца на расход**. Ключ `ROUTERAI_API_KEY` не печатать и не
  класть в файлы.
- **Права.** Только оригинальная генерация: никаких скачанных картинок, иконок из
  игр (BG3, Pathfinder, WoW), стоковых наборов или «в стиле художника X». Каждый
  новый файл под `public/assets/**` регистрируется в `data/asset-rights.json`.
  Поля `rights_status` и `distribution` **не трогать**, они общие и решаются
  владельцем.
- Не трогать `storage/`, `.env`, данные кампаний. Исходники генерации (1024+ px)
  держать вне git: `tmp/art-1/<группа>/`.
- **Не класть новое в `public/assets/test/`.** Эта папка уже весит 147 МБ и
  отслеживается git. Контакт-листы для ревью — в `tmp/art-1/review/` (`tmp/` в
  `.gitignore`).
- Не коммитить и не пушить без разрешения владельца. По завершении перечислить
  изменённые и добавленные файлы.

## 2. Общий технический контракт

| Группа | Папка | Формат и размер | Фон | Масштаб предмета | Имя файла |
|---|---|---|---|---|---|
| A. Действия | `public/assets/ui/action-icons/` | PNG RGBA **256×256** (генерировать ≥512, уменьшать Lanczos) | **полностью прозрачный** | длинная сторона непрозрачного 82–88% холста | `<id>.png` из таблицы, буква в букву |
| B. Служебные | `public/assets/ui/hud-icons/` (новая) | как A | прозрачный | 82–88% | `<id>.png` из раздела 4 |
| C. Состояния | `public/assets/ui/conditions/` (новая) | PNG RGBA **256×256** | прозрачный | **70–78%** (живёт в 16–24 px) | `<id>.png` из раздела 5 |
| D. Предметы | `public/assets/items/` | PNG **RGB 512×512**, 20–600 КБ | тёмно-коричневая виньетка, как у 107 рисованных | предмет целиком с полями | прежнее имя файла |
| E. Роли NPC | `public/assets/npcs/roles/` | PNG RGB **320×320** | тёмный умбра, без пергамента | погрудно, лицо в центральном круге | прежнее имя файла |
| F. Замены по правам | прежние пути | прежние размеры (`party-portraits.png` 512×512 = 2×2 по 256; `item-atlas.png` 1254×1254 = 2×2; `norvin-map.png` 1536×1024) | см. раздел 8 | — | прежнее имя файла |
| G. Призыв, вторые портреты, магпредметы | раздел 9 | как `enemies/` / `species/` / `items/` | тёмный | как у соседей | раздел 9 |

Ограничения по весу: A, B, C — до 120 КБ на файл; E — до 400 КБ.

## 3. Блоки стиля (подставляются в каждый промпт)

**[СТИЛЬ-ИКОНКА]** — для групп A и B. Блок дословно из `docs/icon-prompts.md`, раздел
«Стиль», плюс правило цвета оттуда же («Цвет следует предмету и эффекту»). Не
сокращать. Подложку и рамку рисует CSS (`CombatIcon`, шесть фонов
`ui/action-backgrounds/`), поэтому собственной плашки у иконки быть не должно.

**[СТИЛЬ-СОСТОЯНИЕ]** — для группы C:

> Hand-painted dark-fantasy status symbol for a tabletop RPG interface, same
> rendering language as `action-atlas-v1.webp`: tangible painted materials, warm
> directional light, dark carved contours. Exactly ONE bold, very simple symbol
> with a compact silhouette that stays readable at 16 pixels; at most one tiny
> secondary detail. Fully transparent background; no plate, no circle badge, no
> frame, no border, no text, no letters, no numbers, no watermark. Not flat
> vector, not neon glyph, not emoji, not photoreal. The opaque subject's longest
> side spans 70–78 percent of the canvas, centered.

К нему добавляется строка семейства цвета:

- **контроль** — сталь, бронза, верёвка;
- **разум** — фиолетовый, пыльно-розовый;
- **чувства** — сланцево-синий, серебро;
- **тело и яд** — болезненно-зелёный, охра;
- **смерть** — кость, пепел;
- **мораль** — белая ткань, тусклое золото;
- **магия** — сине-фиолетовый кристалл.

**[СТИЛЬ-ПРЕДМЕТ]** — для групп D и F (как у 107 рисованных предметов и стартовых вещей):

> Square illustration of a single item for a dark-fantasy RPG inventory: original
> hand-painted realistic materials, the whole item visible with comfortable
> margins, soft warm top light, deep dark-brown vignette background matching the
> existing item set, subtle grounding shadow. One item only; no hands, no table
> clutter, no text, no labels, no frame, no watermark. Not flat vector, not
> cartoon, not photoreal product shot.

**[СТИЛЬ-ПОРТРЕТ]** — для групп E и G:

> Square chest-up portrait of one adult character for a dark-fantasy tabletop
> game, original hand-painted realistic fantasy art, natural anatomy, muted dark
> umber background with soft vignette — no parchment, no light or white
> background — warm golden rim light, face readable at 64 px inside a circular
> crop with generous top margin. One character only; no text, frame, logo or
> watermark; no likeness of real people or known game characters.

## 4. Группа A — 157 иконок действий (P1)

Полная таблица — [`icon-plan-2026-10-actions.md`](icon-plan-2026-10-actions.md). Промпт для каждой строки:
**«предмет промпта» + [СТИЛЬ-ИКОНКА]**. Состав:

- 155 действий подклассов на 12-м уровне (72 бонусных, 68 реакций, 12 действий,
  3 свободных);
- `breath-weapon`;
- два клиентских действия из `src/combat-actions.ts`: `fighter-indomitable` и
  `paladin-aura-of-protection`.

По классам: воин 33 (в том числе 19 приёмов Мастера боевых искусств), колдун 14,
варвар 13, жрец 13, монах 12, следопыт 12, друид 11, бард 10, плут 10, волшебник 10,
паладин 9, чародей 7, раса 1.

Список без рисунка — `node tools/action-icon-gaps.mjs --json`. Сверка таблицы с кодом —
`node tools/action-icon-gaps.mjs --check`: код 1, если в интерфейсе появилось действие без
рисунка и без строки в таблице. Уже нарисованные строки сводка показывает в
`alreadyDrawn`.

**Семейства, которые обязаны различаться силуэтом, а не цветом:**

- 7 «Божественных каналов» паладина — у каждой клятвы свой образ: лоза, оливковая
  ветвь, корона, печать мести, светлый клинок, лавровый венок;
- 19 приёмов — в каждом свой жест оружия;
- 3 части астрального тела монаха — лицо, руки, торс;
- две «Псионические силы» — у воина кулак в пузыре, у плута глаз между кинжалами.

**Тест.** Сейчас `test/action-icon-manifest.test.mjs` перебирает классы **без
подкласса**. Новый PNG подкласса он сочтёт «рисунком без действия» и упадёт. Поэтому:

1. В тесте перебирать каждый подкласс из `data/dndsu-class-actions-1-12.json` и
   добавить два клиентских идентификатора — готовый перебор есть в
   `actionsWithoutIcon()` из `tools/action-icon-gaps.mjs`. Клиентские брать разбором
   `src/combat-actions.ts`, а не жёстким списком.
2. Обратная проверка «у каждого доступного действия есть PNG» после этого станет
   требовать все 157. Включать её последним коммитом группы, когда все файлы на месте.
3. `pnpm icons:manifest` пересобирает `src/action-icons.ts`.

## 5. Группа B — 26 служебных иконок (P2)

Сейчас эти места рисуются клеткой атласа или тонкой линией на макетах. Промпт:
**предмет + [СТИЛЬ-ИКОНКА]**.

| Файл | Где | Предмет промпта |
|---|---|---|
| `end-turn.png` | кнопка «Завершить ход» | An antique brass hourglass whose sand has completely run out into the lower bulb. |
| `movement.png` | движение | A pair of worn leather boots mid-stride above a short dotted path. |
| `spellbook.png` | книга заклинаний | A thick closed leather-bound spellbook with a glowing arcane clasp. |
| `swap-weapons.png` | смена набора оружия | A sword and a light crossbow crossed, two curved swap arrows circling them. |
| `base-attack.png` | атака оружием без своей картинки | A single plain sword striking diagonally with one short impact spark. |
| `interact.png` | предмет сцены (`scene-object-*`) | A gloved hand pulling a heavy iron lever. |
| `parley.png` | переговоры (`propose-parley`) | A white parley flag tied to a short spear shaft. |
| `unarmed-strike.png` | безоружный удар | A bare clenched fist with cloth-wrapped knuckles punching forward. |
| `throw.png` | бросить предмет или существо | A hand hurling a small stone along a curved arc. |
| `lockpick.png` | вскрыть замок | A slim steel lockpick inserted into an iron padlock. |
| `leave-scene.png` | уйти из сцены | A half-open heavy wooden door with warm light spilling through the gap. |
| `look-around.png` | осмотреться | An extended brass spyglass, its lens glinting. |
| `talk.png` | поговорить | A small parchment speech scroll with a quill resting across it. |
| `short-rest.png` | короткий отдых | A small campfire with a dented kettle hanging over it. |
| `long-rest.png` | долгий отдых | A rolled bedroll beneath a thin crescent moon and three stars. |
| `group-vote.png` | решение группы | Three hands dropping wooden tokens into one clay bowl. |
| `letters.png` | письма (курьер) | A folded letter sealed with red wax. |
| `turn-based.png` | пошаговый режим вне боя | An hourglass standing on a single checkered floor tile. |
| `sneak.png` | красться | A soft leather boot on tiptoe casting a long shadow. |
| `common-actions.png` | контейнер «Общие действия» | A worn leather satchel with a few tool handles poking out of it. |
| `nonlethal.png` | «Не убивать» | A sword blade wrapped in padded cloth bindings. |
| `opportunity-attack.png` | атака по убегающему | A sword striking at a retreating boot from behind. |
| `hasted-action.png` | ускоренное действие | A short sword leaving three green speed afterimages. |
| `custom-action.png` | «Своё действие» | A quill writing on a parchment strip, one golden spark at its tip. |
| `free-roll.png` | свободный бросок | A single ivory twenty-sided die, faces blank, no numbers. |
| `sculpt-spells.png` | «Построение заклинаний» | A small glowing protective bubble sheltering a tiny figure inside a burst of flame. |

Тест: новый `test/hud-icon-assets.test.mjs` по образцу `action-icon-manifest`
проверяет, что все 26 файлов на месте, это PNG 256×256 с прозрачными углами,
содержимое уникально, а хеш зарегистрирован.

## 6. Группа C — состояния (P2)

**Новые — 23 файла.** Промпт: **предмет + [СТИЛЬ-СОСТОЯНИЕ] + семейство цвета**.

| Файл | Подпись | Семейство | Предмет промпта |
|---|---|---|---|
| `dead.png` | Погиб | смерть | A pale bone skull seen from the front. |
| `unconscious.png` | Без сознания | смерть | A closed drooping eyelid under a small halo of dim stars. |
| `incapacitated.png` | Недееспособен | контроль | A limp open hand with a loose cloth binding around the wrist. |
| `stunned.png` | Ошеломлён | контроль | A dented helmet with three small golden stars circling above it. |
| `paralyzed.png` | Парализован | контроль | A rigid frozen hand gripped by crackling pale-violet bands. |
| `petrified.png` | Окаменел | контроль | A grey stone hand cracking at the fingertips. |
| `restrained.png` | Опутан | контроль | Coiled ropes pulled into one tight knot. |
| `grappled.png` | Схвачен | контроль | An armoured hand gripping a wrist. |
| `prone.png` | Сбит с ног | контроль | A toppled boot lying flat with a small dust puff. |
| `poisoned.png` | Отравлен | тело и яд | One sickly green drop falling above a cracked cup. |
| `blinded.png` | Ослеплён | чувства | An eye covered by a dark cloth blindfold. |
| `deafened.png` | Оглох | чувства | An ear with a broken, interrupted sound wave beside it. |
| `frightened.png` | Испуган | разум | A pale wide-eyed mask with one dark drip from an eye. |
| `charmed.png` | Очарован | разум | A glowing pink heart bound by a thin golden leash. |
| `invisible.png` | Невидим | чувства | A hooded figure drawn only as a faint shimmering outline. |
| `exhaustion.png` | Истощение | тело и яд | A candle burnt down to a drooping stub. |
| `concentration.png` | Концентрация | магия | An unblinking eye inside two concentric arcane rings. |
| `fled.png` | Бежал | мораль | A running boot leaving dust behind a dropped sword. |
| `surrendered.png` | Сдался | мораль | A white cloth tied to a broken spear shaft. |
| `weapon-coated.png` | Клинок смазан | тело и яд | A dagger blade dripping dark oily poison. |
| `rime-encased.png` | Скован льдом | магия | A hand encased in a block of pale blue ice. |
| `vitriolic-acid-covered.png` | Едкая кислота | тело и яд | A smoking green acid splash on a steel plate. |
| `minor-blessing.png` | Малое благословение | мораль | A small golden votive candle with a single halo ring. |

**Не генерировать — повторно использовать иконку действия** (запись в таблице
соответствий при подключении):

| Состояние | Иконка из `action-icons` |
|---|---|
| `disengaged` | `disengage` |
| `dodging` | `dodge` |
| `helped` | `help` |
| `readied` | `ready` |
| `raging` | `rage` |
| `reckless` | `reckless-attack` |
| `bardic-inspiration` | `bardic-inspiration` |
| `beacon-of-hope` | `beacon-of-hope` |
| `death-ward` | `death-ward` |
| `aura-of-life` | `aura-of-life` |
| `aura-of-protection` | `paladin-aura-of-protection` (из группы A) |
| `light` | `light` |
| `bless`, `bless-d4` | `bless` |
| `resistance-d4` | `resistance` |
| `chill-touch-undead` | `chill-touch` |
| `longstrider` | `longstrider` |
| `bane` | `bane` |
| `metamagic-quickened` | `quickened-spell` |
| `favored-foe` | `favored-foe` |
| `hunters-mark` | `hunters-mark` |

Тест: `test/condition-icon-assets.test.mjs` — те же проверки, что для группы B, на
256×256.

## 7. Группа D — 38 предметов вместо плоских заглушек (P1)

Пути прежние (`items/item-srd-5-2-1-<id>.png`), формат RGB 512×512. Промпт:
**предмет + [СТИЛЬ-ПРЕДМЕТ]**. Описания компонентов сверены со справочником SRD.

| `<id>` | Предмет промпта |
|---|---|
| `arcane-focus-crystal` | A single faceted quartz crystal arcane focus, a hexagonal prism with a faint blue inner glow and a bronze cap. |
| `arcane-focus-orb` | A polished glass orb arcane focus on a small bronze claw stand, pale mist swirling inside. |
| `arcane-focus-rod` | A short ornate metal rod with engraved silver bands and a gem-capped end. |
| `arcane-focus-staff` | A tall dark wooden staff with a wrapped grip and a crystal set into its carved head, shown diagonally. |
| `arcane-focus-wand` | A slender carved wand of dark wood with silver inlay and a tiny crystal tip. |
| `component-pouch` | A small leather belt pouch with many little compartments, a sprig of herbs and a feather peeking out. |
| `diamond-50gp` | A single small cut diamond resting on a scrap of black velvet. |
| `druidic-focus-mistletoe` | A sprig of mistletoe with white berries tied with twine. |
| `druidic-focus-totem` | A small carved wooden totem hung with feathers and bone beads. |
| `druidic-focus-wooden-staff` | A gnarled living wooden staff with fresh green leaves sprouting at its top, shown diagonally. |
| `druidic-focus-yew-wand` | A short yew wand with natural bark and a carved leaf pattern. |
| `holy-symbol-amulet` | A bronze sun-disc amulet on a leather cord. |
| `holy-symbol-emblem` | A holy sun emblem embossed on a small steel shield-shaped plaque with straps. |
| `holy-symbol-reliquary` | A small ornate gilded reliquary box with a glass window and a relic inside. |
| `material-circle-of-death-500gp` | Crushed black pearl powder heaped in a small open silver dish. |
| `material-dawn-100gp` | A gold sunburst pendant on a fine chain. |
| `material-diamond-dust-100gp` | A tiny stoppered glass vial filled with sparkling diamond dust. |
| `material-shadow-of-moil-150gp` | A milky undead eyeball encased inside a clear cut gem. |
| `material-summon-aberration-400gp` | A pickled tentacle and an eyeball inside a platinum-inlaid glass vial. |
| `material-summon-beast-200gp` | A gilded acorn split open, holding a feather, a tuft of fur and a fish tail. |
| `material-summon-celestial-500gp` | A small golden reliquary with radiant engraved wings. |
| `material-summon-construct-400gp` | An ornate stone and metal lockbox with riveted bands. |
| `material-summon-draconic-spirit-500gp` | A gem-set medallion engraved with a coiled dragon. |
| `material-summon-elemental-400gp` | A gold-inlaid glass vial holding a pebble, a pinch of ash, water and a wisp of air. |
| `material-summon-fey-300gp` | A single gilded flower with metal petals. |
| `material-summon-fiend-600gp` | A small ruby vial filled with dark red blood. |
| `material-summon-shadowspawn-300gp` | A clear crystal vial holding a few tears. |
| `material-summon-undead-300gp` | A small gilded human skull. |
| `drum` | A medieval wooden frame drum with a leather head, lacing and two drumsticks. |
| `lute` | A pear-shaped wooden lute with a bent-back pegbox and gut strings. |
| `lyre` | A small wooden lyre with curved arms and taut strings. |
| `horn` | A curved brass hunting horn on a leather strap. |
| `bagpipes`, `flute`, `viol`, `pan-flute`, `dulcimer`, `shawm` | **Не генерировать заново.** Взять рисунки из `items/starter-2014/<то же имя>.png`, свести RGBA на фон набора предметов, сохранить RGB 512×512 по пути SRD. `test/item-images.test.mjs` запрещает одинаковые байты у разных предметов каталога, но стартовые файлы в каталог не входят — проверить прогоном. Если тест всё же против, сгенерировать по промптам из `docs/content-starter-art-2026-09-08.md` в другом ракурсе. |

После группы D:

- **Перенаправить** в `data/starter-item-presentation.json` 20 описаний, которые
  сейчас занимают картинки у заклинаний (барабан, лютня, святые символы, книги и
  другие), на рисунки предметов. Ключ записи искать по имени, не текстовой заменой
  по образцу: записи в этом файле похожи друг на друга.
- `tools/generate-component-item-images.mjs` больше не запускать: он перезапишет
  рисунки заглушками. Удалить скрипт и его упоминания — только с согласия владельца;
  пока достаточно записать в отчёте, что он устарел.
- Выполнить `pnpm items:manifest` и `pnpm items:rights`.

## 8. Группа E и F

### E. Роли NPC — перерисовать 8 портретов на тёмном фоне (P2)

Пути и размер прежние (`npcs/roles/<role>.png`, 320×320). Композицию и характер
сохранить, сменить только фон и свет. Промпт: **образ + [СТИЛЬ-ПОРТРЕТ]**.

| Роль | Образ |
|---|---|
| `merchant` | A shrewd middle-aged merchant in a fur-trimmed travelling coat with a leather ledger at the chest. |
| `guard` | A weathered town guard in a padded gambeson and open steel helmet, a spear shaft at the shoulder. |
| `noble` | A composed noble in a dark velvet doublet with a silver chain of office. |
| `scholar` | An older scholar with ink-stained fingers holding a closed book, spectacles on a cord. |
| `priest` | A calm priest in plain linen vestments with a simple sun pendant. |
| `artisan` | A sturdy artisan in a leather apron with rolled sleeves and a tool roll. |
| `traveler` | A road-worn traveller in a hooded green cloak with a walking staff. |
| `commoner` | A friendly villager in a simple wool tunic and apron, sleeves rolled. |

Пол и возраст сохранить как у текущих файлов, чтобы у знакомых NPC не сменилось лицо.

Заодно, не картинкой, а строкой в отчёте: регулярки `npcPortraitRole()` в
`server/npc-portraits.mjs` не узнают «жрица Круга» и «представитель купеческого
дома». Из-за этого 11 из 12 NPC без своего портрета получают `commoner`. Это
отдельная задача, здесь не править.

### F. Замены файлов с неизвестным происхождением (P1)

- **`party-portraits.png`** — лист 512×512, четыре лица по 256 в сетке 2×2.
  `partyPresentationFor` выбирает лицо по `slot % 4`. Сгенерировать четыре портрета
  по [СТИЛЬ-ПОРТРЕТ] (разные расы и пол, например человек-воительница, эльф-следопыт,
  дворф-жрец, тифлинг-колдунья), уменьшить до 256 и собрать в лист в том же порядке
  четвертей. Код не трогать.
- **`items/item-atlas.png`** — 1254×1254, сетка 2×2, вырезка по
  `background-position` 0%/100% (`src/data.ts:40–49`, `src/styles.css:566`). В
  четвертях:
  1. левая верхняя — латунный компас с зелёной стрелкой («Компас тихих вод»);
  2. правая верхняя — малое зелье лечения: алая жидкость с золотыми искрами;
  3. левая нижняя — серебряный амулет-глаз («Амулет дозорного»);
  4. правая нижняя — потрёпанный журнал в кожаном переплёте.

  Каждую четверть — по [СТИЛЬ-ПРЕДМЕТ], собрать без швов. Разносить атлас на
  отдельные файлы с правкой `src/data.ts` — только с согласия владельца.
- **`items/norvin-map.png`** — 1536×1024: «Карта затопленного архива». Промпт:

  > Top-down oiled parchment sheet with a hand-inked plan of a flooded
  > underground archive: corridors, stacks and stairs; a few lines glowing faint
  > green near small rune marks; a dotted red route of the old archivist. Edges
  > darkened and water-stained, laid on a dark wood surface. No legible text, no
  > letters, no numbers, no compass labels.

  Пергамент здесь — содержимое предмета, а не фон интерфейса, поэтому светлый
  тон допустим.
- После замены в `ATTRIBUTION.md` переписать строки этих трёх файлов: что
  сгенерировано, когда и где промпты.

## 9. Группа G — по желанию (P3)

- **Призванные существа**: 9 портретов (`enemies/summon-<slug>.png`, 512×512 RGB, по
  контракту `docs/enemy-art-pipeline.md`):
  - `beast-spirit` — Дух зверя;
  - `lesser-demon` — Малый демон;
  - `maw-demon` — Пастный демон;
  - `dretch` — Дретч;
  - `greater-demon` — Высший демон;
  - `animated-object` — Оживший предмет;
  - `woodland-being` — Лесной дух;
  - `faithful-hound` — Верный страж;
  - `spiritual-weapon` — Духовное оружие.

  Имена — из `summon` в `data/dndsu-spell-mechanics-overrides.json`. Шаблон пути
  проекции пропускает только `/assets/enemies/<slug>.png`, поэтому подпапок не
  делать. Подключение (поле `image` у определения призыва) — отдельная задача.
- **Второй пол для портретов рас**: 10 файлов `species/<id>-alt.png` (256×256) по
  промптам `docs/species-portrait-prompts.json` с противоположным полом. Нужны,
  если портрет героя будет браться по расе, а не по месту за столом.
- **32 магических предмета** из `data/compendia/dnd_5e_2014/magic-items.json`:
  промпты составить по описаниям в том же формате, что раздел 7, файлы по образцу
  `items/item-srd-5-2-1-<id>.png`, если они попадут в каталог.

## 10. Порядок работ

1. **Подготовка.** Ветка, чтение документов. `node tools/action-icon-gaps.mjs --check`
   зелёный: 157 действий без рисунка, 157 строк в таблице.
2. **Пилот — 12 файлов, затем стоп и ревью владельца:**
   - группа A: `paladin-klyatva-mesti-bozhestvennyy-kanal`, `parry`,
     `monk-put-astralnogo-tela-ruki-astralnogo-tela`,
     `wizard-magiya-hronurgii-hrono-sdvig`;
   - группа B: `end-turn`, `movement`, `unarmed-strike`;
   - группа C: `stunned`, `poisoned`, `concentration`;
   - группа D: `arcane-focus-orb`, `lute`.

   Показать контакт-листы из раздела 11. Дальше идти только после «да».
3. Группа A пачками по классам. После каждой пачки — QA и контакт-лист.
4. Группы D и F.
5. Группы B и C.
6. Группа E.
7. **Подключение B и C — только по разрешению владельца в этой задаче:**
   - `CombatIcon` в `src/CombatIcon.tsx` берёт служебные иконки из `hud-icons`
     вместо клеток атласа для `end-turn`, движения, книги, `swap-*`,
     `scene-object-*` и `propose-parley`;
   - знаки состояний в `src/tactical-ui.ts` (`TOKEN_CONDITION_GLYPHS`, фишки) и
     чипы полосы хода берут `conditions/<id>.png` или иконку по таблице
     соответствий;
   - запасной путь — нынешний знак.

   Это изменение UI, и для него действует критерий §8 `AGENTS.md`: `pnpm build`,
   реальный HTTP-путь и ручная проверка двумя игроками.
8. Группа G — если останется время и владелец не против.

## 11. Критерии приёмки

Скриптом приёмки сделать `tmp/icon-all/finalize_icons.py` (лежит вне git). Его
пороги рассчитаны на холст 512: длинная сторона 420–451 px. Для групп B и C
скопировать его в `tmp/art-1/` и поменять список идентификаторов и пороги.

**Технические — для каждого файла, проверяются скриптом:**

1. Формат, размер и режим — ровно по таблице раздела 2. Имя совпадает с
   идентификатором буква в букву.
2. A, B, C: углы холста полностью прозрачны. Непрозрачная область не касается края.
   Её длинная сторона — 82–88% холста (A, B) или 70–78% (C), поля противоположных
   сторон отличаются не больше чем на 6%.
3. Содержимое уникально: SHA-256 не совпадает ни с одним файлом той же папки, а у
   предметов — ни с одним другим предметом каталога.
4. Вес в пределах раздела 2.
5. Каждый файл есть в `data/asset-rights.json` с верными хешем и размером;
   `pnpm content:verify` зелёный, без `ASSET_REGISTRY_DRIFT`.
6. Счётчик ассетов в `test/content-integrity.test.mjs` равен фактическому.

**Визуальные — по контакт-листам, проверяет владелец:**

7. Реальный размер:
   - A и B — 32 и 27 px на тайле `#2a221a` и на каждом из шести фонов
     `action-backgrounds`;
   - C — 16 и 20 px на тёмном круге;
   - D — 64 px;
   - E — 64 px в круглой маске.

   Предмет узнаётся по силуэту без подписи.
8. Тот же лист в оттенках серого: семейства из раздела 4 различимы формой.
9. Рядом с каждым новым файлом — 6 соседей той же группы из уже принятых: тот же
   язык рисования (рисованные материалы, тёплый свет, тёмный контур). Нет плоского
   вектора, неона, фотореализма, глянцевого 3D.
10. Нет текста, букв, цифр и псевдонадписей. На кости `free-roll` цифр тоже нет.
11. Анатомия: у видимых рук пять пальцев; нет лишних конечностей, глаз, клинков и
    рукоятей; нет слипшейся геометрии и обрывков.
12. Нет узнаваемых чужих персонажей, гербов и логотипов — в том числе амперсанда
    D&D и иконок BG3.

**Процесс:**

13. Пилот одобрен владельцем до массовой генерации.
14. Происхождение по каждой группе записано в новом документе:
    - `docs/icon-prompts-subclasses-2026-10.md` — A;
    - `docs/hud-and-condition-icons-2026-10.md` — B и C;
    - `docs/item-art-2026-10.md` — D и F;
    - дополнение в `docs/npc-portrait-assets.md` — E.

    В каждом: общий блок стиля, промпт каждого файла, инструмент или модель, дата.
15. Тесты:
    - `test/action-icon-manifest.test.mjs` перебирает подклассы;
    - добавлены тесты для `hud-icons` и `conditions`;
    - `pnpm verify` зелёный.

    Три теста `tactical-map-budget` иногда падают по времени и на чистом `main`. Это
    не регресс, но в отчёте об этом сказать.
16. Нет новых зависимостей. Не тронуты `storage/`, `.env`, `rights_status` и
    `distribution`. В `public/assets/test/` ничего не добавлено.

## 12. Отчёт

- Таблица: группа → сколько сделано, сколько осталось, почему.
- Пути контакт-листов в `tmp/art-1/review/`.
- Файлы, которые пришлось перегенерировать после QA, и причина.
- Противоречия в происхождении из раздела 0 — одной строкой на каждое, без правки
  чужих записей.
- Список изменённых и добавленных файлов.

## 13. Журнал плана

План дополняется здесь, новые записи сверху. Цифры аудита в разделе 0 обновляются
вместе с записью, а не задним числом.

- **2026-10-04 — первая версия.** Аудит скриптами по `public/assets`:
  - 155 действий подклассов и 2 клиентских действия без рисунка (сверка —
    `tools/action-icon-gaps.mjs`);
  - 38 плоских заглушек предметов;
  - 8 портретов ролей NPC на светлом фоне;
  - 0 иконок состояний;
  - три файла неизвестного происхождения.

  Служебные иконки (группа B) выведены из макетов стола на холсте UI/UX, в том числе
  с проверки на волшебнике 12-го уровня.
