import assert from 'node:assert/strict'
import test from 'node:test'

import { createSourceLedger, sourceSummaryLines } from '../source-ledger.js'

test('ledger fills defaults and merges one source report', () => {
  const ledger = createSourceLedger()
  ledger.set('generic', { enumerated: 44, matched: 2 })
  ledger.set('phonelink', { fileFound: false, error: 'missing' })

  const sources = ledger.toJSON()
  assert.equal(sources.generic.enumerated, 44)
  assert.equal(sources.generic.matched, 2)
  assert.equal(sources.ble.gatt, 0)
  assert.equal(sources.phonelink.error, 'missing')
})

test('summary exposes why each source is empty', () => {
  const lines = sourceSummaryLines({
    xinput: { count: 0, error: null },
    generic: { enumerated: 44, matched: 0, error: null },
    ble: { gatt: 0, windows: 0, fastpair: 0, fastpairAdvertisements: 93, error: null },
    phonelink: { fileFound: false, ageSecs: null, error: 'StartMenuCompanion.json 不存在' },
  }).join('\n')

  assert.match(lines, /通用 HID Battery：0 台匹配 \/ 44 个集合/)
  assert.match(lines, /Fast Pair 0（广告 93）/)
  assert.match(lines, /未找到卡片/)
})

test('unknown source names are ignored', () => {
  const ledger = createSourceLedger()
  ledger.set('unknown', { count: 99 })
  assert.equal(ledger.get('unknown'), null)
  assert.equal(ledger.toJSON().xinput.count, 0)
})
