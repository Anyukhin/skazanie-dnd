# Аудит автономного цикла «Сказания»

Дата проверки: 2026-07-19.

## Реализованный вертикальный цикл

Серверный `AutonomousCampaignOrchestrator` исполняет цепочку
`исследование → социальная сцена/проверка → quest progress → EncounterAssembler → бой → outcome/reward → world fact → доступный переход`.

- Director принимает только шесть намерений контракта `skazanie:director-intent-v1`.
- Поля механики (`hp`, `dc`, броски, цены, количества, XP, координаты, урон, инициатива и reputation delta) отклоняются до исполнения.
- Встреча собирается существующим `EncounterAssembler` через `CreateEncounter`, затем сервер автоматически выполняет `StartCombat`; admin endpoint не используется.
- Автономная тактика героев и NPC проходит через обычные typed combat commands и `RulesEngine`.
- Завершение создаёт `EncounterOutcomeRecorded`, `ExperienceAwarded` либо `MilestoneAwarded`, `ServerLootGenerated`, `ItemGranted`, `QuestClockAdvanced`, `WorldFactRecorded` и `TransitionUnlocked`.
- Репутационная дельта выбирается таблицей сервера; `WitnessConsequencePropagated` ограничен непосредственными фракциями свидетелей (membership хранится безопасным тегом `faction:<id>`).
- Условия promises хранятся каноническими world facts и разрешаются `ResolveNpcPromise`; статус `open` обеспечивает однократное применение. Дедлайны продолжают обрабатываться существующим `AdvanceTime`.
- Расписания NPC хранятся event-sourced world facts. `AdvanceTime` исполняет только пересечённые, ещё не отмеченные schedule entries и фиксирует факт исполнения.
- Неизвестное действие возвращает уточнение либо `RecordRuling` со scope `single-action` и ограниченным набором вариантов; objective/hook сохраняет продолжение сюжета.
- Production route `POST /api/campaigns/:id/autonomy/intents` требует обычную авторизацию и доступ к кампании, но не admin role. Он принимает только bounded intent; `run_combat` запускает серверный бой и completion.

## Автоматическое доказательство

`test/autonomous-campaign.test.mjs` проводит более 30 ходов без admin-команд и проверяет наличие событий сцены, социальной проверки, promises, встречи, боя, loot, quest progress, schedule action и перехода. Затем он сравнивает итог с полным replay без snapshot и с состоянием после нового экземпляра `FileEventStore`.

Последний целевой прогон: 3/3 теста успешно, интеграционная кампания — 28.643 с, replay identical, restart identical, admin commands — 0.

## Действительно оставшиеся блокеры полной замены ведущего

1. Нужен продолжительный online-eval с реальным LLM-провайдером: текущая доказательная кампания детерминирована и измеряет 0 LLM tokens, но не качество художественного текста разных моделей.
2. Контентные таблицы встреч и server loot пока ограничены четырьмя темами и тремя difficulty tiers; это не блокирует автономность, но ограничивает разнообразие длинных кампаний.
3. Репутация фиксируется событиями и world facts, но пока не имеет отдельного UI экрана и не влияет на полный ассортимент социальных политик/торговли.
4. Автономная тактика героев намеренно консервативна (перемещение, базовая атака, завершение хода); выбор заклинаний и class actions требует отдельной server policy, а не LLM-механики.
5. Нужен эксплуатационный soak/recovery тест с принудительными остановками процесса и конкурентными player requests поверх файлового EventStore; unit restart/replay уже проходит.

Эти пункты относятся к глубине, разнообразию и эксплуатации. Человек-администратор для запуска базового вертикального цикла больше не нужен.
