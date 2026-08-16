# 手机独立版 BBox 标注工具

本项目只有 `index.html`、`style.css`、`app.js` 和本说明文件，不使用 Flask、Python、React 或后端服务。图片、query、bbox、完成状态和当前位置全部存入手机浏览器 IndexedDB。

## 1. 部署网页

### 方案 A：GitHub Pages

1. 登录 GitHub，创建一个新仓库，例如 `mobile-bbox-tool`。
2. 把以下四个文件上传到仓库根目录：

```text
index.html
style.css
app.js
README.md
```

3. 打开仓库的 `Settings` → `Pages`。
4. 在 `Build and deployment` 中选择 `Deploy from a branch`。
5. Branch 选择 `main`，目录选择 `/ (root)`，点击 `Save`。
6. 等待 GitHub 显示站点地址，通常是：

```text
https://你的用户名.github.io/mobile-bbox-tool/
```

7. 用手机浏览器打开该地址并加入书签或添加到主屏幕。

GitHub 只托管这四个页面文件。用户在网页中选择的数据包不会上传到 GitHub，导入数据和标注结果仍保存在手机本地。

### 方案 B：其他静态托管

也可以把四个文件部署到 Cloudflare Pages、Netlify、Vercel 静态站点、对象存储静态网站或单位已有的 HTTPS 网站。保持四个文件位于同一目录即可，不需要构建命令。

推荐 HTTPS 部署，因为手机系统文件分享通常要求安全网页。电脑完成一次部署后可以关机，手机以后通过 Wi-Fi 或移动网络访问。

### 方案 C：直接在手机打开

可以把四个文件传到手机并打开 `index.html`，但部分手机浏览器会限制 `file://` 页面的 IndexedDB、文件夹选择或 Web Share，因此只适合临时测试。

## 2. 准备项目数据

query JSON 文件可以使用任何文件名，例如：

```text
my_queries.json
queries_rgb.json
任务列表.json
```

工具根据 JSON 内容识别 query 文件，不根据文件名识别。JSON 顶层必须是 query ID 对象，每条记录至少包含 `visible`，以及 `query` 或 `query_zh`：

```json
{
  "000002_001": {
    "visible": "任意目录/visible/000002.png",
    "infrared": "任意目录/infrared/000002.png",
    "depth": "任意目录/depth/000002.png",
    "query": "Red promotional sign with food imagery",
    "query_zh": "带有食品图案的红色宣传牌"
  }
}
```

图片文件夹也可以使用任何名称。工具按以下顺序识别 visible 图片：

1. 图片实际路径与 JSON 的 `visible` 路径相同。
2. 图片实际路径以 JSON 路径结尾，例如 ZIP 外面多了一层项目目录。
3. 按图片文件名匹配，例如都叫 `000002.png`。

如果不同文件夹中存在多个同名图片，而 JSON 路径也无法区分，工具会停止并提示保留文件夹结构，避免标错图片。

## 3. 导入数据

支持三种方式。

### ZIP 导入

ZIP 名称和内部文件夹名称均不固定，例如：

```text
任意项目名.zip
├── 任意名称.json
└── 任意图片目录/
    ├── 000002.png
    └── 000003.jpg
```

点击“选择数据文件”并选择 ZIP，网页会自动寻找符合结构的 JSON 和被 `visible` 引用的图片。ZIP 支持 Store（仅存储）和常见 Deflate 压缩；不支持 ZIP64 或加密 ZIP。

### 项目文件夹导入

将 JSON 和图片文件夹放在同一个项目根目录中，点击“选择项目文件夹”，选择该根目录。网页会扫描其中的 JSON 和图片。

### 拖拽导入

在支持拖拽的浏览器中，把 ZIP、项目文件夹，或者 JSON 与图片一起拖入页面顶部虚线区域。手机浏览器通常更适合使用选择按钮。

导入新项目会替换当前项目。已有项目应先一键导出。

## 4. 标注

1. 导入完成后自动显示第一个未标注 query。
2. 在图片上按住并拖动，松开后生成 bbox。鼠标也可使用。
3. 点击“保存并下一条”。bbox 保存为原图归一化坐标。
4. 同一 query ID 是 IndexedDB 唯一键。再次保存会覆盖旧 bbox，不会产生第二条结果。
5. 顶部下拉框可以打开任何 query；带 `✓` 的是已保存项，可重新框选并覆盖。
6. 打开已完成 query 后点击“删除当前标注”，会删除 bbox、完成状态和缓存的带框图片，该 query 重新进入待标注状态。

关闭网页后重新打开，会按 JSON 原始顺序恢复项目、完成进度和当前位置。不要使用无痕模式，也不要清除该站点的浏览数据。

## 5. 导出与分享

点击“一键导出”，页面会显示实时生成进度并输出：

```text
queries_result.json
marked_images.zip
└── marked_images/
    ├── 000002_001_bbox.png
    └── 000003_001_bbox.png
```

结果按照原 query JSON 顺序生成，并以 query ID 为唯一对象键，只保留每个 query 最新的 bbox。

导出后可以选择“分享 JSON”“分享图片”或“全部分享”。支持 Web Share API 时会打开手机系统分享面板，可选择微信、文件管理器或其他应用；具体应用由手机系统决定。不支持文件分享时点击下载按钮。

## 6. 手机存储注意事项

- 导入数据和进度只保存在当前浏览器、当前域名的 IndexedDB 中。
- 更换浏览器或网站域名不会自动迁移项目。
- 不要清理浏览器网站数据。
- 大型项目受手机剩余空间和浏览器存储配额限制。
- 导出 ZIP 会额外占用内存，建议分项目处理超大型数据集。
- 页面部署后电脑无需在线，但重新打开网页仍需要移动网络或 Wi-Fi 访问静态站点。
