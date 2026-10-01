# Гарнитуры интерфейса

Четыре роли на весь интерфейс, все файлы лежат в репозитории. В правилах CSS
семейство указывается только токеном — `var(--f-ui)`, `var(--f-label)`,
`var(--f-serif)` или `var(--f-display)` (объявлены в `:root` файла
`src/styles.css`); имя гарнитуры напрямую пишут лишь рисунки на canvas
(`board-render.ts`, `dice-geometry.ts`, `spell-effects.ts`, `TacticalBoard.tsx`),
потому что CSS-переменные туда не доходят.

| Токен | Роль | Гарнитура | Начертания | Файлы |
| --- | --- | --- | --- | --- |
| `--f-ui` | кнопки, подписи, числа, служебный текст | **Alegreya Sans** | 400 / 500 / 700 / 800 | `alegreya-sans-{latin,cyrillic}-{400,500,700,800}.woff2` |
| `--f-label` | подписи капителью (бывшие прописные с разрядкой) | **Alegreya Sans SC** | 500 / 700 | `alegreya-sans-sc-{latin,cyrillic}-{500,700}.woff2` |
| `--f-serif` | рассказ, имена, описания | **Alegreya** (вариативная 400–700) и курсив 400 | вариативный файл + курсив | `alegreya-{latin,cyrillic}-variable.woff2`, `alegreya-{latin,cyrillic}-400-italic.woff2` |
| `--f-display` | заголовки от 18 px | **Cormorant SC** | 500 / 600 / 700 | `cormorant-sc-{latin,cyrillic}-{500,600,700}.woff2` |

Подмножества — только `latin` и `cyrillic`: интерфейс русский, латиница нужна
для кодов комнат и цифр. Курсив есть только у Alegreya — им набраны реплики в
рассказе; у остальных гарнитур наклона в интерфейсе нет.

Цифры бросков, полей характеристик и граней костей оставлены в Alegreya, а не в
Cormorant SC: у Cormorant старостильные цифры, и «17» в итоге броска прыгало
по линии.

У Alegreya Sans строчные ниже, чем были у Manrope, поэтому мелкие ступени шкалы
кегля (`--fs-xxs` … `--fs-xl`) подняты на пиксель.

## Происхождение и права

Все четыре гарнитуры распространяются по **SIL Open Font License 1.1** —
бандлить с приложением можно. Файлы получены с Google Fonts инструментом
`tools/fetch-fonts.mjs` (он же печатает `src/fonts.css` с `@font-face`;
руками этот файл не правится). Версии на момент загрузки (2026-10-01):
Alegreya v41, Alegreya Sans v28, Alegreya Sans SC v26, Cormorant SC v19.

Прежние Manrope и Spectral (до 2026-10-01) удалены вместе с записями реестра.

Каждый файл зарегистрирован в `data/asset-rights.json` штатным инструментом
(`node tools/register-asset-rights.mjs --all-under fonts`); контрольная сумма
сверяется `test/content-integrity.test.mjs`.

## Почему не `@import` с Google Fonts

Сервер отдаёт CSP `style-src 'self' 'unsafe-inline'`, и в проде (Docker)
подключение к `fonts.googleapis.com` блокировалось: игроки видели системные
Segoe UI и Times New Roman, а dev-сборка без CSP показывала задуманное. С
локальными файлами сеть и CSP не участвуют, и дев с продом совпадают. Обновить
набор (новый вес или подмножество) — поправить запрос в `tools/fetch-fonts.mjs`,
перезапустить его и перерегистрировать файлы.
