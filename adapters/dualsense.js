// Sony DualSense / DualSense Edge（054C:0CE6 / 0DF2）—— 输入上报型。
//
// 协议来源：Voltide（MIT，Copyright (c) 2026 Joko）在 PS5 手柄上验证：
//   - USB 输入报文 report 0x01（64B）：电量状态字节在 offset 53
//   - 蓝牙输入报文 report 0x31（78B）：电量状态字节在 offset 54
//   - 蓝牙模式先 GET_FEATURE(0x05)（41 字节校准数据）才会开始发 0x31 扩展报文
//   - status 低半字节 = 电量档（每档 10%），高半字节 = 充电状态
//     （1 充电中，2 已充满，0x0A/0x0B/0x0F 电池异常）
//
// 本机没有 DualSense，未实测。

defineAdapter({
  id: 'sony-dualsense',
  name: 'PS5 DualSense',
  kind: 'controller',
  transport: 'USB / 蓝牙',
  match: { vid: '054C', pid: ['0CE6', '0DF2'], usagePage: '0001', usage: '0005' },
  async read(io) {
    // 蓝牙：先请求 feature 0x05，触发扩展报文
    if (io.device.inputLen >= 78) {
      const feature = ['05']
      for (let i = 0; i < 40; i++) feature.push('00')
      try {
        await io.exchange({ mode: 'getfeat', hex: feature.join(' '), wait: 300 })
      } catch {
        // 有些固件不接受；继续尝试监听 0x31
      }
    }

    const result = await io.listen({ seconds: 2 })
    for (const report of result.reports) {
      const bytes = report.split(' ').map((token) => parseInt(token, 16))
      const id = bytes[0]
      let status
      if (id === 0x01 && bytes.length >= 54) status = bytes[53]
      else if (id === 0x31 && bytes.length >= 55) status = bytes[54]
      else continue

      const capacityLevel = status & 0x0f
      const chargingStatus = status >> 4
      let percent = Math.min(capacityLevel * 10, 100)
      let charging = chargingStatus === 1
      if (chargingStatus === 2) {
        percent = 100
        charging = true
      }
      return { percent, charging }
    }
    throw new Error('设备无应答（手柄可能休眠）')
  },
})
