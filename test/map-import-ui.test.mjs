import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('owner map dialog exposes an explicit layout-preserving floor refresh', async () => {
  const source = await readFile(new URL('../src/MapImportModal.tsx', import.meta.url), 'utf8')
  assert.match(source, /preserveLayout/u)
  assert.match(source, /preserve_layout: preserveLayout/u)
  assert.match(source, /Обновить только покрытия/u)
  assert.match(source, /сохранить планировку, двери, этажи, позиции героев и NPC и туман войны/u)
})
