// 新适配器模板。复制到 adapters/ 或用户适配器目录后修改。
// 详细说明：docs/ADAPTERS.md
defineAdapter({
  id: '__ID__',
  tier: 'beta',
  name: '__NAME__',
  kind: 'mouse',
  transport: '2.4G',
  showWhenMissing: false,
  match: {
    vid: '1234',
    pid: '5678',
    usagePage: 'FF02',
    // usage: '0002',
    // inLen: 20,
    // outLen: 20,
    // featureLen: 0,
  },
  async read(io) {
    const result = await io.exchange({
      mode: 'setout',
      hex: '08 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 49',
      wait: 900,
      reads: 4,
      inLen: 20,
    })

    for (const report of result.reports) {
      const bytes = report.trim().split(/\s+/).map((value) => parseInt(value, 16))
      if (bytes.length < 8) continue
      // 跳过接收器回显，按真实协议替换下面的判断。
      if (bytes[0] !== 0x08) continue
      const percent = bytes[5]
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) continue
      // 协议能判断充电时改成布尔值；判断不了就保持 null。
      const charging = null
      return { percent, charging }
    }

    throw new Error('设备无应答（可能休眠）')
  },
})
