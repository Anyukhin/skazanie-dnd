# Protection from Energy — кандидат исполнения, 2026-09-26

Статус: `partial`, временный patch-кандидат для интеграции root. Общий
рабочий каталог не менялся.

## Источник

- [dnd.su, «Защита от энергии»](https://5e14.dnd.su/spells/106-protection-from-energy/): 3-й круг, 1 действие, касание, V/S, концентрация до 1 часа; согласное существо получает сопротивление одному из acid/cold/fire/lightning/thunder.
- [D&D Beyond, Protection from Energy (Basic Rules 2014)](https://www.dndbeyond.com/spells/2220-protection-from-energy): та же формулировка willing creature и тот же набор типов.

## Изменение

Временный профиль `protection-from-energy` добавляет пять вариантов выбора и
связывает каждый с отдельным typed-resistance condition на 3600 секунд.
Сервер:

- учитывает сопротивление в общем `damagePayload`, поэтому оно применяется к
  временному HP после деления урона и не складывается с таким же сопротивлением
  в четверть урона;
- сохраняет независимый `effect_id` для каждого источника;
- использует существующую политику дружественной beneficial-цели и работает для
  себя через обычный HTTP путь;
- помечает новый срок `expiry_policy: protection-from-energy/v1`, поэтому
  секундное истечение очищает концентрацию только для этого нового контракта;
- передаёт `effect_id` для server-only `EndConcentration` и снимает концентрацию,
  когда секундное условие истекает ровно на границе срока. Текущий HTTP
  sanitizer эту команду игроку не публикует.

Отдельного хранимого примитива согласия союзника в текущем HTTP/UI пути не
найдено: действующая политика дружественных целей проверяет сторону цели, но не записывает
отдельный выбор владельца. Поэтому профиль остаётся `partial`; схема прав и API
намеренно не расширялась.

## Файлы и патчи

- fixed HEAD: `3eeb0db`;
- patch против fixed HEAD: `%TEMP%/skazanie-spells-finish/energy/protection-from-energy.fixed-3eeb.patch`, SHA-256 `7F7FCA0F9C603E75BF225CE64AF18C92DCBD19DCBCBEEA307260D71123D741C1`;
- patch против сохранённых current copied files: `%TEMP%/skazanie-spells-finish/energy/protection-from-energy.current-copied.patch`, SHA-256 `3452259AB0BE7D38B90B18782F0C9EC4E394087294797134F497DCA2D3E824AB`;
- Rules Engine test: `%TEMP%/skazanie-spells-finish/energy/current/test/protection-from-energy.test.mjs`, SHA-256 `F34584FB246A9FABEF253307FB8FB0185FFEC8E3F346C3322023E8534CCA831F`;
- HTTP test: `%TEMP%/skazanie-spells-finish/energy/current/test/protection-from-energy-http.test.mjs`, SHA-256 `67CF848DB2701F1F7151261594E3594413B408C34E2DB263D6A50472176CEBC5`.

Патчи меняют только `data/dndsu-spell-mechanics-overrides.json`,
`server/rules-engine.mjs` и добавляют два кандидатских теста. UI, TypeScript,
storage, зависимости и shared worktree не менялись.

## Проверки

- собственные тесты Rules Engine и EventStore: `11 passed, 0 failed`;
- обычный HTTP self-cast и повтор по тому же ключу: `1 passed, 0 failed`;
- профильные существующие тесты (`spell-override-audit`, `condition-effects`,
  `world-time-seconds`, `protective-spells`, `resistance-choice-integration`):
  `38 passed, 0 failed` (итого `50 passed, 0 failed`);
- `verify-spell-overrides`: `ok: true`, `checked: 253`, `problems: []`;
- `verify-spell-overrides --acceptance`: `ok: true`, `accepted: 0` — паспортный
  аудит остаётся очередью, а не доказательством полной приёмки;
- `node --check` для patched `rules-engine.mjs` и `combat-spells.mjs`: успешно;
- `git apply --check --ignore-space-change --ignore-whitespace` для обоих
  вариантов patch: успешно.

`pnpm verify` в общем репозитории оставлен root: рабочая копия dirty и содержит
параллельные изменения других задач.
