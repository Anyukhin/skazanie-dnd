# Портреты существ

Серверный реестр существ находится в `server/encounter-assembler.mjs`.
Каждая запись обязана указывать локальный квадратный PNG в
`public/assets/enemies/`. Интерфейс использует это поле и на карте, и в
инициативе; сетевой URL или отсутствующий файл здесь недопустимы.

## Визуальный контракт

- 512×512 PNG;
- один противник, читаемый в размере 64 пикселя;
- голова или всё тело помещаются в центральный круг;
- тёмное фэнтези, спокойный фон, высокий локальный контраст;
- без текста, рамки, логотипа и водяного знака;
- оригинальная иллюстрация, а не копия опубликованного арта.

Текущий набор создан встроенным ImageGen по отдельному промпту для каждого
уникального вида. Два серверных варианта гоблина осознанно используют один
портрет; остальные записи имеют самостоятельные изображения.

## Набор промптов

Общая основа всех восемнадцати генераций:

```text
Use case: stylized-concept
Asset type: square tabletop battlemap enemy token portrait for a dark-fantasy game UI
Style/medium: premium hand-painted dark fantasy game illustration, grounded
materials, subtle ink-and-gouache texture, original design
Composition/framing: centered subject, strong readable silhouette, all important
features inside a circular-safe center crop, generous edge padding, square
composition, no border
Lighting/mood: restrained warm or cold rim light over deep shadows, high local
contrast that remains legible at 64px
Constraints: exactly one creature; no text, letters, numbers, logo, UI frame,
watermark, blood, gore or extra limbs; quiet dark background
Avoid: copyrighted character likeness, comedy, anime, chibi, bright cartoon
colors, branded iconography, busy scenery
```

К этой основе добавлялось отдельное описание субъекта: гоблин-налётчик,
скелет-воин, мистический восставший без ран, серый волк, гигантская крыса,
приземистый паук-волк, тяжёлый паук-плетельщик, орк с секирой, хобгоблин в
строевом доспехе, кобольд с пращой, багбир с моргенштерном и каменно-бронзовый
Страж архива с изумрудным свечением.

Вторая волна, той же основой: бандит с абордажной саблей и лёгким арбалетом,
лютый волк крупнее и темнее серого, упырь с длинными когтями и провалившимися
глазами, гнолл-воин с костяным луком за спиной, огр с палицей и совомед с
перьями на медвежьем корпусе.

## Добавление существа

1. Добавить подтверждённый stat block в `SRD_5_2_1_MONSTER_ALLOWLIST`, не
   ослабляя ruleset и не меняя схему событий.
2. Сгенерировать оригинальный портрет по визуальному контракту, привести его к
   512×512 и сохранить как `public/assets/enemies/<id>.png`.
3. Указать этот путь в поле `image`.
4. Зарегистрировать права: `pnpm enemies:rights`.
5. Запустить `node --test test/enemy-image-assets.test.mjs` и
   `pnpm content:verify`.

Сторож намеренно проходит по всему серверному allowlist: новая запись без
локального портрета или с неверным размером сразу делает тест красным.
