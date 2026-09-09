# Портреты существ 2014 — 2026-09-07

Девять отсутствовавших портретов reference-каталога `dnd_5e_2014` созданы
встроенным ImageGen в режиме `stylized-concept`. Каждый исходник был квадратным
изображением высокого разрешения, затем уменьшен до 512×512 через
`System.Drawing` с `HighQualityBicubic`. Исходники оставлены в каталоге
генератора; в репозиторий помещены только production-файлы.

Общий блок, повторённый в каждом запросе:

```text
Use case: stylized-concept
Asset type: square tabletop battlemap enemy token portrait for a dark-fantasy game UI
Style/medium: premium hand-painted dark fantasy game illustration, grounded materials, subtle ink-and-gouache texture, matching the existing 512px enemy portrait set
Composition/framing: centered subject, strong readable silhouette, head or key features inside a circular-safe center crop, generous edge padding, square composition, no border
Constraints: exactly one creature; original design; no text, letters, numbers, logo, UI frame, watermark, blood, gore, extra limbs or duplicate weapons
Avoid: copyrighted character likeness, comedy, anime, chibi, bright cartoon colors, branded iconography, busy scenery
```

В каждом запросе также были свои строки `Scene/backdrop`, `Subject`,
`Lighting/mood`, `Color palette` и `Materials/textures`:

## Стражник

Файл: `public/assets/enemies/dnd-2014/guard.png`

```text
Primary request: an original fantasy portrait of a city guard from D&D 5e 2014, a disciplined human sentry carrying a spear and a round shield
Scene/backdrop: quiet stone city gate at dusk, understated background kept dark and uncluttered
Subject: exactly one medium humanoid guard, alert posture, practical chain shirt and shield, spear visible, no other figures
Lighting/mood: restrained warm rim light over deep shadows, high local contrast that remains legible at 64px
Color palette: muted iron, charcoal, weathered blue-gray, small warm torch accents
Materials/textures: worn chain links, scuffed wood and metal shield, believable cloth and stone
```

## Культист

Файл: `public/assets/enemies/dnd-2014/cultist.png`

```text
Primary request: an original fantasy portrait of a D&D 5e 2014 cultist, a secretive human devotee of forbidden powers carrying a worn curved scimitar
Scene/backdrop: a shadowy urban shrine or abandoned cellar, quiet and uncluttered
Subject: exactly one medium humanoid cultist, hooded but face visible, plain dark leather armor and a small occult pendant, scimitar clearly visible, no other figures
Lighting/mood: restrained cold moonlight with a faint warm candle rim, deep shadows, high local contrast at 64px
Color palette: charcoal, ash gray, muted burgundy, tarnished bronze accents
Materials/textures: worn leather, rough cloth hood, aged metal pendant, believable stone
```

## Фанатик культа

Файл: `public/assets/enemies/dnd-2014/cult-fanatic.png`

```text
Primary request: an original fantasy portrait of a D&D 5e 2014 cult fanatic, a fierce human spellcasting leader with a ritual staff and commanding expression
Scene/backdrop: a ruined underground chapel with a subtle dim altar glow, quiet background
Subject: exactly one medium humanoid cult fanatic, dark vestments, ritual staff with a small carved symbol, hands suggesting restrained divine magic, no other figures
Lighting/mood: dramatic but restrained violet and amber rim light over deep shadows, high local contrast at 64px
Color palette: black, muted violet, old gold, smoke gray
Materials/textures: embroidered but worn vestments, cracked wood staff, stone dust
```

## Прислужник

Файл: `public/assets/enemies/dnd-2014/acolyte.png`

```text
Primary request: an original fantasy portrait of a D&D 5e 2014 acolyte, a young human temple attendant in simple robes holding a mace and holy symbol
Scene/backdrop: a modest stone sanctuary with a few soft candle points, dark quiet background
Subject: exactly one medium humanoid acolyte, simple light-brown and cream robes, small mace held safely at the side, holy symbol visible, no other figures
Lighting/mood: gentle warm candle rim against cool deep shadows, high local contrast at 64px
Color palette: parchment cream, umber, slate blue, muted brass
Materials/textures: plain woven robe, worn wooden mace, oxidized holy symbol, rough stone
```

## Маг

Файл: `public/assets/enemies/dnd-2014/mage.png`

```text
Primary request: an original fantasy portrait of a D&D 5e 2014 mage, an experienced human arcane scholar in layered robes holding a carved spellbook and a faintly glowing wand
Scene/backdrop: a dark arcane study with indistinct shelves and one restrained magical glow, quiet background
Subject: exactly one medium humanoid mage, intelligent focused face, layered blue-gray robes, spellbook and wand visible, subtle magical sparks only around the wand, no other figures
Lighting/mood: controlled cool cyan arcane rim light over deep shadows, high local contrast at 64px
Color palette: midnight blue, charcoal, desaturated teal, small silver accents
Materials/textures: layered wool and leather, aged parchment, carved dark wood, restrained magical light
```

## Тролль

Файл: `public/assets/enemies/dnd-2014/troll.png`

```text
Primary request: an original fantasy portrait of a D&D 5e 2014 troll, a towering gaunt green-gray giant with long arms, jagged teeth, and a heavy club
Scene/backdrop: a damp cavern entrance with mist and dark stone, quiet uncluttered background
Subject: exactly one large humanoid troll, hunched but imposing, stringy dark hair, long claws, ragged hide scraps, heavy wooden club clearly visible, no other creatures
Lighting/mood: restrained sickly green rim light with cold cave shadows, high local contrast at 64px
Color palette: moss green, gray-green skin, black-brown hair, wet slate
Materials/textures: rough wet skin, tangled hair, torn hides, knotty wood club
```

## Мимик

Файл: `public/assets/enemies/dnd-2014/mimic.png`

```text
Primary request: an original fantasy portrait of a D&D 5e 2014 mimic, a single living treasure chest revealing a tooth-lined mouth and adhesive pseudopods
Scene/backdrop: a dim dungeon corridor with a few scattered coins kept subtle, quiet background
Subject: exactly one mimic as the only creature, wooden chest body partly transformed, lid open as a monstrous mouth, two short pseudopods gripping the floor, no adventurers and no second object competing with it
Lighting/mood: low warm glint on metal fittings against deep dungeon shadows, high local contrast at 64px
Color palette: dark walnut, moss green flesh, tarnished brass, charcoal stone
Materials/textures: scratched wood, damp organic flesh, old brass fittings, dusty stone
```

## Студенистый куб

Файл: `public/assets/enemies/dnd-2014/gelatinous-cube.png`

```text
Primary request: an original fantasy portrait of a D&D 5e 2014 gelatinous cube, a translucent amber-green cube of living dungeon slime with a few indistinct objects suspended inside
Scene/backdrop: a narrow dark stone dungeon corridor, quiet and uncluttered
Subject: exactly one large transparent cubic ooze, readable square silhouette with rounded wet edges, faint suspended bones and a broken sword inside but no other living creatures
Lighting/mood: eerie muted green internal glow with cool deep shadows, high local contrast at 64px
Color palette: translucent olive, amber highlights, slate gray, black
Materials/textures: wet glassy slime, soft refraction, indistinct corroded metal and bone
```

## Молодой красный дракон

Файл: `public/assets/enemies/dnd-2014/young-red-dragon.png`

```text
Primary request: an original fantasy portrait of a D&D 5e 2014 young red dragon, a single lean crimson dragon with small horns, folded wings, and a visible ember glow in the throat
Scene/backdrop: a volcanic mountain ledge with smoke kept soft and uncluttered, no other creatures
Subject: exactly one young red dragon, head and upper body dominant, crimson scales, short horns, folded leathery wings and a hint of tail, no rider and no hoard
Lighting/mood: restrained orange ember rim over deep volcanic shadows, high local contrast at 64px
Color palette: deep crimson, blackened red, basalt charcoal, ember orange
Materials/textures: detailed scales, leathery wing membrane, rough volcanic rock, subtle smoke
```

The 15 already existing matching portraits remain in their original paths. The
explicit mapping for all 24 records is in
`server/combat-lab-monsters.mjs`; rights hashes for the nine new files are
registered separately after review.
