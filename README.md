# leafletdemo01

一个基于 **Leaflet + 高德地图** 的地图 Demo，当前已实现：

- 高德街道图 / 卫星图 / 路网图图层切换（**切卫星自动叠加路网标注**）
- **实时路况图层**（高德 traffic tile，带颜色图例、自动刷新）
- **鹰眼 MiniMap**（右下角，支持折叠）+ **全屏按钮** + **比例尺**
- **当前定位**（WGS-84 自动纠偏到 GCJ-02，带精度圈）
- **测距 / 测面积工具**（顶部工具栏，实时显示分段/总距离/面积/周长）
- POI 搜索（含输入联想、分类筛选、结果列表、标记展示、**聚合**、**分页**、**详情抽屉**、**视野内/城市搜索**、**历史/收藏**）
- 轨迹记录
- **路径规划**（驾车 / 步行 / 骑行 / 公交，高德 Direction API + polyline 绘制，公交支持多方案列表与分段配色）
- **地图右键菜单**（这是哪儿、从这里出发 / 到这里去、复制坐标、以此为中心）
- **Vite + ES Module** 工程化（`.env` 环境变量，依赖从 `node_modules` 按需打包）

---

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置高德 Web 服务 Key
cp .env.example .env.local
# 编辑 .env.local 把 VITE_AMAP_WEB_KEY 替换为你自己的 Key
# 申请地址：https://console.amap.com/dev/key/app （服务平台请选择"Web服务"）

# 3. 启动开发服务器（Vite）
npm run dev          # http://localhost:5173

# 4. 生产构建
npm run build        # 产物在 dist/
npm run preview      # 预览生产构建产物
```

### Key 读取优先级（从高到低）

1. `import.meta.env.VITE_AMAP_WEB_KEY` —— Vite 环境变量（**推荐**，写在 `.env.local`，已 gitignore）
2. `window.__APP_CONFIG__.AMAP_WEB_KEY` —— 兼容旧的 `src/config.local.js` 脚本注入方式
3. `localStorage.getItem('AMAP_WEB_KEY')` —— 浏览器 Console 临时设置
4. 占位符 `YOUR_AMAP_WEB_KEY_HERE` —— 未配置时会有友好提示

> 💡 **一条命令临时配置**（浏览器 DevTools Console）：
> ```js
> localStorage.setItem('AMAP_WEB_KEY', '你的Key'); location.reload();
> ```

---

## 📋 To-Do List / Roadmap

以下是后续可扩展的功能清单，按模块归类。工作量：⭐ 轻量 / ⭐⭐ 中等 / ⭐⭐⭐ 较大。

### 🗺️ 地图交互类（体验增强）

- [x] **当前定位按钮** —— 基于 `navigator.geolocation`，自动纠偏到 GCJ-02，含精度圈和失败提示 ⭐
- [x] **右键/长按获取坐标** —— 菜单显示经纬度 + 一键复制 + 自动逆地理编码为地址（背景行展示）+ "这是哪儿"弹窗 ⭐
- [x] **测距 / 测面积工具** —— 顶部工具栏切换模式，实时展示分段距离/总距离或面积+周长，双击/Enter 结束，Esc 取消 ⭐⭐
- [x] **比例尺 + 鹰眼（MiniMap）** —— 比例尺在左下；右下手写鹰眼图（红框显示主图视野范围，支持折叠）⭐
- [x] **全屏按钮** —— Leaflet.fullscreen 插件，左上角一键进入/退出全屏 ⭐
- [x] **POI 聚合** —— Leaflet.markercluster，按数量分四档上色（蓝/橙/红），点击自动缩放，18 级以上不聚合 ⭐
- [x] **高德路况图层开关** —— 右上图层控件勾选 🚦 实时路况，带颜色图例（畅通/缓行/拥堵/严重），每 2 分钟自动刷新 ⭐
- [x] **卫星图 + 路网叠加** —— 切换到卫星图时自动叠加"路网标注"，图层控件展开显示 ⭐

### 🔍 搜索 / POI 相关

- [x] **搜索结果分页** —— 每页 20 条，底部上一页/下一页 + 总数显示 ⭐
- [x] **"在当前可视范围内搜索"按钮** —— `📍 视野内`按钮使用 `/place/polygon` 传地图视野四角坐标 ⭐
- [x] **城市切换下拉** —— 15 个热门城市 + `✏️ 自定义…` 输入任意城市；城市模式用 `citylimit=true`，解决"多抓鱼"被附近偏好压制的问题 ⭐
- [x] **POI 详情抽屉** —— 点击标记/列表项，右侧抽屉展示照片（灯箱）、电话（可拨打）、评分/人均、营业时间、地址、经纬度（可复制），并可一键设为起点/终点 ⭐⭐
- [x] **搜索历史 / 收藏** —— `localStorage` 持久化；输入框聚焦且为空时下拉展示⭐收藏 + 🕑最近搜索，一键收藏/清空 ⭐
- [x] **联想项图标区分** —— 按 `typecode` 区分 🏢 POI / 🚇 地铁 / 🚌 公交 / 📍 地名 / 🛣️ 道路，带不同颜色小气泡 ⭐

### 🛣️ 路线 / 导航

- [x] **驾车 / 步行 / 骑行路径规划** —— 高德 Direction API + polyline 绘制 ⭐⭐
- [x] **公交路径规划** —— `/v3/direction/transit/integrated`，支持跨城（city / cityd）；返回多个换乘方案，可点选方案并分段绘制（步行灰虚线 / 公交蓝 / 地铁绿 / 火车紫）⭐⭐
- [x] **"从这里出发 / 到这里去"右键菜单** —— 与路径规划配套 ⭐（含逆地理编码补地址名、复制坐标、以此为中心）
- [ ] **轨迹回放** —— 已有 `trackPoints`，加一个按时间戳回放的播放器 ⭐⭐
- [ ] **轨迹导出 / 导入 GeoJSON / GPX** ⭐

### 🎨 样式 / 渲染

- [ ] **深色模式切换** —— 切图层 URL + 反色 CSS filter ⭐
- [ ] **自定义 POI 图标** —— 按分类使用不同 emoji / icon ⭐
- [ ] **热力图图层** —— Leaflet.heat，展示轨迹密度或 POI 密度 ⭐
- [ ] **Canvas 渲染性能压测** —— 已开 `preferCanvas: true`，加一个"撒 5000 个点"按钮验证 ⭐

### 🧰 工程化 / 代码质量

- [x] **拆分模块** —— `config.js` / `utils/coord.js` / `utils/dom.js` / `utils/storage.js` 独立 ES Module，`main.js` 通过 import 组合 ⭐⭐
- [x] **引入 Vite** —— 开发时热更新；构建时 Leaflet 及插件按需打包；`AMAP_WEB_KEY` 迁移到 `import.meta.env.VITE_AMAP_WEB_KEY`（`.env.local`）⭐⭐
- [ ] **TypeScript 化** ⭐⭐⭐
- [ ] **统一 fetch 封装 + 错误 Toast 组件** —— 现在"联想失败"是静默的 ⭐
- [ ] **CSS 抽离** —— `index.html` 内联样式 → `src/style.css` ⭐
- [ ] **ESLint + Prettier 配置** ⭐
- [ ] **Key 有效性自检** —— 启动时请求一次最小 API，失败则弹提示 ⭐

### 🔒 安全 / 健壮性

- [ ] **请求节流 / 并发控制** —— 联想有防抖，但 POI 列表频繁点击仍会抖 ⭐
- [ ] **Key 错误码专属提示** —— 识别 `CUQPS_HAS_EXCEEDED_THE_LIMIT`、`INVALID_USER_KEY` 等给不同文案 ⭐
- [ ] **AbortController 管理升级** —— 目前只有联想接口有 abort，POI 搜索没有 ⭐

---

## 📁 项目结构

```
leafletdemo01/
├── index.html              # 入口 HTML（Vite 通过 <script type="module"> 加载 main.js）
├── package.json            # 依赖 + 脚本（dev / build / preview）
├── vite.config.js          # Vite 配置（分包、envPrefix 等）
├── .env.example            # 环境变量模板（提交到 Git）
├── .env.local              # 实际生效的环境变量（已 gitignore）
├── .gitignore
├── README.md
└── src/
    ├── main.js             # 业务主入口（import 各模块；按功能分块：地图初始化 / 定位 / POI / 路径规划 / 测量 / 鹰眼 ...）
    ├── config.js           # 应用配置 & 常量：AMAP_WEB_KEY、初始坐标、瓦片 URL、POI 常量等
    ├── utils/
    │   ├── coord.js        # WGS-84 ↔ GCJ-02 坐标系转换（纯函数）
    │   ├── dom.js          # escapeHtml 等 DOM / 文本小工具
    │   └── storage.js      # 搜索历史 & 收藏的 localStorage 读写
    ├── config.sample.js    # [兼容遗留] 旧的脚本式配置模板
    └── config.local.js     # [兼容遗留] 旧的脚本式本地配置（已 gitignore，可删）
```

### 模块依赖关系

```
main.js
  ├─▶ config.js          （纯常量）
  ├─▶ utils/coord.js     （纯函数，零依赖）
  ├─▶ utils/dom.js       （纯函数，零依赖）
  └─▶ utils/storage.js ─▶ config.js （读取存储 key 常量）
```

> **为什么没有把 `map.js` / `poi.js` / `track.js` 等业务层全拆出来？**  
> 这些模块之间存在大量跨模块状态（`map` 实例、`poiMarkerMap`、`trackPoints`、`measureMode` 等）。
> 一次性激进拆分需要重写成依赖注入或单例模式，复杂度反而飙升、回归风险大。
> 当前采用渐进式：**先把零耦合的公共基础（配置 / 坐标 / 工具 / 存储）抽干净**，
> 业务层保留在 `main.js` 内部并用注释清晰分块（1-20 号模块）。
> 后续如需继续拆分，可以以此基础逐个模块外迁。
