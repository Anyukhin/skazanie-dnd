# Боевые звуки — источники и проверка

Пакет содержит 53 короткие записи в `public/assets/audio/combat`. Это
записи и лицензированные исходники, а не синтезированные осцилляторы. Все
выходные файлы — OGG Vorbis, 44,1 кГц, mono; громкость приведена FFmpeg к
целевому уровню `I=-18 LUFS, TP=-1.5 dBTP, LRA=7`. Обрезка применялась только
к длинным петлям и атмосферным записям, чтобы боевые фазы не держали буфер
несколько секунд.

## Источники

| sourceId | Источник | Лицензия | Использование |
| --- | --- | --- | --- |
| `oga-jc-fantasy-sfx-vol1-ccby4` | [JC Sounds — Fantasy SFX Pack Vol 1](https://opengameart.org/content/jc-sounds-fantasy-sfx-pack-vol-1), автор JC Sounds | CC BY 4.0 | Огонь, лёд, электричество, лечение, некротика, щит, телепортация, меч, лук |
| `kenney-sci-fi-sounds-cc0` | [Kenney Sci-fi Sounds](https://kenney.nl/assets/sci-fi-sounds) | CC0 | Кислота и силовое поле |
| `kenney-impact-sounds-cc0` | [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds) | CC0 | Удар, безоружный бой, металлическое попадание |
| `kenney-rpg-audio-cc0` | [Kenney RPG Audio](https://kenney.nl/assets/rpg-audio) | CC0 | Тканевый rustle для сети |
| `oga-various-sfx-cc0` | [Various Sound Effects](https://opengameart.org/content/various-sound-effects-0), автор Spring Spring | CC0 | Гром, взрыв, яд, вода, ветер, рой, копьё, бросок, камень для пращи, записанный выстрел и промах |
| `oga-earth-element-cc0` | [Earth Element Magic Spell](https://opengameart.org/content/earth-element-magic-spell), автор qubodup | CC0 | Земля |
| `oga-fantasy-magic-cc0` | [Fantasy Magic Spell](https://opengameart.org/content/fantasy-magic-spell), автор Almitory | CC0 | Психический импульс |
| `oga-magic-words-cc0` | [Magic Words + Healing Sound Effect](https://opengameart.org/content/magic-words-healing-sound-effect), автор Spring Spring | CC0 | Психический/арканный импульс |
| `oga-short-wind-cc0` | [Short wind sound](https://opengameart.org/content/short-wind-sound), автор remaxim | CC0 | Ветер и промах |

Для CC BY 4.0 требуется указать автора JC Sounds и ссылку на источник при
распространении. Источник Kenney прямо обозначает эти наборы как CC0. Файлы
OpenGameArt взяты только со страниц, где для конкретного материала указана
CC0; материалы с неоднозначной или несовместимой лицензией не включались.

## Runtime

[manifest.json](../public/assets/audio/combat/manifest.json) содержит
`version: 1`, 53 клипа с фактическими `durationMs`, URL и `sourceId`,
а также профили фаз `cast`, `launch`, `impact`, `miss`,
`critical`, `blocked`. Профили заклинаний покрывают sound families
`flame`, `frost`, `electric`, `thunder`, `acid`, `poison`,
`necrotic`, `radiant`, `force`, `psychic`, `healing`, `ward`,
`control`, `teleport`, `summon`, `earth`, `wind`, `water`,
`swarm`, `weapon`, а также fallback families. Атаки имеют профили
`slash`, `pierce`, `bludgeon`, `unarmed`, `bow`, `crossbow`,
`thrown`, `net`, `natural`, `dart`, `sling`, `firearm`, `wand`.
Для `silence` в manifest есть отдельный пустой профиль: это намеренная тишина
для заклинаний без звукового события, а не подмена тишины одиночным beep.

Один записанный клип может быть кандидатом для нескольких семейств, когда
материал совпадает (например, dissolving slime для кислоты и яда, chime для
radiant/healing). Это не один общий beep: фазы и материалы используют разные
исходники, а manifest сохраняет конкретную связь.

Пустой `cast` у `bludgeon`, `unarmed`, `crossbow`, `thrown`, `dart`, `sling` и
`firearm` намеренный: для этих атак стартовая фаза не создаёт ранний impact или
второй выстрел. Выстрел огнестрельного оружия звучит только в `launch`, а
попадание — в `impact`; промах использует короткий wind. `spell:environment`
имеет один детерминированный wind fallback, чтобы общий профиль не выбирал
случайный материал воды, земли или роя.
Такие пустые фазы явно перечислены в `silentPhases` и сопровождаются
`silenceReason`; профиль `spell:silence` намеренно молчит на всех трёх фазах.
Сеть использует только тканевый rustle на броске и падении, без металлического
удара или звукового акцента урона.

## Автоматическая проверка

Проверено 19 сентября 2026:

- 53/53 OGG проходят `ffprobe` decode probe;
- 53/53 имеют ненулевую длительность; диапазон — 167–5400 мс;
- суммарный размер — 803.7 KiB;
- `ffmpeg volumedetect` дал ненулевой `max_volume` для 53/53, диапазон
  пиков — примерно от -18.8 до 0 dB.

Человеческое прослушивание в этой проверке не заявляется; результат основан на
декодировании, длительности и сигнал-метриках FFmpeg.
