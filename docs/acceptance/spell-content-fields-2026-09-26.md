# Полнота полей каталога заклинаний — 26 сентября 2026

Подготовленные в этом отчёте данные и изменения генератора уже интегрированы
в рабочее дерево. Упоминания Temp-патчей ниже сохраняют историю подготовки;
повторно применять их не нужно. Итоговые проверки записываются в
[общий журнал партии](spell-finish-2026-09-26.md).

Последующая смысловая проверка обнаружила ошибочные формулы в первоначальных
82 текстах повышения: наличие поля само по себе не подтверждало его точность.
Ниже сохранена история первого прохода. В текущем словаре уже 439 подробных
собственных пересказов, 164 проверенных текста повышения и 275 явных `null`.
Подклассы проверены заново для 439 страниц; полный список классов источника
отдельно сохраняет изобретателя и пометки TCE. Читательский текст не копируется
в серверное состояние. Текущие данные защищает `test/spell-reader-contract.test.mjs`.

Этот срез проверяет корпус из **439 заклинаний кругов 0–6** и его путь до
карточки сайта. Закреплённый источник — русские карточки D&D 2014 на
[dnd.su](https://5e14.dnd.su/spells/); полные тексты страниц в репозиторий не
копируются. В каталоге хранятся структурированные факты и самостоятельные
русские пересказы из `data/spell-descriptions-ru.json`.

Проверка реальных карточек подтвердила общий контракт полей: у [Брызг
кислоты](https://www.dnd.su/spells/13-acid-splash/) видны круг и школа, время,
дистанция, компоненты, длительность, классы и описание; у [Огненного
шара](https://5e14.dnd.su/spells/205-fireball/) дополнительно видны источник
PH14 и материальный компонент; [Поиск фамильяра](https://www.dnd.su/spells/248-find-familiar/)
показывает ритуальную пометку; [Силовая стена](https://www.dnd.su/spells/314-wall-of-force/)
показывает концентрацию в длительности. Эти наблюдения используются для
контракта полей, а не для переноса текста страницы.

## Результаты локальной проверки

`node tools/verify-dndsu-spell-catalog.mjs` проверяет 439 из 439 записей:

- 439 уникальных стабильных ID, уровни 0–6 и ресурсы ячеек без пропусков;
- 439 из 439 имеют имя, английское имя, школу, классы, ритуал, концентрацию,
  время, дистанцию, длительность, источник, вид, цель, время действия и
  описание;
- 439 из 439 имеют структурированные V/S/M-компоненты, включая явное `null`
  для отсутствующего материала и отдельные специальные требования;
- 439 из 439 совпадают с единым словарём русских пересказов;
- URL всех 439 записей — HTTPS-карточки `/spells/` на разрешённом домене
  dnd.su.

`ok: true` означает, что структурная схема и обязательные поля не нарушены.
`semanticComplete: false` отражает raw-каталог: 16 сложных геометрий всё ещё
не выражены в самой карточке. `effectiveSemanticComplete` после merge
overrides также остаётся false только для `guardian-of-faith`.

## Сверка важных фактов описания

Source cache содержит отдельные поля длительности и времени реакции. Для всех
439 наблюдённых записей они уже представлены в каталоге; пропусков
`duration` и reaction trigger не найдено. Это проверяется по metadata, поэтому
текст парафраза не обязан повторять ту же строку второй раз.

До enrichment в 163 source descriptions был отдельный блок повышения ячейки,
и у 82 ID его смысл не был виден ни в самостоятельном описании, ни в
структурном upcast-поле. Ниже сохранён исторический ID-список этого прохода;
текущие 82 поля уже добавлены в каталог:

```text
dissonant-whispers, animal-friendship, distort-value, hunter-s-mark,
guiding-bolt, absorb-elements, bane, hex, create-or-destroy-water,
vortex-warp, air-bubble, dragon-s-breath, healing-spirit, animal-messenger,
summon-beast, flaming-sphere, flock-of-familiars, shadow-blade,
enhance-ability, ashardalon-s-stride, fast-friends, antagonize, galder-s-tower,
thunder-step, catnap, spirit-guardians, counterspell, tiny-servant,
magic-circle, melf-s-minute-meteors, lightning-arrow, motivational-speech,
major-image, spirit-shroud, fly, summon-undead, summon-shadowspawn,
summon-fey, conjure-animals, summon-lesser-demons, bestow-curse, flame-arrows,
dispel-magic, galder-s-speedy-courier, phantasmal-killer, spirit-of-death,
banishment, mordenkainen-s-private-sanctum, wall-of-fire, dominate-beast,
summon-greater-demon, summon-aberration, summon-construct, summon-elemental,
conjure-woodland-beings, conjure-minor-elementals, elemental-bane, confusion,
storm-sphere, modify-memory, infernal-calling, mass-cure-wounds, insect-plague,
enervation, geas, cloudkill, animate-objects, planar-binding, danse-macabre,
dominate-person, summon-draconic-spirit, summon-celestial, conjure-elemental,
creation, wall-of-light, bones-of-the-earth, wall-of-ice, mass-suggestion,
heal, summon-fiend, conjure-fey, wall-of-thorns
```

Для всех 82 записей подготовлены короткие собственные формулировки повышения:
9 неоднозначных вариантов вычитаны вручную, остальные 73 используют bounded
шаблон числового эффекта. Исходная review-копия также сохранена вне репозитория:
`C:/Users/anton/AppData/Local/Temp/skazanie-spell-content-fields-2026-09-26/`.
Там лежат `spell-enrichment.json` (439 source facts) и
`dndsu-spells-0-6.enrichment.apply.patch` для отдельного review владельцем. Patch
использует точные `sourceFetchedAt` и `sourceHashFnv1a64` из cache, а не новые
даты или вычисленные значения. Файл не является применённым runtime override и
не заменяет source description.

Чтобы следующий запуск генератора не потерял собственные higher-level
парафразы, подготовлен отдельный
`spell-descriptions-ru.higher-levels.patch`: он добавляет карту `higherLevels`
в существующий редакционный словарь, не создавая второго источника описаний.
При проверке временной enriched-копии source semantic audit даёт 0 пропусков
higher-level, 0 расхождений metadata и 0 отсутствующих per-card provenance.

## Source cache

`tools/audit-dndsu-spell-sources.mjs` остаётся cache-only проверкой: сеть при
повторном запуске не вызывается. Для сохранённого временного кэша аудита от
19 сентября 2026 года результат такой:

| Проверка | Результат |
| --- | ---: |
| Уникальные наблюдённые ID | 439 / 439 |
| `observed` | 439 |
| `partial` | 0 |
| `unavailable` | 0 |
| Расхождения level/school/castingTime/rangeText/duration | 0 |
| Пропуски обязательных source facts | 0 |
| Пропуски optional `sourceBooks` в retry facts | 62 |

Запуск с локальным каталогом:

```text
node tools/audit-dndsu-spell-sources.mjs --cache-dir <TEMP audit directory> --catalog data/dndsu-spells-0-6.json
```

Для обязательного падения на semantic gaps добавляется
`--strict-semantic` (raw catalog) или `--strict-effective-semantic` (после
слияния overrides); обычный режим сохраняет полный отчёт и кодирует
структурную проверку отдельно от нерешённых редакционных пробелов.

Кэш хранит дату наблюдения и короткий хеш ответа. После enrichment у всех 439
рабочих карточек есть собственные `sourceFetchedAt/sourceHashFnv1a64`; это
происхождение именно сохранённого ответа cache и не доказательство того, что
текущая страница никогда не менялась.

## ID с отсутствующей структурной геометрией

Первичный raw-аудит находил 23 записи с таким пробелом. После source-backed
enrichment у следующих 16 raw-карточек `kind` всё ещё начинается с `area-`, но
нет полного набора `areaShape` + `radius`. Их краткий пересказ сохраняет область текстом;
для стен, двухфазных эффектов и областей вокруг созданного объекта требуется
отдельный source-backed профиль. Это не закрывается добавлением общего
визуального эффекта.

```text
thunderclap, word-of-radiance, hail-of-thorns, earth-tremor,
arms-of-hadar, flaming-sphere, heat-metal, melf-s-minute-meteors,
lightning-arrow, wind-wall, mordenkainen-s-faithful-hound, wall-of-fire,
guardian-of-faith, destructive-wave, holy-weapon, wall-of-thorns
```

Наиболее простые случаи можно закрыть расширением source-парсера для форм
`15-футовый конус` и аналогичных расстояний. `wind-wall`, `wall-of-fire`,
`wall-of-thorns`, `holy-weapon`, `mordenkainen-s-faithful-hound` и
`guardian-of-faith` нельзя безопасно свести к одному радиусу без отдельной
геометрической схемы и правил триггера.

Временный enrichment patch добавляет только явно напечатанные в source facts
формы и размеры: `frost-fingers` (cone 15), `burning-hands` (cone 15),
`dragon-s-breath` (cone 15), `aganazzar-s-scorcher` (line 30),
`rime-s-binding-ice` (cone 30), `conjure-barrage` (cone 60) и `cone-of-cold`
(cone 60). Для остальных 16 ID поле намеренно не угадывается по общему
«в пределах N футов».

После merge с текущим `data/dndsu-spell-mechanics-overrides.json` effective
каталог оставляет один нерешённый случай — `guardian-of-faith`. `heat-metal`
переходит в одноцелевой `damage`, а `thunderclap`, `word-of-radiance`,
`earth-tremor`, `arms-of-hadar`, `flaming-sphere`, `melf-s-minute-meteors`,
`wind-wall`, `wall-of-fire`, `destructive-wave` и `wall-of-thorns` получают
геометрию из существующих source-backed overrides. Raw gap и effective gap
поэтому должны выводиться раздельно.

## Optional source books в временном кэше

Это 62 ID, у которых canonical retry содержит source facts без массива
`sourceBooks`; обязательные метаданные при этом наблюдены и сверены:

```text
protection-from-evil-and-good, distort-value, vortex-warp, arcane-lock,
protection-from-poison, ray-of-enfeeblement, prayer-of-healing,
nathair-s-mischief, gift-of-gab, find-traps, jims-glowing-coin,
rime-s-binding-ice, rope-trick, wither-and-bloom, warp-sense, antagonize,
galder-s-tower, leomund-s-tiny-hut, sleet-storm, motivational-speech,
water-breathing, summon-fey, conjure-animals, conjure-barrage,
summon-lesser-demons, bestow-curse, incite-greed, galder-s-speedy-courier,
control-water, phantasmal-killer, spirit-of-death, dimension-door,
dominate-beast, summon-greater-demon, conjure-woodland-beings,
control-winds, maelstrom, modify-memory, wall-of-stone, commune-with-nature,
negative-energy-flood, transmute-rock, holy-weapon, synaptic-static,
creating-spelljamming-helm, drawmij-s-instant-summons, programmed-illusion,
bones-of-the-earth, mental-prison, investiture-of-wind, investiture-of-stone,
investiture-of-ice, investiture-of-flame, primordial-ward,
fizban-s-platinum-shield, summon-fiend, scatter, druid-grove,
create-homunculus, guards-and-wards, tenser-s-transformation, wind-walk
```

Следующий bounded шаг — сохранить source-book tokens и per-card revision при
пересборке кэша. Он не должен добавлять полный текст страницы и не должен
подменять редакцию D&D 2014 данными 2024.

Временная enrichment-копия и apply patch используют поле `sourceBooks` с
человекочитаемыми названиями книг, извлечёнными из заголовка наблюдённой
карточки, для всех 439 ID. Это безопасная метаинформация;
коды `sourceBooks` из retry facts остаются только там, где они действительно
наблюдены. Отдельного поля `subclasses` в сохранённом source cache нет ни у
одной из 439 карточек, поэтому подклассы не додумываются и не подставляются из
runtime-каталога классов.

## Что эта приёмка не утверждает

Наличие всех полей не означает, что все 439 заклинаний полностью исполняются
сервером. Статусы механики остаются отдельной матрицей в
`server/spell-acceptance-audit.mjs`: у карточки может быть `partial`,
`heuristic` или `ruling-only`. Изменения `data/dndsu-spell-mechanics-overrides.json`,
`data/content-provenance.json` и `server/combat-spells.mjs` в этом срезе не
выполнялись.
