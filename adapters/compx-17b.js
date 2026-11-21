// Compx / DAREU 17 字节电量协议（0xFF02 / report id 0x08 / opcode 0x04）。
//
// 协议来源：Voltide（MIT，Copyright (c) 2026 Joko）在真机上验证的
// ATK A9 Air（373B:1278）、IMECOO P1（3554:FB34）、VXE R1（373B:10C9，
// Compx 方案）与达尔优 A950 AIR V2（260D:1175）。查询帧与校验规则一致：
// 16 字节载荷之和 ≡ 0x4D（等价于含 report id 的全帧和 ≡ 0x55）。
//
// 注意：这些 PID 没有在本机硬件上验证过，协议按 Voltide 的抓包实现。

function productName(io) {
  const product = String(io.device?.product || '').trim()
  if (!product) return undefined
  if (/usb composite device|wireless receiver|2\.4g wireless/i.test(product)) return undefined
  return product
}

defineAdapter({
  id: 'compx-17b',
  name: 'Compx 17B 设备',
  kind: 'mouse',
  transport: '2.4G · Compx',
  match: {
    vid: ['373B', '3554', '260D'],
    pid: ['1278', '10C9', 'FB34', '1175'],
    usagePage: 'FF02',
  },
  async read(io) {
    const frame = '08 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 49'
    // IMECOO 用 WriteFile，ATK A9 Air / VXE 只认 SET_REPORT：两条都试。
    let result = await io.exchange({ mode: 'write', hex: frame, wait: 900, reads: 4, inLen: 17 })
    if (result.reports.length === 0) {
      result = await io.exchange({ mode: 'setout', hex: frame, wait: 900, reads: 4, inLen: 17 })
    }

    for (const report of result.reports) {
      const bytes = report.split(' ').map((token) => parseInt(token, 16))
      if (bytes.length < 10) continue
      if (bytes[0] !== 0x08 || bytes[1] !== 0x04) continue
      if (bytes[2] !== 0x00) continue // 0x01 = 被拒绝
      const percent = bytes[6]
      if (percent > 100) continue
      // 多数固件: 1=充电、0=放电；达尔优: 1=充电、2=已充满。
      return { percent, charging: bytes[7] === 1 || bytes[7] === 2, name: productName(io) }
    }

    throw new Error('设备无应答（设备可能休眠）')
  },
})
