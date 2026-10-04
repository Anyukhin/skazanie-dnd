# Раунд 8: контракт семантики решения отряда

Срез аудита — `cb045a8466f35696ff24abe9020d6f39dee89462`, 4 октября 2026.
Проверен текущий код в checkout аудита; runtime, storage, данные кампаний и UI не
менялись. Вывод — возможность небольшого будущего контракта, а не
подтверждённый баг.

## Фактический владелец и путь данных

Семантика решения сейчас проходит несколько владельцев. Это важно сохранить при
любом расширении: stable ID уже владеет голосом и replay, но ещё не владеет
действием.

1. `server/party-exit-intent.mjs` владеет словарём ухода. [`detectPartyExitRequest`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/party-exit-intent.mjs#L376-L408)
   возвращает место, источник фразы и, если он пришёл с карты мира,
   `destinationLocationId`. [`classifyPartyDecision`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/party-exit-intent.mjs#L541-L546)
   превращает выбранную подпись в `kind: move|stay|other`, `destinationHint` и
   независимый флаг `abandonsQuest`.
2. `server/player-request-router.mjs` владеет входом игрока:
   [`proposeAgentInteraction`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/player-request-router.mjs#L357-L412)
   строит подписи вариантов, а `proposeRoutedTravel` использует тот же словарь.
   В proposal ID назначения хранится на всей карточке, а варианты пока остаются
   строками. В [`resolvePartyDecision`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/player-request-router.mjs#L571-L593)
   текст после маркера — транспортный legacy-вход; для решения он вызывает
   `interpretResolvedPartyDecision`.
3. `server/index.mjs` в [`executeTool('request_party_decision')`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L2598-L2626)
   присваивает строкам ID (`option-1`, ...), ограничивает подпись и через
   [`persistInteractionProjection`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L3153-L3185)
   пишет `PartyDecisionOpened`. Соло-путь
   [`executeSoloPartyExit`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/index.mjs#L2783-L2830)
   самостоятельно классифицирует подписи и выбирает вариант; это второй
   потребитель той же семантики, его нельзя забыть при изменении контракта.
4. `server/party-decision.mjs` владеет голосом. [`resolvePartyVote`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/party-decision.mjs#L453-L502)
   и `resolvePartyAbstain` проверяют членство, снимок участников и
   существование `optionId`, а события `PartyVoteCast` и
   `PartyDecisionResolved` несут ID. [`normalizePartyDecision`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/party-decision.mjs#L88-L174)
   сейчас сохраняет у option только `id` и `label`,
   поэтому произвольное `intent` на этом переходе теряется. Это не означает,
   что вся механика сейчас зависит только от label: card-level
   `questAbandonment.schemaVersion/questId` и
   `questAcceptance.schemaVersion/questId` уже сохраняются и исполняются своим
   [`questDecisionEvents`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/party-decision.mjs#L181-L237)
   контрактом.
   `resolvePartyAbstain` проверяют членство, снимок участников и существование
   `optionId`, а события `PartyVoteCast` и `PartyDecisionResolved` несут ID.
   `normalizePartyDecision` сейчас сохраняет у option только `id` и `label`,
   поэтому произвольное `intent` на этом переходе теряется. Это не означает,
   что вся механика сейчас зависит от label: card-level
   `questAbandonment.schemaVersion/questId` и
   `questAcceptance.schemaVersion/questId` уже сохраняются и исполняются своим
   `questDecisionEvents`-контрактом.
5. Фактический владелец смысла уже выбранного решения —
   `server/scene-architect.mjs`, функции [`selectedDecision` и
   `interpretResolvedPartyDecision`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/scene-architect.mjs#L101-L133).
   `selectedDecision` сначала выбирает сохранённую опцию по
   `resolvedOptionId`, затем заново вызывает `classifyPartyDecision` на её
   `label`. Для `move` он переносит только верхнеуровневый
   `destinationLocationId`.
6. `executeDirectorSceneTransitionOnce` передаёт результат картографу. В
   [`buildDirectorTransitionCommands`](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/director-scene-transition.mjs#L180-L286)
   свежему состоянию снова применяется `abandonableQuest`; подпись задания
   намеренно не является его ID. Затем `AdvanceScene` и, при отказе,
   `ResolveQuest` идут в авторитетный контур. Rules Engine до записи проверяет
   Director capability, версию состояния, бой, стражу и ссылку
   `interaction_id + resolved_option_id` в [`AdvanceScene` guard](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/rules-engine.mjs#L6205-L6240);
   в reducer `PartyDecisionConsumed` очищает только совпавшее решение.
7. Для специальных карточек принятия/отказа от задания есть отдельный владелец
   `server/quest-decisions.mjs`: там ID `accept|later|keep|abandon` и
   `questAcceptance`/`questAbandonment` уже задают механику
   ([открытие карточки](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/quest-decisions.mjs#L50-L84),
   [исполнение по свежему состоянию](https://github.com/Anyukhin/skazanie-dnd/blob/cb045a8466f35696ff24abe9020d6f39dee89462/server/quest-decisions.mjs#L94-L119)).
   Их нельзя незаметно подменить общим разбором русской подписи.

Итого, менять только `classifyPartyDecision` недостаточно: нужно согласовать
`interpretResolvedPartyDecision` и `executeSoloPartyExit`, а сохранение поля — с
`normalizePartyDecision` и reducer/replay. При этом `SceneAdvanced` уже хранит
ссылку на ID решения, и её менять не требуется.

## Что делает текущий контракт

Новая подпись после исправления длинного маршрута режется сервером по слову и не
оставляет незакрытую кавычку. Это защищает новый вариант от превращения
обрубка вроде `«Другой п` в имя локации. Однако семантика всё ещё выводится из
подписи:

| Ситуация | Текущий результат | Значение |
| --- | --- | --- |
| Новая длинная подпись | `move`, подсказка — безопасное начало названия; верхнеуровневый `destinationLocationId` сохраняется | Маршрут по ID устойчив, свободный текст остаётся эвристикой |
| Старая подпись, обрезанная внутри кавычек | `move`, `destinationHint: ''` | Обрывок не становится новой локацией; без ID остаётся обычный fallback картографа |
| Изменён только текст action после маркера | Семантика прежняя | `selectedDecision` читает option по сохранённому `resolvedOptionId` |
| Переименован сохранённый `label` при том же ID | Семантика может измениться с `move` на `stay` и обратно | Stable ID пока не отделяет действие от отображения |
| Добавлен `option.intent` | Текущий normalizer его отбрасывает, а resolver его не читает | Поле нельзя считать существующим контрактом |

Чистая проба [`35-party-decision-probe.mjs`](35-party-decision-probe.mjs)
проверяет этот roundtrip без HTTP, браузера, LLM и storage. В ней длинный
маршрут доходит до resolver как prefix, изменение текста action не меняет
результат, изменение сохранённой подписи меняет его, старый обрывок даёт пустую
подсказку, а уже существующий верхнеуровневый ID сохраняется.

Переименование в probe намеренно заменяет смысловую подпись `Уходим...` на
`Остаться...`. Это контроль зависимости от сохранённого смысла, а не утверждение
о косметической copy-editing ошибке и не доказательство, что игрок может изменить
label через vote API. Текущий клиент не даёт игроку переименовывать сохранённую
карточку. Граница дизайна станет существенной при локализации, редактуре
подписей, более богатых карточках или изменении текста после открытия решения.

## Минимальная возможность для будущего контракта

Если потребуется убрать зависимость от подписей именно у детерминированных
travel/leave-вариантов, достаточно добавить версионированный семантический
объект к уже существующим option ID, не меняя ID голосов:

```js
{
  id: 'option-1',
  label: 'Уходим из «Тихий Брод» и идём в «Эствуд»', // подпись для игрока
  intent: {
    schemaVersion: 1,
    kind: 'move',                 // для этого пилота: move | stay
    destinationLocationId: 'estwood',
    destinationHint: 'Эствуд',   // только если ID нет или как legacy-подсказка
    questAction: null,            // либо 'abandon' для travel/leave-варианта
  },
}
```

Правила этого DTO:

- `id` остаётся тем же непрозрачным ID, который голосуют, пишут в события и
  используют в idempotency/replay. Ссылки в `resolvedOptionId`, событиях голоса
  и результата и `SceneAdvanced.payload.party_decision` сохраняются. Payload
  открытия карточки и её snapshot при этом расширяются новым версионированным
  полем; именно их совместимость и replay нужно проверить отдельно.
- `label` — только отображение. Для `move` авторитетным назначением является
  известный server-owned `destinationLocationId`; `destinationHint` — bounded
  текст для места без узла карты. Ни одно из этих полей не разрешает клиенту
  телепорт без проверки текущего `worldMap`.
- `questAction` остаётся маленьким маркером travel/leave-варианта, ортогональным
  `kind`, как нынешний `abandonsQuest`. Это не новый контракт заданий: для него
  переиспользуются `abandonableQuest(state)`, существующая проверка видимости и
  active-статуса и обычный `ResolveQuest`. В v1 не следует класть сюда
  `questId`, взятый из заголовка задания: `abandonableQuest(state)` специально
  выбирает свежую видимую active нить во время исполнения. Отдельные карточки
  принятия/отказа с `questAcceptance`/`questAbandonment` остаются под
  `quest-decisions.mjs` и не переводятся на этот DTO.
- Поле получает только детерминированный server-authored route proposal,
  который уже прошёл `party-exit-intent` и, для ID, проверку карты. Сырые
  варианты от LLM без подтверждённого intent остаются legacy-карточками: их
  можно разобрать прежним словарём, но незнакомый intent не становится
  исполнимым действием.
- В `normalizePartyDecision` принимается только известная версия, безопасные
  ID, ограниченные строки и перечисленные значения. Поле отсутствует — это
  нормальная старая карточка. Поле неизвестной версии или с неправильной
  формой не читается как команда; server-authored malformed proposal должен
  быть отклонён до открытия.

Семантический resolver должен оставаться одним: сначала взять выбранный option
по `resolvedOptionId`, затем использовать валидный `intent`. Только при полном
отсутствии поля вызывать прежний `classifyPartyDecision(label)` для legacy-карточки.
Присутствующее поле неизвестной версии или неправильной формы должно давать
явный отказ/требование миграции, а не молча превращаться в legacy-разбор подписи.
Ту же функцию должны
использовать `interpretResolvedPartyDecision` и `executeSoloPartyExit`. Это
узкий адаптер существующего контракта, а не универсальный DSL для всех решений.

## Старые карточки, replay и свежесть задания

Миграция старых событий не нужна. `PartyDecisionOpened` старого формата
останется с `id/label`; при replay он будет разрешаться legacy-веткой. Старые
`PartyVoteCast`, `PartyDecisionResolved`, `PartyDecisionConsumed` и ссылки в
`SceneAdvanced` уже содержат необходимые ID. Карточка с обрезанной кавычкой
по-прежнему не должна угадывать новый пункт назначения; если в ней есть старый
верхнеуровневый `destinationLocationId`, он может пройти существующую проверку
карты, иначе остаётся текущий fallback.

Сохранённые card-level `questAcceptance` и `questAbandonment` также остаются
совместимыми: их ID, проверки `questDecisionEvents` и `PartyDecisionConsumed`
не меняются. Новый option intent не должен пытаться выразить `accept|later|keep|abandon`
вторым способом.

Для нового intent сервер должен перечитывать авторитетное состояние перед
переходом. ID назначения проверяется по известному и видимому узлу карты и
маршрутной политике; значение из public projection или из запроса игрока не
является полномочием. Правила членства и владельца героя остаются в
`canUseHero`, `assertHeroInParty` и серверных party events. Сам переход по-прежнему
создаётся только Director-контуром, с optimistic `state_version`, проверками боя
и стражи и одной атомарной цепочкой событий.

`questAction: 'abandon'` требует отдельной policy freshness. В текущем коде
название в label — подсказка игроку, а `abandonableQuest(planningState)` выбирает
цель заново; затем `ResolveQuest` проверяет состояние при commit. Если задание
между открытием карточки и исполнением стало скрытым, закрытым или заменилось,
нужно заранее выбрать поведение: отклонить весь переход либо выполнить уход без
отказа. Нельзя молча превращать старый видимый title в новый `questId` и нельзя
называть такую смену состояния уже найденным багом — это вопрос политики
свежести. В v1 безопаснее сохранить нынешний серверный выбор и явно зафиксировать
результат/отказ в том же commit.

## Решение аудита

Идея минимального per-option intent совместима с текущими ID и legacy fallback,
но сейчас она ещё не реализована и не должна описываться как поддержанный API.
Рекомендуемый следующий шаг — отдельная runtime-задача с тестами на:

- сохранение валидного intent через `PartyDecisionOpened` и replay;
- одинаковый результат `interpretResolvedPartyDecision` и solo-пути при
  переименовании label;
- отсутствие доверия неизвестному/неизвестной версии intent;
- известный, неизвестный и устаревший `destinationLocationId`;
- свежесть видимого задания, отказ до расхода и идемпотентный повтор;
- старую карточку без intent и старую обрезанную подпись.

В этой пробе HTTP и браузер не запускались, поэтому заявлений об этих путях
здесь нет. Проверены только `node --check` и сам чистый probe:

```text
node --check docs/reviews/2026-10-04/round-8/35-party-decision-probe.mjs
node docs/reviews/2026-10-04/round-8/35-party-decision-probe.mjs
```

Оба шага прошли. Дополнительно точечный чистый набор
`node --test test/party-exit-intent.test.mjs test/player-request-router.test.mjs test/scene-architect.test.mjs`
дал **59/59 passed**. Изменены только этот документ и probe; runtime, source/data,
storage, `.env` и зависимости не трогались.
