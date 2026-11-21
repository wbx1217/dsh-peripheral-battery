# 适配器市场（社区索引）

插件支持从一个静态 JSON 索引搜索、预览、安装社区适配器。没有中心服务器：索引和适配器文件可以放在 GitHub Pages、GitHub raw、任意静态 HTTPS 站点，或本地 `file:` 目录用于测试。

## 使用

### 设置页面板

1. **设置 → 外设电量 → 适配器市场**（索引源固定，不在页面展示）；
2. 搜索框按 **索引名 / 型号 / 适配器 ID** 实时过滤（250ms 防抖，不区分大小写），不需要 VID/PID；
3. 结果每页 6 条，翻页不增长页面高度；客户端缓存 5 分钟，右上「刷新」按钮强制重新拉取；
4. 点「查看」打开结构化弹窗：ID、型号、匹配、作者、状态、文件、SHA-256、说明和完整源码；
5. 点「安装」→「确认安装」写入并热加载；已安装条目可「移除」；真机验证通过且插件已提供的条目只读，安装会被拒绝；
6. 「新设备」扫描到未适配设备后，会按 VID/PID 自动查询市场匹配；有匹配可直接「查看/安装」，不需要用户再手搜；
7. 已安装条目的详情里有「复制验证报告」，用于 experimental → community → verified 晋级。

### agent 工具

- 「搜索一下适配器市场里的 ATK」→ `battery_market({ action: "search", query: "ATK" })`
- 「看看这个适配器的源码」→ `battery_market({ action: "preview", id: "…" })`
- 确认后「安装它」→ `battery_market({ action: "install", id: "…", confirm: true })`
- `battery_market({ action: "remove", id: "…" })` 可卸载市场安装的适配器。

安装会写入用户适配器目录并热加载，**不会覆盖出厂适配器**；真机验证通过且插件已提供的条目会标记为「真机验证」，无需安装。

## 索引格式

```json
{
  "version": 1,
  "updatedAt": "2026-11-20T00:00:00Z",
  "adapters": [
    {
      "id": "atk-a9-plus",
      "name": "ATK A9 Plus",
      "model": "ATK A9 Plus",
      "connection": ["2.4G", "NearLink"],
      "kind": "mouse",
      "transport": "2.4G · 星闪",
      "match": {
        "vid": "373B",
        "pid": "1115",
        "usagePage": "FF02"
      },
      "file": "adapters/atk-a9-plus.js",
      "sha256": "0123…（64 位十六进制）",
      "author": "wbx",
      "status": "verified",
      "notes": "真机验证 100% / 充电",
      "minPlugin": "0.2.0"
    }
  ]
}
```

- `file` 相对于索引 URL 解析；
- `id` 是适配器技术标识（安装/URL/去重用）；`model` 是产品型号，用于展示和搜索，两者不是一回事；
- `connection` 是连接方式标签（最多 4 个），如 `["2.4G"]`、`["2.4G", "NearLink"]`、`["蓝牙"]`；
- `sha256` 是适配器源码文件的 SHA-256（小写）；
- `match` 必须与源码 `defineAdapter({ match })` 完全一致，否则安装会被拒绝；
- `id` 必须与源码 `defineAdapter({ id })` 一致；
- 单个源码文件最大 64 KiB，索引最大 512 KiB。

## 托管

最小做法：

1. 建一个公开仓库，例如 `peripheral-battery-adapters`；
2. 根目录放 `index.json`，适配器放 `adapters/*.js`；
3. 用 GitHub Pages 或 `raw.githubusercontent.com` 提供 URL；
4. 默认索引地址已内置；自建索引可通过 `battery_config({ marketUrl })` 指定。

上传流程建议用 PR：

- CI 跑 `node --check`、`defineAdapter` 结构校验、`sha256` 是否匹配；
- 维护者审阅源码后合并；
- 索引里用 `status` 标记：`verified`（维护者真机验证）、`community`（社区提交未复验）。

## 网络与镜像

默认索引会按顺序尝试：

1. GitHub Pages；
2. Gitee 镜像（`gitee.com/yfrm/dsh-peripheral-battery-adapters`）；
3. `cdn.jsdelivr.net`；
4. `fastly.jsdelivr.net`；
5. GitHub raw。

任一可达即可搜索/安装，适配器文件也从同一镜像取。自定义索引 URL 不做回退。

索引请求 4 秒超时；`preview`/`install` 下载源码失败时，会按同一 `file` 路径依次重试各镜像，并对每个候选重新校验 SHA-256 和 `id/match`。

全部不可达时：

- 已安装适配器和出厂适配器仍可用，不受影响；
- 可把索引改到 Gitee 等国内可达的镜像；
- 或让 agent 用 `battery_save_adapter` 直接写入适配器源码。

## 安全模型

- 安装前必须 `preview` 展示完整源码；`install` 必须显式 `confirm: true`；
- 下载后校验 SHA-256、源码 id/match 与索引一致；
- 只写用户适配器目录，出厂文件名和出厂适配器不可覆盖；
- 适配器仍然拥有 HID 读写能力（`node:vm` 不是安全边界），所以索引应保持策展、人工审核。

## 限制

- 当前上传走 PR；设置页提供本地搜索/预览/安装 UI，agent 也可用 `battery_market`；
- 没有账号、评分、举报或自动审核；这些属于后续中心化市场的工作；
- 索引缓存 5 分钟，`preview`/`install` 会重新拉取并校验。
