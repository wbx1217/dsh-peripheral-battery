// Logitech HID++ 2.0（Lightspeed / Unifying / Bolt）—— 实验性。
//
// 协议来源：Voltide（MIT，Copyright (c) 2026 Joko）在 G304 / GPW3 / M750M 等
// 真机上验证过的 HID++ 2.0 流程。本机没有罗技设备，因此**未实测**；如果读不到，
// 大概率是接收器/固件差异，把 battery_probe 和 probe exchange 的原始应答发我即可校正。
//
// 关键点：
//   - 20 字节长报文，report id 0x11；byte3 = (function << 4) | swId，swId 用 0x0E
//     （避开 G HUB 的 0x0D，避免它把我们的回包当成自己的状态）。
//   - 一个接收器可能挂多台设备，先用 ping 扫槽位 1..4，取第一个应答的。
//   - feature 0x1000 function 0 直接给百分比；没有时退回 0x1004 function 1
//     （function 0 是电压字段，会误导 G HUB，不能请求）。
//   - 收包必须同时匹配设备号、feature 索引和 function/swId 字节。

const SW_ID = 0x0e

function buildRequest(dev, featureIndex, fn, payload = []) {
  const bytes = new Array(20).fill(0)
  bytes[0] = 0x11
  bytes[1] = dev
  bytes[2] = featureIndex
  bytes[3] = ((fn & 0x0f) << 4) | SW_ID
  payload.forEach((value, index) => {
    bytes[4 + index] = value
  })
  return bytes.map((value) => value.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}

function parseReports(reports) {
  return reports.map((report) => report.split(' ').map((token) => parseInt(token, 16)))
}

function pick(reports, dev, featureIndex, functionByte) {
  return reports.find(
    (bytes) =>
      bytes.length >= 7 &&
      bytes[1] === dev &&
      bytes[2] === featureIndex &&
      bytes[3] === functionByte,
  )
}

async function ask(io, hex, wait, reads = 3) {
  const result = await io.exchange({ mode: 'write', hex, wait, reads, outLen: 20 })
  return parseReports(result.reports)
}

defineAdapter({
  id: 'logitech-hidpp',
  name: 'Logitech HID++',
  kind: 'mouse',
  transport: '2.4G · Logitech',
  match: { vid: '046D', usagePage: 'FF00', outLen: 20 },
  async read(io) {
    const functionByte = (fn) => ((fn & 0x0f) << 4) | SW_ID

    // 1) 扫槽位：GPW3 在 2、G304 在 1
    let dev = 0
    for (let slot = 1; slot <= 4 && dev === 0; slot++) {
      const reports = await ask(io, buildRequest(slot, 0x00, 0x01), 320, 3)
      if (pick(reports, slot, 0x00, functionByte(0x01))) dev = slot
    }
    if (dev === 0) throw new Error('设备无应答（鼠标可能休眠）')

    async function getFeature(feature) {
      const reports = await ask(
        io,
        buildRequest(dev, 0x00, 0x00, [feature >> 8, feature & 0xff]),
        450,
        3,
      )
      const reply = pick(reports, dev, 0x00, functionByte(0x00))
      return reply ? reply[4] : 0
    }

    async function call(featureIndex, fn) {
      const reports = await ask(io, buildRequest(dev, featureIndex, fn), 550, 3)
      const reply = pick(reports, dev, featureIndex, functionByte(fn))
      if (!reply) throw new Error('设备无应答（鼠标可能休眠）')
      return reply
    }

    // 2) 找电量 feature
    let feature = await getFeature(0x1000)
    let fn = 0x00
    if (feature === 0) {
      feature = await getFeature(0x1004)
      fn = 0x01
    }
    if (feature === 0) throw new Error('该设备没有 HID++ 电量 feature')

    // 3) 读电量：reply[4]=百分比，reply[5]&0x02=充电
    const reply = await call(feature, fn)
    const percent = reply[4]
    if (percent > 100) throw new Error('读数异常')
    return { percent, charging: (reply[5] & 0x02) !== 0 }
  },
})
