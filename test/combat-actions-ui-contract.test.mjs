import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * Сторож одного узкого места клиента: чтения роли героя в
 * `src/combat-actions.ts`.
 *
 * Проверка **текстовая**, а не поведенческая, и это не лень: модуль
 * TypeScript, а транспилятора в тестовом контуре нет — `node:test` его не
 * импортирует. Поэтому сторож меряет то единственное, что здесь и ломалось:
 * форму чтения поля. Поймать регресс он обязан до сборки, а не после белого
 * экрана за столом.
 *
 * Почему сторож вообще нужен. Тип объявляет `Player.role` обязательным, значит
 * `tsc` про небезопасное чтение молчит; но состояние кампании приезжает и
 * помимо мастера персонажей — админским импортом, командой Режиссёра, старым
 * сохранением, — и поля там может не быть. Один такой лист роняет
 * `<DungeonMap>` целиком: стол получает пустой экран вместо доски. Найдено
 * живой пробой 2026-08-16.
 */
const source = await readFile(new URL('../src/combat-actions.ts', import.meta.url), 'utf8')

test('роль героя читается через один защищённый помощник, и незащищённой формы в модуле нет', () => {
  // Помощник есть, и умолчание у него безопасное: нет поля — пустая строка.
  assert.match(source, /function roleSignature\(player\?: Player\): string \{\s*return String\(player\?\.role \?\? ''\)\.toLocaleLowerCase\('ru'\)/u)

  // Прямого чтения `.role` мимо помощника не осталось ни одного. Из подсчёта
  // исключены комментарии: объяснение бага цитирует ровно ту форму, которую
  // сторож и запрещает, и без этого сторож падал бы на собственной документации.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  assert.doesNotMatch(code, /player\??\.role\s*\.\s*to(?:Locale)?LowerCase/u, 'роль обязана читаться через roleSignature')
  assert.deepEqual(code.match(/\.role\b/gu), ['.role'], 'единственное чтение `role` в модуле — внутри roleSignature')

  // Все три потребителя действительно спрашивают помощника.
  assert.equal((code.match(/const role = roleSignature\(player\)/gu) ?? []).length, 3)
})

test('неизвестный класс оставляет герою общие действия, а не выдумывает своих', () => {
  // Умолчание помощника — пустая строка, и ни один классовый шаблон её не
  // ловит: список действий вырождается в `common`, а не в случайный класс.
  // Подставить сюда имя персонажа было бы хуже пустоты — «Волшебница» стала бы
  // волшебницей по классу.
  assert.doesNotMatch(source, /player\?\.role \?\? player\?\.(?:character|name)/u)
  const patterns = source.match(/\/(?:[^/\\\n]|\\.)+\/u\.test\(role\)/gu) ?? []
  assert.ok(patterns.length > 0, 'классовые шаблоны обязаны проверяться по строке роли')
  for (const expression of patterns) {
    const body = expression.slice(1, expression.lastIndexOf('/u.test(role)'))
    assert.equal(new RegExp(body, 'u').test(''), false, `шаблон ${expression} срабатывает на пустой роли`)
  }
})
