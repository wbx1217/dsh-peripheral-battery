# Changelog

## 0.1.0 — 2026-11-21

首个可安装的开发版。

### 功能

- DSH Host + Client 插件：底栏电量、设置页设备管理、首次使用引导。
- Rust sidecar：HID 枚举/读写、XInput、BLE GATT/Windows 已知电量、Fast Pair、Phone Link、标准 HID Battery 兜底。
- JS adapter：factory `stable` / `beta`、用户适配器热加载、市场搜索/预览/安装/移除。
- 低电量 Windows Toast、定时刷新、诊断报告、设备显隐/改名/排序。
- 市场索引 SHA-256、id/match 校验、Gitee/GitHub 回退。

### 安全与稳定性

- 所有插件 Web 路由接入 `connection.requestRejection`；未认证或 Host/Origin 不受信任时直接拒绝。
- adapter 沙箱使用沙箱内部 `defineAdapter`/`console`，`io` 通过 JSON 桥传递，不把宿主函数交给适配器。
- daemon stdin 错误处理、RPC 超时、HID session 超时关闭。
- 轮询快照原子发布、pending refresh、beta builtIn 全量判断。
- 市场流式限长、targetFile 去冲突、minPlugin 校验。

### 文档与测试

- README 安装、首次使用、无设备处理、许可说明。
- 官方 bundle 资源：中英 locale、单图详情页（`docs/DETAIL.md` / `docs/DETAIL.zh.md`）、`docs/preview.svg`、图标和平台声明。
- `npm run test:js`：11 个测试；`cargo test`：8 个测试；11 个 factory adapter 静态校验。
- 独立 npm 安装与 sidecar ping 验收。

### 已知限制

- Fast Pair、Phone Link、GATT Battery Service 未在本机真机验证。
- 只有 3 台 stable 设备完成本机验证；其余仍为 beta/experimental。
- Windows 专属；无代码签名；通知归属显示为 DeepSeek Harness。
