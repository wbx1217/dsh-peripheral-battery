// RAPOO VT3S（24AE:1411）—— 输入上报型，不写设备。
//
// 协议来源：Voltide（MIT，Copyright (c) 2026 Joko）在 VT3S 上验证：
// usage page 0xFF00 / usage 0x0002，19 字节输入报文，report id 0x07，
// byte 8 = 电量，byte 7 = 状态（1 放电，2/3 充电）。
// 鼠标自己会每隔几秒推送一帧，所以这里只被动监听，不发送任何查询。
//
// 本机没有雷柏设备，未实测。

defineAdapter({
  id: 'rapoo-vt3s',
  name: 'RAPOO VT3S',
  kind: 'mouse',
  transport: '2.4G',
  match: { vid: '24AE', pid: '1411', usagePage: 'FF00', usage: '0002' },
  async read(io) {
    const result = await io.listen({ seconds: 5 })
    for (const report of result.reports) {
      const bytes = report.split(' ').map((token) => parseInt(token, 16))
      if (bytes.length < 19 || bytes[0] !== 0x07) continue
      const percent = bytes[8]
      if (percent > 100) continue
      return { percent, charging: bytes[7] >= 2 }
    }
    throw new Error('设备无应答（雷柏鼠标可能休眠）')
  },
})
