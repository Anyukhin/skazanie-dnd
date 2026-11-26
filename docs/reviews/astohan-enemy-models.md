# Враги и фигурки «Асстоханских равнин»

В теме встреч собрано 50 статблоков. Именных существ мира — 2. Runtime выбирает профиль по публичному имени и creature_type, а explicit modelKey сохраняет приоритет.

## Семейства встреч

- **goblinoids** — goblin-minion, goblin-warrior, hobgoblin, kobold, bugbear
- **undead** — skeleton, zombie, ghoul, minotaur-skeleton, ogre-zombie
- **beasts** — wolf, dire-wolf, owlbear, giant-rat, giant-wolf-spider, giant-spider, giant-centipede, ankylosaurus, lion, brown-bear, giant-boar, tiger, giant-elk, hippopotamus
- **raiders** — bandit, gnoll-warrior, ogre, orc, goblin-warrior, hobgoblin, bugbear, scout, spy, berserker, bandit-captain, warrior-veteran, ettin, hill-giant, gladiator, tough-boss
- **warband** — gnoll-warrior, ogre, orc, bugbear, hobgoblin, berserker, sahuagin-warrior, bandit-captain, warrior-veteran, ettin, guard-captain, knight, hill-giant, barbed-devil, gladiator, tough-boss
- **law** — scout, spy, warrior-veteran, knight, guard-captain
- **vermin** — giant-rat, kobold, goblin-minion, giant-centipede, violet-fungus, ochre-jelly, giant-scorpion
- **ambush** — bandit, kobold, goblin-minion, giant-wolf-spider, wolf, dire-wolf, scout, spy, lion, tiger, bandit-captain, wyvern, manticore
- **crypt** — skeleton, zombie, ghoul, giant-rat, minotaur-skeleton, giant-centipede, ogre-zombie, animated-armor, ochre-jelly
- **cave** — kobold, giant-spider, giant-rat, bugbear, ghoul, ogre, owlbear, giant-centipede, violet-fungus, minotaur-skeleton, brown-bear, ettin, awakened-tree, ogre-zombie, earth-elemental, hill-giant, xorn, animated-armor, ochre-jelly, barbed-devil, giant-scorpion
- **wilderness** — wolf, dire-wolf, owlbear, gnoll-warrior, giant-spider, giant-wolf-spider, scout, ankylosaurus, lion, brown-bear, giant-boar, tiger, awakened-tree, giant-elk, hippopotamus, hill-giant, giant-scorpion, wyvern, manticore
- **cult** — bandit, spy, bandit-captain, tough-boss

## Называемые существа

- astohan-kaelan — Каэлан Вердант, undead, medium
- astohan-sargat — Саргат, dragon, large

## Визуальные маршруты

- обычный skeleton, goblin, rat, spider, wasp, frog, snake и dragon используют локальные GLB;
- owlbear, большие звери, орки, огры, рыцари, культисты и элементали получают публичный силуэтный акцент поверх общего профиля;
- monstrosity, wyvern, couatl и undead-специфичные варианты подключаются отдельными семействами с собственными тестами;
- неизвестный или замаскированный враг сохраняет нейтральную фигурку, чтобы модель не сообщала скрытую расу.
