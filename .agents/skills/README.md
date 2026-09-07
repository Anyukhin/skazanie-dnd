# Дизайн-скиллы из WhichAI

Установлены локально для проекта в `.agents/skills` из источников,
на которые ссылается https://www.whichai.dev/ (2026-09-06).
Оригинальные тексты сохранены на языке авторов.

| Скилл | Источник | Зафиксированный коммит |
| --- | --- | --- |
| frontend-design | https://github.com/anthropics/skills/tree/main/skills/frontend-design | 41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f |
| design-taste-frontend | https://github.com/Leonxlnx/taste-skill/tree/main/skills/taste-skill | ccbc15639c97057cbfcf32ecebc38ef716e4bb37 |
| uncodixfy | https://github.com/cyxzdev/Uncodixfy | e0e028058b5259debdd94b78147c6d6c77bf7da2 |

Вызов в запросе: `$frontend-design`, `$design-taste-frontend` или `$uncodixfy`.
Выбирайте один подход под задачу: их эстетические рекомендации могут расходиться.
Taste Skill — текущая экспериментальная v2, ориентированная на лендинги,
портфолио и редизайн; это не подтверждение версии каждого примера на WhichAI.
Правила проекта о русском интерфейсе, серверной механике и запрете новых
зависимостей без запроса сохраняют приоритет.

UI SH не установлен: опубликованный в репозитории WhichAI `SKILL.md`
только вызывает `uidotsh_fetch` для ресурса `uidotsh://ui`.
Этот инструмент в текущем окружении недоступен.
Источник: https://github.com/SunkenInTime/ui-design-bench/blob/master/src/variants/with-ui-sh-skill/gpt-5.5-high/source/.cursor/skills/ui/SKILL.md
