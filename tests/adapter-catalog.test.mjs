import assert from 'node:assert/strict'
import test from 'node:test'

import { entryView, matchEntries, matchEntry, searchEntries } from '../adapter-catalog.js'

const entries = [
  {
    id: 'modern',
    name: 'MCHOSE Modern',
    model: 'K7 V2',
    match: { vids: ['3837'], pids: ['1014'], usagePage: 'FF01' },
  },
  {
    id: 'family',
    name: 'Family',
    model: '',
    match: { vids: ['3837'], pids: [], usagePage: 'FF02' },
  },
]

test('search and builtIn/installed are one projection', () => {
  const builtIn = new Set(['modern'])
  const results = searchEntries(entries, 'k7', { builtIn, installed: { modern: {} } })
  assert.equal(results.length, 1)
  assert.equal(results[0].builtIn, true)
  assert.equal(results[0].installed, true)
})

test('match respects pid and usage page', () => {
  assert.equal(matchEntry(entries[0], { vid: '3837', pid: '1014', usagePage: 'FF01' }), true)
  assert.equal(matchEntry(entries[0], { vid: '3837', pid: '9999', usagePage: 'FF01' }), false)
  assert.equal(matchEntry(entries[1], { vid: '3837', pid: '9999', usagePage: 'FF02' }), true)
})

test('matchEntries returns public views', () => {
  const results = matchEntries(entries, { vid: '3837', pid: '1014', usagePage: 'FF01' })
  assert.deepEqual(results.map((entry) => entry.id), ['modern'])
  assert.equal(results[0].installed, false)
})

test('entryView does not leak internal targetFile', () => {
  const view = entryView({ ...entries[0], targetFile: 'x.js' })
  assert.equal(view.id, 'modern')
  assert.equal('targetFile' in view, false)
})
