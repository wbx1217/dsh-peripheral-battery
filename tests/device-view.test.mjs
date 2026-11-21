import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDeviceView, listDeviceRegistry, normalizeDeviceName } from '../device-view.js'

const displayNameOf = (entry, device) => entry.customName || device?.name || entry.name

function fixture() {
  const registry = new Map([
    ['a', { key: 'a', name: 'Mouse', kind: 'mouse', transport: '2.4G', order: 1, visible: true }],
    ['b', { key: 'b', name: 'Keyboard', kind: 'keyboard', transport: '2.4G', order: 2, visible: true }],
    ['c', { key: 'c', name: 'Hidden', kind: 'other', transport: 'BLE', order: 3, visible: false }],
  ])
  const lastReadings = new Map([
    ['b', { percent: 42, charging: false }],
  ])
  return { registry, lastReadings }
}

test('view keeps registry order and shows unplugged last readings', () => {
  const { registry, lastReadings } = fixture()
  const view = buildDeviceView(
    [{ key: 'a', name: 'Mouse', status: 'online', percent: 90, kind: 'mouse' }],
    { registry, lastReadings, displayNameOf, base: { schema: 1 } },
  )
  assert.equal(view.schema, 1)
  assert.deepEqual(view.devices.map((device) => device.key), ['a', 'b'])
  assert.equal(view.devices[0].status, 'online')
  assert.equal(view.devices[1].status, 'unplugged')
  assert.equal(view.devices[1].percent, 42)
  assert.equal(view.onlineCount, 1)
})

test('missing status becomes unplugged and keeps stale flag', () => {
  const { registry, lastReadings } = fixture()
  const view = buildDeviceView(
    [{ key: 'b', name: 'Keyboard', status: 'missing', percent: null }],
    { registry, lastReadings, displayNameOf },
  )
  const device = view.devices.find((item) => item.key === 'b')
  assert.equal(device.status, 'unplugged')
  assert.equal(device.stale, true)
})

test('registry list includes BLE components and hidden entries', () => {
  const { registry, lastReadings } = fixture()
  const list = listDeviceRegistry(
    [{ key: 'a', name: 'Mouse', status: 'online', percent: 80, components: [{ label: 'L', percent: 80 }] }],
    { registry, lastReadings, displayNameOf },
  )
  assert.equal(list.length, 3)
  assert.deepEqual(list[0].components, [{ label: 'L', percent: 80 }])
  assert.equal(list[2].visible, false)
})

test('device names are bounded and control characters removed', () => {
  assert.equal(normalizeDeviceName('  Mouse\u0000  '), 'Mouse')
  assert.throws(() => normalizeDeviceName('   '))
  assert.throws(() => normalizeDeviceName('x'.repeat(41)))
})
