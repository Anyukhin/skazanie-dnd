# Скрытая КД и публичный прогноз: воспроизводимая проверка

Дата: 2026-10-04. Код: `cb045a84`. Приложение к
[плану, U01](../bg3-experience-roadmap-2026-10-04.md).
Это результат исследования; исправление runtime в PR не внесено.

## Результат

**Подтверждено:** две одинаковые разрешённые проекции без прогноза получают
разные публичные вероятности попадания при изменении только скрытой КД.
При известном бонусе атаки это раскрывает информацию о закрытой характеристике.
Дополнительно знание точных хитов ошибочно разрешает отдать точную КД в прогнозе.

| Синтетическое состояние | Основная проекция врага | Прогноз `armor_class` | `hit_chance` |
| --- | --- | --- | --- |
| Скрытая КД 13 | `healthKnown: banded`, `armor` отсутствует | `null` | 65% |
| Скрытая КД 18 | Такая же проекция | `null` | 40% |
| КД 18, раскрыты только хиты | `healthKnown: exact`, `armor` отсутствует | 18 | 40% |

В обеих первых строках бонус атаки +5, дальность 5 футов, укрытия нет,
здоровье и оружие одинаковы. `critical_chance` обычной атаки — 5%.
Союзник тоже получает этот прогноз: проверка `controls` допускает случай,
когда активный атакующий просто присутствует в `projected.players`.
Поэтому находка не ограничивается только владельцем атакующего героя.

Это конфликт с [принципом скрытых характеристик](../product-principles.md#L165),
а не рекомендация убрать полезные подсказки. Сам процент явно задуман как
функция интерфейса; исследование не устанавливает исторический мотив авторов.

## Путь данных

- [`attackForecast`](../../server/rules-engine.mjs#L3874) использует точную
  `effectiveArmorClass` и возвращает производные вероятности.
- [`withCombatForecast`](../../server/index.mjs#L2277) копирует `...shot`;
  при неизвестной характеристике меняет только `armor_class`. Условие
  `exact` читается из `healthKnown`, а не отдельного разрешения знать КД.
- [`publicEnemyFor`](../../server/viewer-projection.mjs#L689) раскрывает
  поле `armor` по отдельному факту `armor_class`, поэтому два уровня расходятся.
- Room GET и SSE используют `viewerStateFor`
  ([GET](../../server/index.mjs#L5335), [поток](../../server/index.mjs#L2430)).
- [`DungeonMap`](../../src/DungeonMap.tsx#L3724) показывает процент попадания,
  даже когда КД подписана как неизвестная.

## Повторение без сервера, сети и рабочей кампании

Из корня этого checkout передать следующий код в `node --input-type=module`
через stdin. В PowerShell можно поместить его в одинарный here-string и
передать через `| node --input-type=module`.
Функция берётся из текущего исходника целиком: логика скрытия не переписана
в исследовании вручную. `server/index.mjs` не импортируется, сервер не запускается.
При изменении сигнатуры извлечение должно завершиться отказом и потребовать
обновления пробы; такой способ не предлагается для production или обычных тестов.

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { attackForecast, normalizeCampaignState } from './server/rules-engine.mjs'
import { campaignStateForViewer } from './server/viewer-projection.mjs'

const source = readFileSync('./server/index.mjs', 'utf8')
const start = source.indexOf('function withCombatForecast(')
const end = source.indexOf('function viewerStateFor(', start)
assert.ok(start >= 0 && end > start, 'Обновить извлечение функции')
const withCombatForecast = new Function(
  'attackForecast', source.slice(start, end) + '; return withCombatForecast',
)(attackForecast)

const fixture = (armor, knowledge = {}) => normalizeCampaignState({
  partyMemberIds: ['hero', 'ally'],
  players: [
    { id: 'hero', character: 'Герой', hp: 12, maxHp: 12, armor: 14,
      proficiency: 2, abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 8 },
      x: 0, y: 0, inventory: [
        { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true,
          combat: { kind: 'melee', ability: 'str', damage: '1d8',
            damageType: 'slashing', normalRange: 5 } },
      ] },
    { id: 'ally', character: 'Союзник', hp: 12, maxHp: 12, armor: 14,
      proficiency: 2, abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 10, cha: 8 },
      x: 0, y: 1, inventory: [] },
  ],
  enemies: [{ id: 'goblin', name: 'Гоблин', hp: 10, maxHp: 10,
    armor, alive: true, x: 1, y: 0 }],
  scene: { turn: 1, cells: [
    { x: 0, y: 0, type: 'floor', revealed: true },
    { x: 1, y: 0, type: 'floor', revealed: true },
    { x: 0, y: 1, type: 'floor', revealed: true },
  ] },
  mechanics: { enemy_knowledge: knowledge, combat: {
    active: true, round: 1, active_index: 0,
    initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin' }],
    action_economy: { hero: { action: true } },
  } },
})
const project = (state, actor = 'hero') =>
  campaignStateForViewer(state, { role: 'player', id: actor }, actor)
const selected = ({ armor_class, hit_chance, critical_chance }) =>
  ({ armor_class, hit_chance, critical_chance })
const run = (armor, knowledge = {}) => {
  const state = fixture(armor, knowledge)
  const publicEnemy = project(state).enemies[0]
  const forecast = actor => selected(withCombatForecast(project(state, actor), state, actor)
    .combatForecast.targets.goblin[0])
  return { healthKnown: publicEnemy.healthKnown,
    armorVisible: Object.hasOwn(publicEnemy, 'armor'),
    hero: forecast('hero'), ally: forecast('ally') }
}
const p13 = project(fixture(13))
const p18 = project(fixture(18))
assert.deepEqual(p13, p18)
console.log(JSON.stringify({ publicEqual: true, ac13: run(13), ac18: run(18),
  healthOnly: run(18, { party: { goblin: { health: 'exact' } } }),
}, null, 2))
```

## Границы доказательства и следующий PR

Проверены текущие функции и состав публичного объекта на синтетических данных.
HTTP/SSE-пути подтверждены чтением кода; отдельный запрос двух браузеров в этой
пробе не выполнялся. Прогноз относится к активному бою и видимой живой цели;
недосягаемая атака уже возвращает неизвестную вероятность. Это не аудит всей
модели видимости и не доказательство корректности каждого варианта атаки.

Предлагаемая минимальная правка U01:

1. Использовать отдельное разрешённое знание КД для текущего зрителя, сохранив
   различие party-раскрытия и личного раскрытия.
2. Пока КД неизвестна, не отдавать `armor_class`, `hit_chance` и зависимый
   `critical_chance`. Оставить публичные расстояние, цену, доступность и
   разрешённые геометрические причины. UI показывает «шанс неизвестен».
3. Добавить регрессию через полный viewer/HTTP-путь для пары КД 13/18,
   раскрытия только хитов, раскрытия КД и разных зрителей; отдельно проверить
   паралич, где шанс крита при попадании зависит от шанса попадания.
4. Проверить правило отсутствия влияния: изменение только скрытой КД не
   меняет публичный прогноз. Это узкое правило; оно не требует одинакового
   результата реальных атак по существам с разной КД.

Альтернатива — официально объявить процент публичной игровой информацией.
Она меняет продуктовый принцип и потому не принимается молча в исследовании.
Новая схема событий, миграция кампаний и дополнительный LLM для исправления
описанного расхождения не нужны.
