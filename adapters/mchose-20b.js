// MCHOSE 20 字节协议的其他 PID（3554:FA09 K99 v2、258A:01BB Z75S）。
//
// 协议来源：Voltide（MIT，Copyright (c) 2026 Joko）的真机抓包；帧格式与
// 本插件内置的 MCHOSE G87（41E4:2001）一致：report id 0x13，命令 0x4A，
// 前 19 字节和校验；应答 [5] = 电量，[6] 高半字节 = 充电状态。
//
// 注意：这两个 PID 没有在本机硬件上验证过。

function productName(io) {
  const product = String(io.device?.product || '').trim()
  if (!product) return undefined
  if (/usb composite device|wireless receiver|2\.4g wireless/i.test(product)) return undefined
  return product
}

defineAdapter({
  id: 'mchose-20b',
  name: 'MCHOSE 2.4G 键盘',
  kind: 'keyboard',
  transport: '2.4G',
  match: { vid: ['3554', '258A'], pid: ['FA09', '01BB'], usagePage: 'FF02' },
  async read(io) {
    const result = await io.exchange({
      mode: 'setout',
      hex: '13 4A 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 5E',
      wait: 800,
      reads: 6,
      inLen: 20,
    })

    for (const report of result.reports) {
      const bytes = report.split(' ').map((token) => parseInt(token, 16))
      if (bytes.length < 20) continue
      if (bytes[0] !== 0x13 || bytes[1] !== 0x4a) continue
      if (bytes[4] === 0) continue // 查询帧回显
      if (bytes[2] !== 0x01 || bytes[3] !== 0) continue
      const sum = bytes.slice(0, 19).reduce((acc, byte) => acc + byte, 0) & 0xff
      if (sum !== bytes[19]) continue
      if (bytes[5] > 100) continue
      return { percent: bytes[5], charging: bytes[6] >> 4 === 1, name: productName(io) }
    }

    throw new Error('设备无应答（设备可能休眠）')
  },
})
