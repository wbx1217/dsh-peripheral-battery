# 截图与使用 GIF 制作

目标：给 README / 官方市场条目提供 3–5 张真实界面截图，以及一段 8–12 秒的静音 GIF。不要做 mock UI。

## 当前进度

已有 4 张，已接入 README：

- `docs/images/onboarding.png`
- `docs/images/device-list.png`
- `docs/images/settings-market.png`
- `docs/images/bottom-bar.png`

GIF 暂不作为 0.1.0 的发布必需项；如后续需要，再按下面的流程补 `docs/usage.gif`。可选补充：无设备/诊断截图。

## 建议拍什么

按这个顺序，最少 3 张：

1. **设置页设备列表**：3 台设备、电量、状态、排序/改名入口；
2. **适配器市场**：搜索型号、预览、安装按钮；
3. **无设备/诊断**：空状态或复制诊断里的数据源原因；
4. **首次使用引导**：低电量提醒/后台检查开关；
5. **底栏**：正常 3 台 + 折叠 `+N` 或空状态。

GIF 建议拍：

- 打开设置 → 看到设备；
- 切到适配器市场 → 搜索一个型号；
- 返回底栏刷新；
- 全程 8–12 秒，不要录鼠标乱晃。

## 截图

1. 打开真实的 DSH Web 页面（不是 mock）。
2. `Win + Shift + S` → 矩形截图。
3. 保存到 `docs/images/`：
   - `settings-devices.png`
   - `adapter-market.png`
   - `no-device-diagnostics.png`
   - `onboarding.png`
   - `bottom-bar.png`
4. 建议宽度 1200–1600 px，裁剪掉浏览器书签栏/无关窗口。
5. 截图前隐藏真实设备序列号、用户名、路径等敏感信息；设备名可保留。

## GIF

最简单：

- Windows 11 截图工具：`Win + Shift + S` → 摄像机图标 → 录制约 10 秒；
- 或 Xbox Game Bar：`Win + G` → Capture；
- 或 [ScreenToGif](https://www.screentogif.com/) 直接录 GIF（推荐，能裁剪/删帧）。

如果录成 MP4，用 ffmpeg 转 GIF：

```powershell
ffmpeg -i usage.mp4 -vf "fps=12,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 docs/usage.gif
```

目标：**宽度约 1000 px、12–15 fps、< 5 MB**。太大就降宽度或删帧。

## README 里怎么放

文件准备好后，在 README 的「使用」附近加：

```markdown
![设置页设备列表](docs/images/settings-devices.png)

![适配器市场](docs/images/adapter-market.png)

![无设备时的诊断](docs/images/no-device-diagnostics.png)

![使用流程](docs/usage.gif)
```

官方市场详情页仍使用 `docs/preview.svg`（单图、无文字），不要拿 GIF 替换 `meta.detail` 的图片。

## 检查

- 图片/ GIF 在 GitHub 和 Gitee 都能加载；
- 浅色/深色主题下都能看清；
- 没有 token、用户名、完整本地路径；
- `npm pack --dry-run` 里包含 `docs/images/*` 和 `docs/usage.gif`；
- 包体积不要因为 GIF 失控（建议总附件 < 10 MB）。
