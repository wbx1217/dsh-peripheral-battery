// CROCIRIS X7 Receiver 8K 鼠标（36F9:AA20）—— 65 字节 / 0xFF0A。
//
// 协议来源：Voltide（MIT，Copyright (c) 2026 Joko）对官方 Crociris Hub 的
// WebHID 逆向：
//   query : 00 AA 12 00 00 00 ...
//   reply : 00 55 12 00 00 [充电] [电量%] ...
// 接收器同时暴露键盘/鼠标标准集合，只有 0xFF0A 的 65 字节命令接口应答。
//
// 本机没有该鼠标，未实测。

defineAdapter({
  id: 'crociris-x7',
  name: 'CROCIRIS X7',
  kind: 'mouse',
  transport: '2.4G · X7 Receiver 8K',
  match: { vid: '36F9', pid: 'AA20', usagePage: 'FF0A', inLen: 65, outLen: 65 },
  async read(io) {
    const result = await io.exchange({ mode: 'write', hex: '00 AA 12 00', wait: 300, reads: 4 })
    for (const report of result.reports) {
      const bytes = report.split(' ').map((token) => parseInt(token, 16))
      if (bytes.length < 7) continue
      if (bytes[0] !== 0x00 || bytes[1] !== 0x55 || bytes[2] !== 0x12) continue
      const percent = bytes[6]
      if (percent > 100) continue
      return { percent, charging: bytes[5] === 1 }
    }
    throw new Error('设备无应答（鼠标可能休眠）')
  },
})
