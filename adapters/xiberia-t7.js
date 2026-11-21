// 西伯利亚 XIBERIA T7 / T7 GT 无线耳机（36F9:F008）—— 64 字节 / 0xFF00。
//
// 协议来源：Voltide（MIT，Copyright (c) 2026 Joko）对官方 XIBERIA HUB 内置
// ActHID.dll 的逆向：
//   query : 55 65 00 00 ...
//   reply : 55 65 00 [电量%] ...
// 读取超时 200ms；耳机休眠/关机时接收器不回帧。
//
// 本机没有该耳机，未实测。

defineAdapter({
  id: 'xiberia-t7',
  name: '西伯利亚 T7',
  kind: 'headset',
  transport: '2.4G',
  match: { vid: '36F9', pid: 'F008', usagePage: 'FF00', inLen: 64, outLen: 64 },
  async read(io) {
    const result = await io.exchange({ mode: 'write', hex: '55 65 00', wait: 300, reads: 4 })
    for (const report of result.reports) {
      const bytes = report.split(' ').map((token) => parseInt(token, 16))
      if (bytes.length < 4) continue
      if (bytes[0] !== 0x55 || bytes[1] !== 0x65) continue
      const percent = bytes[3]
      if (percent > 100) continue
      return { percent, charging: null }
    }
    throw new Error('设备无应答（耳机可能休眠）')
  },
})
