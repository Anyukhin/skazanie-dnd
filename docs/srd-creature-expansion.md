# Расширение бестиария SRD 5.2.1

В mini-compendium добавлены шесть server-owned stat blocks из официального
`System Reference Document 5.2.1`. Числа ниже сверены с печатными страницами
PDF, указанного в `SRD_5_2_1_SOURCE` в `server/encounter-assembler.mjs`.
Русские названия и ссылки DnD.su служат отображением и вторичной сверкой;
авторитетный источник механики — SRD 5.2.1.

| catalog id | отображаемое имя | страница SRD | CR | XP | семантические темы |
| --- | --- | ---: | ---: | ---: | --- |
| `srd_5_2_1:bandit` | Бандит | 261 | 1/8 | 25 | `raiders`, `ambush` |
| `srd_5_2_1:dire-wolf` | Лютый волк | 347 | 1 | 200 | `beasts`, `ambush`, `wilderness` |
| `srd_5_2_1:ghoul` | Упырь | 288 | 1 | 200 | `undead`, `crypt`, `cave` |
| `srd_5_2_1:gnoll-warrior` | Гнолл-воин | 289 | 1/2 | 100 | `raiders`, `warband`, `wilderness` |
| `srd_5_2_1:ogre` | Огр | 312 | 2 | 450 | `raiders`, `warband`, `cave` |
| `srd_5_2_1:owlbear` | Совомед | 313 | 3 | 700 | `beasts`, `cave`, `wilderness` |

У каждого существа есть отдельный оригинальный PNG 512×512 в
`public/assets/enemies/`. Изображения созданы встроенным ImageGen без
скачанных референсов. Хеши и размеры зарегистрированы командой:

```text
node tools/register-asset-rights.mjs enemies/bandit.png enemies/dire-wolf.png enemies/ghoul.png enemies/gnoll-warrior.png enemies/ogre.png enemies/owlbear.png
```

## Контракт и промпты ImageGen

Общая основа всех шести генераций:

```text
Use case: stylized-concept
Asset type: square tabletop battlemap enemy token portrait for a dark-fantasy game UI
Style/medium: premium hand-painted dark fantasy game illustration, grounded
materials, subtle ink-and-gouache texture, original design
Composition/framing: exactly one centered subject, strong readable silhouette,
all important features inside a circular-safe center crop, generous edge
padding, square composition, no border
Lighting/mood: restrained warm or cold rim light over deep shadows, high local
contrast that remains legible at 64px
Constraints: exactly one creature; no text, letters, numbers, logo, UI frame,
watermark, blood, gore or extra limbs; quiet dark background
Avoid: copyrighted character likeness, comedy, anime, chibi, bright cartoon
colors, branded iconography, busy scenery
```

К основе добавлялись следующие описания субъектов:

- `bandit.png`: худой дорожный разбойник в потёртом кожаном доспехе и капюшоне,
  с низко опущенным скимитаром и лёгким арбалетом за плечом; приземлённый
  смертный налётчик, не герой.
- `dire-wolf.png`: огромный первобытный серо-чёрный волк с массивными плечами,
  густой шерстью, длинными клыками и естественной четвероногой анатомией;
  заметно крупнее обычного волка, не оборотень.
- `ghoul.png`: истощённый сверхъестественный могильный хищник с пепельной
  кожей, бледными глазами и длинными когтями, полностью закрытый древним
  погребальным саваном; без ран, разложения и жертв.
- `gnoll-warrior.png`: худощавый гиеноголовый воин с пятнистой шерстью,
  доспехом из шкуры и кости, костяным луком и крюковатым клинком.
- `ogre.png`: громадный широкоплечий огр в шкурах и обломках железа, с грубой
  деревянной палицей и тремя метательными копьями за спиной; не зелёный
  карикатурный персонаж.
- `owlbear.png`: мощное четвероногое чудовище с телом бурого медведя, широким
  оперённым совиным лицом, крючковатым клювом и янтарными глазами; не милый
  маскот и не обычная сова или медведь.

## Исполнимая граница

Официальные атаки сохранены в `action_profiles`, вторичный некротический урон
укуса упыря — в `on_hit`, а парализация его когтя и сбивание с ног лютым волком
исполняются существующим Rules Engine. Укус лютого волка сначала требует
спасбросок Силы Сл 13. Для сбивания после провала указан
`until-next-turn`: это существующая проекция подъёма из `prone`, а не постоянное
состояние, которое лишало бы цель возможности снова устойчиво атаковать.
Multiattack упыря и совомеда сохранён
как метаданные stat block, но текущий NPC scheduler всё ещё делает одну атаку
за действие; это ограничение отражено в `docs/known-limitations.md`.

Сторож `test/srd-creature-expansion.test.mjs` фиксирует точные значения
stat blocks, уникальность и размер изображений, а также достижимость каждого
нового существа через семантическую тему, а не только через `generic`.
