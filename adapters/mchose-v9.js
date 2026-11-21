// MCHOSE V9 Turbo+ 耳机（3837:600A）—— 64 字节 / 0xFF90 / report 0x55。
//
// 协议来源：Voltide（MIT，Copyright (c) 2026 Joko）的真机抓包：
//   query : 55 65 01 00 ...
//   reply : 55 65 [电量%] [状态] ...
//           状态 0x02 放电、0x03 充电中、0x04 已充满。
// 同一 VID 的 3837:6008 是灯光接口，不应答这条命令。
//
// 本机没有该耳机，未实测。

defineAdapter({
  id: 'mchose-v9',
  name: 'MCHOSE V9 Turbo+',
  kind: 'headset',
  transport: '2.4G',
  match: { vid: '3837', pid: '600A', usagePage: 'FF90', inLen: 64, outLen: 64 },
  async read(io) {
    const result = await io.exchange({
      mode: 'write',
      hex: '55 65 01',
      wait: 400,
      reads: 4,
    })

    for (const report of result.reports) {
      const bytes = report.split(' ').map((token) => parseInt(token, 16))
      if (bytes.length < 4) continue
      if (bytes[0] !== 0x55 || bytes[1] !== 0x65) continue
      let percent = bytes[2]
      if (percent > 100) continue
      const state = bytes[3]
      let charging = state === 0x03
      if (state === 0x04) {
        percent = 100
        charging = true
      }
      return { percent, charging }
    }
    throw new Error('设备无应答（耳机可能休眠）')
  },
})
