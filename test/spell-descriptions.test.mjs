import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const catalog = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
const dictionary = JSON.parse(readFileSync(new URL('../data/spell-descriptions-ru.json', import.meta.url), 'utf8'))
const descriptions = dictionary.descriptions ?? {}

const sentenceCount = (text) => (String(text).match(/[.!?](?=\s|$)/gu) ?? []).length

test('все карточки заклинаний имеют самостоятельный русский пересказ', () => {
  assert.equal(catalog.spells.length, 439)
  assert.equal(dictionary.count, 439)
  assert.equal(Object.keys(descriptions).length, 439)

  for (const spell of catalog.spells) {
    const description = descriptions[spell.id]
    assert.equal(spell.description, description, `${spell.id}: каталог расходится со словарём`)
    assert.ok(description.length >= 50, `${spell.id}: слишком короткое описание`)
    assert.ok(sentenceCount(description) >= 1 && sentenceCount(description) <= 3, `${spell.id}: допустимо 1–3 предложения`)
    assert.match(description, /[А-Яа-яЁё]/u, `${spell.id}: нужен русский текст`)
    assert.doesNotMatch(description, /^(?:\d+d\d|область |состояние:|особый|buff|summon|utility|damage|save|healing|teleport)/iu, `${spell.id}: остался машинный фрагмент`)
    assert.doesNotMatch(description, /сервер|движок|не исполня|автогенерац|расхожд/iu, `${spell.id}: ограничение механики должно быть в supportNote`)
  }
})
