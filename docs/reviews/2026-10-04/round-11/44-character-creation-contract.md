# Создание героя: authoritative contract, provenance и replay

Дата среза: 2026-10-04. Проверен checkout `HEAD 873c946d` относительно
закреплённого baseline `cb045a8466f35696ff24abe9020d6f39dee89462`. Scope —
создание героя и его выборы, развитие, derived sheet против импортированных
значений, provenance характеристик и стартового богатства, а также граница
между `character-lifecycle`, PHB-каталогами, развитием и wizard. Membership,
slot concurrency, runtime и merge не менялись.

## Результат

Существенного обхода authoritative-пути в проверенном срезе не найдено.
Владелец героя и запрет импорта во время боя проверяются до разбора документа
([`validateCharacterImportCommand`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/character-lifecycle.mjs#L955-L974)); importer принимает только
явно versioned ability policy, сверяет standard array/point-buy/rolled method,
bonus profile и итоговые scores, а для `rolled` требует сохранённый серверный
roll id и тот же набор scores
([`validateAbilityGeneration`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/character-lifecycle.mjs#L242-L330)).
Производные HP, AC, speed, proficiency и ресурсы строятся сервером из
канонического листа; `hp`, `maxHp`, `armor`, `speed`, `inventory`, currency и
resources не являются полями v1 import contract
([`DERIVED_CHARACTER_POLICY`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/character-lifecycle.mjs#L102-L109)).

Броски создаются отдельными `RollCharacterAbilities`/`RollCharacterWealth`
командами только для незаполненного героя D&D 2014, с проверкой владельца,
последовательного индекса и запретом второго wealth roll
([`validateCharacterAbilityRollCommand`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/character-lifecycle.mjs#L997-L1014)).
Покупки повторно проверяют class id, id/total подтверждённого wealth roll и
бюджет; подмена броска другого класса даёт `WEALTH_CLASS_MISMATCH`
([`resolveStartingPurchases`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/character-creation-wealth.mjs#L307-L401)).

`CharacterImported` хранит canonical patch и `phb_creation_result`, а reducer
заново прогоняет тот же parser перед сборкой листа
([`characterImportEvent`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/character-lifecycle.mjs#L1017-L1037),
[`applyCharacterLifecycleEvent`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/character-lifecycle.mjs#L1052-L1107)).
Это даёт полезную границу: импорт не принимает присланные derived числа, но
replay сохраняет исходный wealth result и выдачу покупок.

## Найденные расхождения и seam

### P2 / документальный drift: ограничение про variant human и custom background устарело

[`docs/known-limitations.md`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/docs/known-limitations.md#L2780-L2784)
утверждает, что вариантный человек и custom background «не предлагаются».
Текущий wizard явно рисует выбор variant-human feat и custom background
([`CharacterCreationWizard.tsx`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/src/CharacterCreationWizard.tsx#L491-L570),
[`CharacterCreationWizard.tsx`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/src/CharacterCreationWizard.tsx#L1188-L1218));
server importer разрешает PHB customization и `human-variant`
([`parseCharacterImport`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/character-lifecycle.mjs#L1378-L1453)),
а PHB tests покрывают variant human
([`character-creation-phb-complete.test.mjs`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/test/character-creation-phb-complete.test.mjs#L57-L63)).
Это не runtime bypass, но документация неверно уменьшает заявленный пользовательский
охват и противоречит acceptance/readiness тексту. Следующий малый PR должен
обновить limitation и добавить отдельную API/browser evidence для custom
background, если этот путь остаётся официальным.

### P2 design seam / replay provenance: background benefits не имеют policy version

Event payload фиксирует `ruleset_id`, `starter_equipment_policy_*`,
`species_policy_version`, canonical `patch` и `phb_creation_result`, но не
фиксирует `background_policy_id/version` или compact snapshot разрешённых
background benefits
([`characterImportEvent`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/character-lifecycle.mjs#L1027-L1035)).
При каждом reducer/replay `withBackgroundBenefits` заново читает текущие
`backgroundId`, `backgroundChoices` и текущий catalog
([`withBackgroundBenefits`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/backgrounds.mjs#L206-L231));
`backgroundBenefits` также формирует `policy_id`, skills, tools, languages и
feature из текущих записей каталога
([`backgroundBenefits`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/backgrounds.mjs#L234-L260)).

В зафиксированном checkout это не воспроизведённый runtime failure:
обычный replay зелёный, а нынешние каталоги не менялись между двумя чтениями.
Но при исправлении навыка/языка/feature/кастомизации предыстории старый
`CharacterImported` может получить новое `backgroundSkillProficiencies` или
`backgroundBenefits` после restart/replay, хотя `species_policy_version` и
starter policy уже имеют явные legacy guards. Эти поля сами по себе не доказывают
immutable catalog: guards лишь выбирают legacy-ветку в отдельных случаях. Это полезная точка расширения,
а не повод дублировать character creation в Rules Engine.

Одного нового поля события недостаточно. `normalizeCampaignState` снова
вызывает `withBackgroundBenefits` для игроков с массивом
`backgroundChoices.replacementSkills`
([`normalizeCampaignState`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L1995-L2002)).
Кроме того, `CharacterImported` повторно вызывает `parseCharacterImport`:
изменение допустимых записей PHB/class/species/background может не только
пересчитать benefits, но и отклонить старый импорт с `IMPORT_*` ошибкой.
Это статический риск будущей замены каталога; такой переход между двумя
версиями данных в пробе не выполнялся
([`replay parse`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/character-lifecycle.mjs#L1063-L1076),
[`PHB validation`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/character-lifecycle.mjs#L1259-L1274)).

Первый совместимый шаг — определить контракт разрешения исторического
каталога для всего повторного parse/validation и соответствующей нормализации,
сохранив текущую строгую проверку нового сетевого импорта. Для новых событий
варианты: версия неизменяемого каталога либо компактный серверный resolved
snapshot. Во втором случае replay должен читать его по версии схемы, не
перевалидировать исторические choices по изменённому текущему каталогу и не
терять результат при последующей нормализации. Для событий без новых полей
нужно сохранить старую ветку, а перед изменением старого каталога — закрепить
её данные/результат явно; текущий fallback сам по себе неизменность не обещает.

Пилот можно ограничить предысторией, но тест должен проходить весь путь
`CharacterImported` → parser/reducer → normalization → replay/reopen после
замены текущей записи каталога. Не переносить в событие весь UI draft, не
доверять derived полям клиента и не объявлять это новым character engine.

## Проверки

Узкий прогон связанных существующих тестов: **87/87 passed, 0 failed**:

```text
node --test test/character-lifecycle.test.mjs test/character-creation-2014.test.mjs test/character-creation-api.test.mjs test/character-creation-class-options.test.mjs test/character-creation-equipment-complete.test.mjs test/character-creation-feats.test.mjs test/character-creation-phb-complete.test.mjs test/character-creation-wealth.test.mjs test/character-ability-methods-2014.test.mjs test/character-progression.test.mjs test/starting-level-progression.test.mjs
```

Дополнительная direct probe
[`44-character-creation-probe.mjs`](./44-character-creation-probe.mjs) прошла:

- приняты variant-human/PHB feat и custom background, а derived background
  skills появились только после серверного `resolveCommands`;
- подделанные `hp`/derived field и невозможный ability budget отклонены;
- derived HP рассчитан сервером;
- direct Rules Engine replay совпал;
- временный `FileEventStore` вернул прежний commit на duplicate key и тот же
  state после replay через новый `FileEventStore` instance.

HTTP и browser в собственной probe не использовались. Probe/server читали
локальные каталоги правил и item/background data без изменений; real storage,
`.env` и внешние LLM не использовались; зависимости не менялись. Из существующего
прогона `character-creation-api.test.mjs` один real-HTTP test прошёл; он также
проверяет restart roll state, stale ability-roll index, wealth purchase и
идемпотентный feat command. Full `pnpm verify` запрещён инструкциями этого
аудита и не запускался; изменены только этот отчёт и probe.
