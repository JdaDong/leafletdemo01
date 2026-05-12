/**
 * Leaflet + 高德地图 示例 —— 业务主入口
 *
 * 已通过 Vite 构建，本文件是一个标准的 ES Module。
 * 所有依赖通过 import 声明在顶部：
 *   - leaflet 及其两个插件（markercluster、fullscreen）的 CSS 与 JS
 *   - 项目内部拆出的模块：config / utils
 *
 * 高德地图瓦片服务说明：
 *   - 矢量地图（含路网+标注）：
 *     https://webrd0{1-4}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}
 *   - 卫星影像：
 *     https://webst0{1-4}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}
 *   - 路网标注（叠加在卫星影像上）：
 *     https://webst0{1-4}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}
 *
 * 注意：高德瓦片使用的是 GCJ-02 坐标系（火星坐标系），
 *      如果定位数据来自 WGS-84（GPS），需要做坐标系纠偏（见 utils/coord.js）。
 */

// ========== 第三方依赖（Vite 会从 node_modules 打包） ==========
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';

import 'leaflet-fullscreen';
import 'leaflet-fullscreen/dist/leaflet.fullscreen.css';

// 热力图插件（leaflet.heat），注册为 L.heatLayer
import 'leaflet.heat';

// 蚂蚁线插件（leaflet-ant-path），提供 L.polyline.antPath
import { antPath } from 'leaflet-ant-path';

// 绘制工具（leaflet-geoman），提供 map.pm.*（画多边形/圆/矩形/线/点/编辑）
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';

// turf.js 几何分析（点-面-线计算、缓冲区、面积、距离等）
import * as turf from '@turf/turf';

// 时间轴播放（leaflet-timedimension），提供 L.TimeDimension / L.Control.TimeDimension
import 'leaflet-timedimension/dist/leaflet.timedimension.control.css';
import 'leaflet-timedimension';

// 暴露到 window 是为了兼容本文件内部旧代码中 `L.markerClusterGroup`、`L.Control.extend` 等直接访问
// （ES module 下 import L 就是 leaflet 的 L 本身，以下赋值只是让你在 DevTools 里也能用 window.L 调试）
window.L = L;

// ========== 项目内部模块 ==========
import {
    AMAP_WEB_KEY,
    IS_KEY_CONFIGURED,
    INITIAL_CENTER,
    INITIAL_ZOOM,
    POI_PAGE_SIZE,
    AMAP_TILE_URLS,
} from './config.js';
import { wgs84ToGcj02, CoordTransform } from './utils/coord.js';
import { escapeHtml } from './utils/dom.js';
import {
    loadHistory, addSearchHistory, clearHistory,
    loadFavorites, isFavorite, toggleFavorite,
} from './utils/storage.js';

// 1. 初始化地图（中心点：上海 · 人民广场，坐标为 GCJ-02）
const map = L.map('map', {
    preferCanvas: true,
    center: INITIAL_CENTER,
    zoom: INITIAL_ZOOM,
    zoomControl: true,
    attributionControl: true,
    // 全屏按钮（由 Leaflet.fullscreen 插件提供）
    fullscreenControl: true,
    fullscreenControlOptions: {
        position: 'topleft',
        title: '进入全屏',
        titleCancel: '退出全屏'
    }
});

// 2. 高德-矢量地图图层
const gaodeNormal = L.tileLayer(
    AMAP_TILE_URLS.vector,
    {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        minZoom: 3,
        attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>'
    }
);

// 3. 高德-卫星影像图层
const gaodeSatellite = L.tileLayer(
    AMAP_TILE_URLS.satellite,
    {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        minZoom: 3,
        attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>'
    }
);

// 4. 高德-路网标注图层（可叠加在卫星图上）
const gaodeRoadNet = L.tileLayer(
    AMAP_TILE_URLS.roadNet,
    {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        minZoom: 3,
        attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>'
    }
);

// 4.1 高德-实时路况图层（官方 traffic tile）
const gaodeTraffic = L.tileLayer(
    AMAP_TILE_URLS.traffic,
    {
        time: () => Math.floor(Date.now() / 60000), // 每分钟变一次缓存 key
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        minZoom: 3,
        opacity: 0.85,
        attribution: '&copy; 高德路况'
    }
);
// 每 2 分钟自动刷新一次路况瓦片（redraw 让 tile URL 重新求值）
setInterval(() => {
    if (map.hasLayer(gaodeTraffic)) gaodeTraffic.redraw();
}, 2 * 60 * 1000);

// 5. 默认加载矢量地图
gaodeNormal.addTo(map);

// 6. 图层控制（右上角切换按钮）
// 6.0 POI 热力图层（leaflet.heat）——数据源为当前 POI 搜索结果
//   - radius:  每个热点的像素半径
//   - blur:    边缘模糊度（越大越柔和）
//   - maxZoom: 超过该缩放级别后不再扩散
//   - gradient: 低 -> 高 的颜色映射
const poiHeatLayer = L.heatLayer([], {
    radius: 28,
    blur: 22,
    maxZoom: 17,
    minOpacity: 0.25,
    gradient: {
        0.2: '#2E7DE8',   // 蓝
        0.4: '#43A047',   // 绿
        0.6: '#FDD835',   // 黄
        0.8: '#FB8C00',   // 橙
        1.0: '#E53935'    // 红
    }
});

const baseLayers = {
    '🗺️ 高德-矢量': gaodeNormal,
    '🛰️ 高德-卫星': gaodeSatellite
};
const overlayLayers = {
    '🛣️ 路网标注（配合卫星图）': gaodeRoadNet,
    '🚦 实时路况': gaodeTraffic,
    '🔥 POI 热力图': poiHeatLayer
};
L.control.layers(baseLayers, overlayLayers, { position: 'bottomleft', collapsed: true }).addTo(map);

// 6.1 切到卫星图时，自动叠加路网标注；切回矢量图时自动移除（避免路网出现两次）
map.on('baselayerchange', (e) => {
    if (e.layer === gaodeSatellite) {
        if (!map.hasLayer(gaodeRoadNet)) gaodeRoadNet.addTo(map);
    } else if (e.layer === gaodeNormal) {
        if (map.hasLayer(gaodeRoadNet)) map.removeLayer(gaodeRoadNet);
    }
});

// 6.2 路况图例：勾选/取消路况时显示/隐藏
const trafficLegendEl = document.getElementById('traffic-legend');
map.on('overlayadd', (e) => {
    if (e.layer === gaodeTraffic && trafficLegendEl) {
        trafficLegendEl.classList.add('active');
    }
});
map.on('overlayremove', (e) => {
    if (e.layer === gaodeTraffic && trafficLegendEl) {
        trafficLegendEl.classList.remove('active');
    }
});

// 6.3 POI 热力图：根据传入的 POI 列表刷新热点数据
//      - poi.location 格式为 "lng,lat"（GCJ-02，与高德瓦片一致，无需再转换）
//      - 第 3 个值为权重 intensity，这里给默认 0.6；有评分/权重字段可覆盖
function updatePoiHeatmap(pois) {
    if (!poiHeatLayer || typeof poiHeatLayer.setLatLngs !== 'function') return;
    const points = [];
    (pois || []).forEach((poi) => {
        if (!poi || !poi.location) return;
        const [lngStr, latStr] = String(poi.location).split(',');
        const lng = parseFloat(lngStr);
        const lat = parseFloat(latStr);
        if (isNaN(lng) || isNaN(lat)) return;
        // [lat, lng, intensity]
        points.push([lat, lng, 0.6]);
    });
    poiHeatLayer.setLatLngs(points);
}

// 6.4 热力图勾选 / 取消时：若当前没有数据，给个温和的使用提示
map.on('overlayadd', (e) => {
    if (e.layer === poiHeatLayer) {
        // 如果还没有 POI 结果，提示用户先搜索
        if (!Array.isArray(poiLastPois) || poiLastPois.length === 0) {
            const tipEl = document.createElement('div');
            tipEl.style.cssText = 'position:absolute;left:50%;top:60px;transform:translateX(-50%);' +
                'background:rgba(0,0,0,0.78);color:#fff;padding:8px 14px;border-radius:4px;' +
                'font-size:13px;z-index:2000;pointer-events:none;';
            tipEl.textContent = '🔥 热力图已开启，请先进行 POI 搜索以填充热点数据';
            document.body.appendChild(tipEl);
            setTimeout(() => tipEl.remove(), 2600);
        } else {
            // 已有结果 -> 用最新一次的 POI 列表刷新（以防切换过图层数据被清空）
            updatePoiHeatmap(poiLastPois);
        }
        // 同时显示"多页抓取"控件 + 按当前 zoom 自适应参数
        toggleHeatmapControlVisible(true);
        applyHeatmapOptionsByZoom();
    }
});
map.on('overlayremove', (e) => {
    if (e.layer === poiHeatLayer) {
        toggleHeatmapControlVisible(false);
    }
});

// 6.5 缩放自适应：随 zoom 变化动态调整 radius / blur
//   - 小 zoom（远）: 半径缩小（避免糊成一片）
//   - 大 zoom（近）: 半径放大（保证视觉上的"点云"效果）
function applyHeatmapOptionsByZoom() {
    if (!poiHeatLayer || typeof poiHeatLayer.setOptions !== 'function') return;
    if (!map.hasLayer(poiHeatLayer)) return;
    const z = map.getZoom();
    // 经验映射：zoom 10 -> radius 14 / blur 12； zoom 18 -> radius 40 / blur 32
    const radius = Math.round(14 + (z - 10) * 3.25);
    const blur = Math.round(12 + (z - 10) * 2.5);
    poiHeatLayer.setOptions({
        radius: Math.max(10, Math.min(50, radius)),
        blur: Math.max(8, Math.min(40, blur))
    });
}
map.on('zoomend', applyHeatmapOptionsByZoom);

// 6.6 多页批量抓取 POI 数据 -> 一次性喂给热力图
//   - 复用 searchPOI 里同一套参数构造规则（keyword / mode / city / polygon）
//   - 逐页请求，累积 pois；任一页返回空或出错即停止
//   - 独立于分页列表，不影响用户当前的浏览状态
let heatmapFetchAbort = false;
async function fetchPoiPagesForHeatmap(maxPages = 10) {
    if (!checkKey()) return;
    const keyword = (typeof poiLastKeyword === 'string' && poiLastKeyword)
        ? poiLastKeyword
        : (poiInput ? poiInput.value.trim() : '');
    if (!keyword) {
        alert('请先进行一次 POI 搜索，或在输入框填写关键字');
        return;
    }

    heatmapFetchAbort = false;
    const btn = document.getElementById('heatmap-fetch-btn');
    if (btn) { btn.disabled = true; btn.dataset.loading = '1'; btn.textContent = '抓取中 0/' + maxPages; }

    const mode = poiLastMode || 'nearby';
    const types = poiLastTypes || '';
    const center = poiLastCenter || map.getCenter();
    const city = poiLastCity || '';
    const polygon = poiLastPolygon || '';

    const allPois = [];
    try {
        for (let page = 1; page <= maxPages; page++) {
            if (heatmapFetchAbort) break;

            let url;
            if (mode === 'bbox' && polygon) {
                url = `https://restapi.amap.com/v3/place/polygon` +
                      `?key=${AMAP_WEB_KEY}` +
                      `&keywords=${encodeURIComponent(keyword)}` +
                      (types ? `&types=${types}` : '') +
                      `&polygon=${encodeURIComponent(polygon)}` +
                      `&offset=${POI_PAGE_SIZE}` +
                      `&page=${page}` +
                      `&extensions=base`;
            } else if (mode === 'city' && city) {
                url = `https://restapi.amap.com/v3/place/text` +
                      `?key=${AMAP_WEB_KEY}` +
                      `&keywords=${encodeURIComponent(keyword)}` +
                      (types ? `&types=${types}` : '') +
                      `&city=${encodeURIComponent(city)}` +
                      `&citylimit=true` +
                      `&offset=${POI_PAGE_SIZE}` +
                      `&children=0` +
                      `&page=${page}` +
                      `&extensions=base`;
            } else {
                const cityParam = city ? `&city=${encodeURIComponent(city)}` : `&city=`;
                url = `https://restapi.amap.com/v3/place/text` +
                      `?key=${AMAP_WEB_KEY}` +
                      `&keywords=${encodeURIComponent(keyword)}` +
                      (types ? `&types=${types}` : '') +
                      cityParam +
                      `&offset=${POI_PAGE_SIZE}` +
                      `&children=0` +
                      `&page=${page}` +
                      `&extensions=base` +
                      `&location=${center.lng.toFixed(6)},${center.lat.toFixed(6)}`;
            }

            const resp = await fetch(url);
            const data = await resp.json();
            if (data.status !== '1') {
                console.warn('[heatmap] 第 ' + page + ' 页请求失败：' + (data.info || 'unknown'));
                break;
            }
            const pois = Array.isArray(data.pois) ? data.pois : [];
            if (pois.length === 0) break;
            allPois.push(...pois);
            if (btn) btn.textContent = `抓取中 ${page}/${maxPages}（已 ${allPois.length} 条）`;
            // 末页：不足一页 = 已到底
            if (pois.length < POI_PAGE_SIZE) break;
        }

        // 喂给热力图（保持当前 POI 列表面板数据不变）
        updatePoiHeatmap(allPois);
        // 确保图层可见
        if (!map.hasLayer(poiHeatLayer)) poiHeatLayer.addTo(map);
        applyHeatmapOptionsByZoom();

        // 小提示
        const tip = document.createElement('div');
        tip.style.cssText = 'position:absolute;left:50%;top:60px;transform:translateX(-50%);' +
            'background:rgba(21,128,61,0.88);color:#fff;padding:8px 14px;border-radius:4px;' +
            'font-size:13px;z-index:2000;pointer-events:none;';
        tip.textContent = `🔥 已抓取 ${allPois.length} 个热点`;
        document.body.appendChild(tip);
        setTimeout(() => tip.remove(), 2200);
    } catch (err) {
        console.error('[heatmap] 抓取失败:', err);
        alert('热力图抓取失败：' + err.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            delete btn.dataset.loading;
            btn.textContent = '🔥 抓取多页';
        }
    }
}

// 6.7 热力图专属控件：开启热力图时出现在右上角，提供"抓取多页"和"关闭"按钮
const HeatmapControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control heatmap-control');
        container.style.background = '#fff';
        container.style.padding = '4px 6px';
        container.style.display = 'none'; // 默认隐藏，开启热力图后再显示
        container.style.fontSize = '13px';
        container.style.lineHeight = '20px';
        container.style.boxShadow = '0 1px 5px rgba(0,0,0,0.3)';

        container.innerHTML = `
            <div style="color:#E53935;font-weight:600;margin-bottom:4px;">🔥 热力图</div>
            <button id="heatmap-fetch-btn" style="padding:3px 8px;font-size:12px;border:1px solid #E53935;
                background:#fff;color:#E53935;border-radius:3px;cursor:pointer;">🔥 抓取多页</button>
            <label style="display:block;margin-top:4px;font-size:11px;color:#666;">
                最多抓取
                <select id="heatmap-pages-select" style="font-size:11px;">
                    <option value="3">3</option>
                    <option value="5" selected>5</option>
                    <option value="10">10</option>
                    <option value="20">20</option>
                </select>
                页
            </label>
        `;

        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);

        // 绑定事件（用 setTimeout 等 DOM 插入后再取节点）
        setTimeout(() => {
            const btn = container.querySelector('#heatmap-fetch-btn');
            const sel = container.querySelector('#heatmap-pages-select');
            if (btn) {
                btn.addEventListener('click', () => {
                    const pages = parseInt(sel.value, 10) || 5;
                    fetchPoiPagesForHeatmap(pages);
                });
            }
        }, 0);

        return container;
    }
});
const heatmapControl = new HeatmapControl();
map.addControl(heatmapControl);

function toggleHeatmapControlVisible(visible) {
    const el = document.querySelector('.heatmap-control');
    if (el) el.style.display = visible ? 'block' : 'none';
}

// 7. 添加一个示例标记点
const marker = L.marker(INITIAL_CENTER).addTo(map);
marker.bindPopup('<b>人民广场</b><br/>上海市黄浦区').openPopup();

// 8. 添加比例尺
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

// 9. 点击地图获取坐标（方便调试）
map.on('click', (e) => {
    // 测量模式下交给测量工具处理，避免弹出调试 popup 遮挡
    if (typeof measureMode !== 'undefined' && measureMode && measureMode !== 'idle') return;
    console.log('点击位置 (GCJ-02):', e.latlng);
    L.popup()
        .setLatLng(e.latlng)
        .setContent(`经度: ${e.latlng.lng.toFixed(6)}<br/>纬度: ${e.latlng.lat.toFixed(6)}`)
        .openOn(map);
});

// ========================================================================
// 10. WGS-84 -> GCJ-02 坐标转换（已迁出到 src/utils/coord.js）
//     本文件顶部已 import { wgs84ToGcj02, CoordTransform } from './utils/coord.js'
//     旧代码中的 CoordTransform.wgs84ToGcj02(...) 调用保持不变。
// ========================================================================

// ========================================================================
// 11. 自定义"获取当前定位"控件（左上角）
// ========================================================================
let locationMarker = null;   // 定位点标记
let accuracyCircle = null;   // 精度圈

const LocateControl = L.Control.extend({
    options: { position: 'topleft' },

    onAdd: function () {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        const btn = L.DomUtil.create('a', '', container);
        btn.href = '#';
        btn.title = '获取当前定位';
        btn.innerHTML = '📍';
        btn.style.fontSize = '18px';
        btn.style.lineHeight = '30px';
        btn.style.textAlign = 'center';
        btn.style.width = '30px';
        btn.style.height = '30px';
        btn.style.display = 'block';
        btn.style.cursor = 'pointer';
        btn.style.textDecoration = 'none';

        // 阻止点击穿透到地图
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', L.DomEvent.preventDefault)
                  .on(btn, 'click', locateMe);

        return container;
    }
});
map.addControl(new LocateControl());

// 执行定位
function locateMe() {
    if (!navigator.geolocation) {
        alert('当前浏览器不支持定位功能');
        return;
    }

    // 显示加载提示
    const loadingPopup = L.popup()
        .setLatLng(map.getCenter())
        .setContent('正在获取您的位置...')
        .openOn(map);

    navigator.geolocation.getCurrentPosition(
        (position) => {
            map.closePopup(loadingPopup);

            const { latitude, longitude, accuracy } = position.coords;
            console.log('原始 WGS-84 坐标:', longitude, latitude, '精度(m):', accuracy);

            // WGS-84 转换到 GCJ-02（用于在高德瓦片上正确显示）
            const [gcjLng, gcjLat] = CoordTransform.wgs84ToGcj02(longitude, latitude);
            console.log('转换后 GCJ-02 坐标:', gcjLng, gcjLat);

            const latlng = L.latLng(gcjLat, gcjLng);

            // 清除旧的定位标记
            if (locationMarker) map.removeLayer(locationMarker);
            if (accuracyCircle) map.removeLayer(accuracyCircle);

            // 添加新的定位标记
            locationMarker = L.marker(latlng).addTo(map);
            locationMarker.bindPopup(
                `<b>您当前的位置</b><br/>` +
                `经度: ${gcjLng.toFixed(6)}<br/>` +
                `纬度: ${gcjLat.toFixed(6)}<br/>` +
                `精度: ±${accuracy.toFixed(0)} 米`
            ).openPopup();

            // 绘制精度圈
            accuracyCircle = L.circle(latlng, {
                radius: accuracy,
                color: '#1E88E5',
                fillColor: '#42A5F5',
                fillOpacity: 0.15,
                weight: 1
            }).addTo(map);

            // 平移到定位点
            map.setView(latlng, 16);
        },
        (error) => {
            map.closePopup(loadingPopup);
            let msg = '定位失败：';
            switch (error.code) {
                case error.PERMISSION_DENIED:
                    msg += '用户拒绝了定位请求'; break;
                case error.POSITION_UNAVAILABLE:
                    msg += '位置信息不可用'; break;
                case error.TIMEOUT:
                    msg += '请求超时'; break;
                default:
                    msg += error.message;
            }
            alert(msg);
            console.error(msg, error);
        },
        {
            enableHighAccuracy: true, // 高精度模式
            timeout: 10000,           // 10 秒超时
            maximumAge: 0             // 不使用缓存
        }
    );
}

// ========================================================================
// 12. 持续追踪定位（watchPosition）——随用户移动实时更新位置
// ========================================================================
let watchId = null;              // geolocation.watchPosition 返回的 id
let trackPolyline = null;        // 轨迹折线
let trackPoints = [];            // 已记录的轨迹点（GCJ-02）
let watchBtnRef = null;          // 追踪按钮 DOM 引用，用于切换图标

const WatchControl = L.Control.extend({
    options: { position: 'topleft' },

    onAdd: function () {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        const btn = L.DomUtil.create('a', '', container);
        btn.href = '#';
        btn.title = '开启持续追踪';
        btn.innerHTML = '🛰️';
        btn.style.fontSize = '16px';
        btn.style.lineHeight = '30px';
        btn.style.textAlign = 'center';
        btn.style.width = '30px';
        btn.style.height = '30px';
        btn.style.display = 'block';
        btn.style.cursor = 'pointer';
        btn.style.textDecoration = 'none';
        watchBtnRef = btn;

        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', L.DomEvent.preventDefault)
                  .on(btn, 'click', toggleWatch);

        return container;
    }
});
map.addControl(new WatchControl());

// 切换追踪状态
function toggleWatch() {
    if (watchId === null) {
        startWatch();
    } else {
        stopWatch();
    }
}

// 开启持续追踪
function startWatch() {
    if (!navigator.geolocation) {
        alert('当前浏览器不支持定位功能');
        return;
    }

    // 清空旧轨迹
    trackPoints = [];
    if (trackPolyline) {
        map.removeLayer(trackPolyline);
        trackPolyline = null;
    }

    // 创建空的轨迹折线
    trackPolyline = L.polyline([], {
        color: '#E53935',
        weight: 4,
        opacity: 0.8
    }).addTo(map);

    watchId = navigator.geolocation.watchPosition(
        (position) => {
            const { latitude, longitude, accuracy, speed } = position.coords;
            const [gcjLng, gcjLat] = CoordTransform.wgs84ToGcj02(longitude, latitude);
            const latlng = L.latLng(gcjLat, gcjLng);

            // 更新或新建定位标记
            if (locationMarker) {
                locationMarker.setLatLng(latlng);
            } else {
                locationMarker = L.marker(latlng).addTo(map);
            }

            // 更新或新建精度圈
            if (accuracyCircle) {
                accuracyCircle.setLatLng(latlng);
                accuracyCircle.setRadius(accuracy);
            } else {
                accuracyCircle = L.circle(latlng, {
                    radius: accuracy,
                    color: '#1E88E5',
                    fillColor: '#42A5F5',
                    fillOpacity: 0.15,
                    weight: 1
                }).addTo(map);
            }

            // 更新 Popup 信息
            locationMarker.bindPopup(
                `<b>追踪中...</b><br/>` +
                `经度: ${gcjLng.toFixed(6)}<br/>` +
                `纬度: ${gcjLat.toFixed(6)}<br/>` +
                `精度: ±${accuracy.toFixed(0)} 米<br/>` +
                `速度: ${speed != null ? (speed * 3.6).toFixed(1) + ' km/h' : '未知'}`
            );

            // 追加到轨迹（过滤距离过近的点，避免抖动）
            const last = trackPoints[trackPoints.length - 1];
            if (!last || map.distance(last, latlng) > 2) { // 2米以上才记录
                trackPoints.push(latlng);
                trackPolyline.setLatLngs(trackPoints);
            }

            // 首次定位自动平移并缩放
            if (trackPoints.length === 1) {
                map.setView(latlng, 17);
            } else {
                // 后续只平移，不改变缩放级别
                map.panTo(latlng, { animate: true });
            }

            console.log('[追踪]', { gcjLng, gcjLat, accuracy, speed });
        },
        (error) => {
            console.error('追踪定位失败:', error);
            alert('追踪定位失败: ' + error.message);
            stopWatch();
        },
        {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 1000 // 允许 1 秒内的缓存
        }
    );

    // 切换按钮为"停止追踪"
    if (watchBtnRef) {
        watchBtnRef.innerHTML = '🛑';
        watchBtnRef.title = '停止持续追踪';
    }
    console.log('已开启持续追踪，watchId =', watchId);
}

// 停止持续追踪
function stopWatch() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (watchBtnRef) {
        watchBtnRef.innerHTML = '🛰️';
        watchBtnRef.title = '开启持续追踪';
    }
    console.log('已停止持续追踪，共记录轨迹点:', trackPoints.length);

    // 若有轨迹，自动缩放到完整轨迹范围
    if (trackPoints.length > 1) {
        map.fitBounds(trackPolyline.getBounds(), { padding: [40, 40] });
    }
}

// ========================================================================
// 13. POI 搜索（高德 Web 服务 API - 地点搜索）
// ========================================================================
// ⚠️ AMAP_WEB_KEY 已迁出到 src/config.js，本文件顶部已 import。
//    配置方法请参考项目根目录下的 .env.example / .env.local
//    或使用浏览器 DevTools 一键临时配置：
//      localStorage.setItem('AMAP_WEB_KEY', '你的Key'); location.reload();

const poiInput = document.getElementById('poi-input');
const poiBtn = document.getElementById('poi-btn');
const poiListEl = document.getElementById('poi-list');
const poiCategoryEl = document.getElementById('poi-category');
const poiTipsEl = document.getElementById('poi-tips');
// —— 新增：城市切换、视野内搜索、历史/收藏面板 DOM ——
const poiCityEl = document.getElementById('poi-city');
const poiBboxBtn = document.getElementById('poi-bbox-btn');
const poiHistoryEl = document.getElementById('poi-history');

// 用于管理 POI 搜索结果的图层组（聚合展示 + 一键清除）
// 若 Leaflet.markercluster 插件已加载，则使用 markerClusterGroup（点击聚合展开）
// 否则降级为普通 layerGroup
const poiLayerGroup = (typeof L.markerClusterGroup === 'function')
    ? L.markerClusterGroup({
        showCoverageOnHover: true,           // 鼠标悬停聚合时显示子点覆盖范围
        zoomToBoundsOnClick: true,           // 点击聚合时自动缩放
        spiderfyOnMaxZoom: true,             // 最大缩放级别时散开
        removeOutsideVisibleBounds: true,    // 不在可视范围内的点不渲染（性能）
        disableClusteringAtZoom: 18,         // 18 级以上不聚合
        maxClusterRadius: 60,                // 聚合半径（像素），越小越少点被合并
        // 自定义聚合气泡样式（按数量上色）
        iconCreateFunction: function (cluster) {
            const count = cluster.getChildCount();
            let size = 36;
            let cls = 'marker-cluster-poi-small';
            if (count >= 100) { size = 52; cls = 'marker-cluster-poi-large'; }
            else if (count >= 10) { size = 44; cls = 'marker-cluster-poi-medium'; }
            return L.divIcon({
                html: `<div><span>${count}</span></div>`,
                className: `marker-cluster ${cls}`,
                iconSize: L.point(size, size)
            });
        }
    }).addTo(map)
    : L.layerGroup().addTo(map);

// ==== 分页状态（POI_PAGE_SIZE 已从 config.js 导入） ====
let poiCurrentPage = 1;                 // 当前页
let poiTotalCount = 0;                  // 总条数
let poiLastKeyword = '';                // 最近一次搜索的关键字（翻页复用）
let poiLastTypes = '';                  // 最近一次的分类
let poiLastCenter = null;               // 最近一次的搜索中心
let poiLastPois = [];                   // 最近一次渲染的 pois 原始数据（抽屉用）
let poiMarkerMap = new Map();           // poi.id -> marker，用于点击列表高亮/弹出
// —— 新增：搜索范围模式（翻页时复用） ——
// mode 取值：'nearby'（附近，默认，按当前城市 + location 偏好） | 'city'（指定城市，忽略 location） | 'bbox'（视野内，polygon）
let poiLastMode = 'nearby';
let poiLastCity = '';                   // 最近一次的城市（mode=city 时使用）
let poiLastPolygon = '';                // 最近一次的 polygon 字符串（mode=bbox 时使用）

// 带编号的红色圆点图标
function createPoiIcon(index) {
    return L.divIcon({
        className: 'poi-marker',
        html: `<div style="
            width: 26px; height: 26px; line-height: 26px;
            background: #E53935; color: #fff;
            border: 2px solid #fff; border-radius: 50%;
            text-align: center; font-size: 12px; font-weight: bold;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        ">${index}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13]
    });
}

// 判断 Key 是否已配置
function checkKey() {
    if (!AMAP_WEB_KEY || AMAP_WEB_KEY === 'YOUR_AMAP_WEB_KEY_HERE') {
        poiListEl.innerHTML =
            '<div class="poi-tip" style="color:#E53935;">' +
            '请先在 src/main.js 中配置 AMAP_WEB_KEY<br/>' +
            '<a href="https://console.amap.com/dev/key/app" target="_blank">点此申请</a>' +
            '</div>';
        return false;
    }
    return true;
}

// 执行 POI 搜索（支持分页；resetPage=true 表示新搜索从第 1 页开始）
// options: { mode?: 'nearby' | 'city' | 'bbox' }
//   - nearby：按 location 周边偏好（城市下拉中选择了城市时，同时传 city 提升精度）
//   - city：按城市搜索（不传 location，解决"多抓鱼"这类小众商户被范围限定搜不到的问题）
//   - bbox：按当前地图可视范围（传 polygon）
async function searchPOI(resetPage = true, options = {}) {
    const keyword = poiInput.value.trim();
    if (!keyword) {
        alert('请输入搜索关键字');
        return;
    }
    if (!checkKey()) return;

    hidePoiTips(); // 搜索时隐藏联想框
    hidePoiHistory();
    poiBtn.disabled = true;
    poiBtn.textContent = '搜索中...';
    poiListEl.innerHTML = '<div class="poi-tip">正在搜索...</div>';

    if (resetPage) {
        poiCurrentPage = 1;
        poiTotalCount = 0;
        poiLastKeyword = keyword;
        poiLastTypes = poiCategoryEl.value || '';
        poiLastCenter = map.getCenter();
        poiLastMode = options.mode || 'nearby';
        poiLastCity = poiCityEl ? (poiCityEl.value || '') : '';

        // 构造 polygon（bbox 模式）
        if (poiLastMode === 'bbox') {
            const b = map.getBounds();
            const sw = b.getSouthWest();
            const ne = b.getNorthEast();
            // 高德 polygon 要求"左上|右下"顺时针；这里用矩形四角
            // 格式：lng1,lat1;lng2,lat2;...；闭合自动处理。使用两对角点即可被视为矩形。
            poiLastPolygon =
                `${sw.lng.toFixed(6)},${ne.lat.toFixed(6)};` +   // 左上
                `${ne.lng.toFixed(6)},${ne.lat.toFixed(6)};` +   // 右上
                `${ne.lng.toFixed(6)},${sw.lat.toFixed(6)};` +   // 右下
                `${sw.lng.toFixed(6)},${sw.lat.toFixed(6)}`;     // 左下
        } else {
            poiLastPolygon = '';
        }
    }

    try {
        const center = poiLastCenter || map.getCenter();
        const types = poiLastTypes;

        // 根据 mode 组装参数
        let extraParams = '';
        if (poiLastMode === 'bbox' && poiLastPolygon) {
            // polygon 模式：使用 /place/polygon，不传 city/location
            const url = `https://restapi.amap.com/v3/place/polygon` +
                        `?key=${AMAP_WEB_KEY}` +
                        `&keywords=${encodeURIComponent(poiLastKeyword)}` +
                        (types ? `&types=${types}` : '') +
                        `&polygon=${encodeURIComponent(poiLastPolygon)}` +
                        `&offset=${POI_PAGE_SIZE}` +
                        `&page=${poiCurrentPage}` +
                        `&extensions=all`;
            await runSearchRequest(url);
        } else if (poiLastMode === 'city' && poiLastCity) {
            // 城市模式：只传 city（citylimit=true 强制在本市），不传 location
            const url = `https://restapi.amap.com/v3/place/text` +
                        `?key=${AMAP_WEB_KEY}` +
                        `&keywords=${encodeURIComponent(poiLastKeyword)}` +
                        (types ? `&types=${types}` : '') +
                        `&city=${encodeURIComponent(poiLastCity)}` +
                        `&citylimit=true` +
                        `&offset=${POI_PAGE_SIZE}` +
                        `&children=0` +
                        `&page=${poiCurrentPage}` +
                        `&extensions=all`;
            await runSearchRequest(url);
        } else {
            // nearby（默认）：传 location，若城市下拉有值也一起传（提升精度，但不限定）
            const cityParam = poiLastCity ? `&city=${encodeURIComponent(poiLastCity)}` : `&city=`;
            const url = `https://restapi.amap.com/v3/place/text` +
                        `?key=${AMAP_WEB_KEY}` +
                        `&keywords=${encodeURIComponent(poiLastKeyword)}` +
                        (types ? `&types=${types}` : '') +
                        cityParam +
                        `&offset=${POI_PAGE_SIZE}` +
                        `&children=0` +
                        `&page=${poiCurrentPage}` +
                        `&extensions=all` +
                        `&location=${center.lng.toFixed(6)},${center.lat.toFixed(6)}`;
            await runSearchRequest(url);
        }

        // 搜索成功后记录历史（仅首次搜索，翻页不记）
        if (resetPage) {
            addSearchHistory(poiLastKeyword, {
                mode: poiLastMode,
                city: poiLastCity,
                types: poiLastTypes
            });
        }
    } catch (err) {
        console.error('POI 搜索失败:', err);
        poiListEl.innerHTML = `<div class="poi-tip" style="color:#E53935;">搜索失败：${escapeHtml(err.message)}</div>`;
    } finally {
        poiBtn.disabled = false;
        poiBtn.textContent = '搜索';
    }
}

// 执行搜索请求并渲染（抽出来避免 searchPOI 主逻辑太臃肿）
async function runSearchRequest(url) {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== '1') {
        throw new Error(data.info || '搜索失败');
    }
    poiTotalCount = parseInt(data.count, 10) || 0;
    renderPOIResults(data.pois || []);
}

// 跳转到指定页
function gotoPoiPage(page) {
    const totalPages = getPoiTotalPages();
    if (page < 1 || page > totalPages) return;
    poiCurrentPage = page;
    searchPOI(false); // 不重置关键字和中心
    // 翻页时滚动列表到顶部
    poiListEl.scrollTop = 0;
}

function getPoiTotalPages() {
    if (poiTotalCount <= 0) return 1;
    // 高德 place/text 接口最多可翻到第 100 页（count 有时会很大，做一个保护）
    return Math.min(100, Math.ceil(poiTotalCount / POI_PAGE_SIZE));
}

// 渲染 POI 结果（列表 + 地图标记 + 分页器）
function renderPOIResults(pois) {
    // 清除上一次的 POI 标记
    poiLayerGroup.clearLayers();
    poiMarkerMap.clear();
    poiLastPois = pois || [];
    poiListEl.innerHTML = '';

    // 同步更新热力图数据（即使图层未开启也先缓存，勾选后立即可见）
    updatePoiHeatmap(pois);

    if (!pois || pois.length === 0) {
        poiListEl.innerHTML = '<div class="poi-tip">未找到相关地点</div>';
        return;
    }

    const bounds = [];
    // 基准序号：当前页起始序号
    const baseIndex = (poiCurrentPage - 1) * POI_PAGE_SIZE;

    pois.forEach((poi, idx) => {
        // 高德返回的 location 格式："lng,lat"（已是 GCJ-02，可直接使用）
        const [lngStr, latStr] = (poi.location || '').split(',');
        const lng = parseFloat(lngStr);
        const lat = parseFloat(latStr);
        if (isNaN(lng) || isNaN(lat)) return;

        const latlng = L.latLng(lat, lng);
        const displayIndex = baseIndex + idx + 1;
        const localIndex = idx; // 在当前页 pois 数组中的下标

        // 地图标记
        const marker = L.marker(latlng, { icon: createPoiIcon(displayIndex) })
            .bindPopup(
                `<b>${escapeHtml(poi.name)}</b><br/>` +
                `<span style="color:#888;font-size:12px;">${escapeHtml(poi.address || '')}</span><br/>` +
                `<span style="color:#888;font-size:12px;">${escapeHtml(Array.isArray(poi.tel) ? '' : (poi.tel || ''))}</span><br/>` +
                `<a href="javascript:void(0)" data-poi-idx="${localIndex}" class="popup-detail-link" style="color:#1E88E5;font-size:12px;">查看详情 →</a>`
            );
        // 点击标记 -> 打开详情抽屉
        marker.on('click', () => openPoiDrawer(poi, latlng));
        // Popup 里的"查看详情"链接
        marker.on('popupopen', (e) => {
            const link = e.popup._contentNode.querySelector('.popup-detail-link');
            if (link) {
                link.addEventListener('click', () => {
                    marker.closePopup();
                    openPoiDrawer(poi, latlng);
                });
            }
        });
        poiLayerGroup.addLayer(marker);
        poiMarkerMap.set(poi.id || `idx_${localIndex}`, marker);
        bounds.push(latlng);

        // 列表项
        const item = document.createElement('div');
        item.className = 'poi-item';
        const addr = poi.address && typeof poi.address === 'string'
            ? poi.address
            : ((poi.pname || '') + (poi.cityname || '') + (poi.adname || ''));
        item.innerHTML =
            `<div class="poi-name"><span class="poi-index">${displayIndex}</span>${escapeHtml(poi.name)}</div>` +
            `<div class="poi-addr">${escapeHtml(addr)}</div>`;

        item.addEventListener('click', () => {
            map.setView(latlng, 17);
            marker.openPopup();
            openPoiDrawer(poi, latlng);
        });

        poiListEl.appendChild(item);
    });

    // 分页器
    renderPoiPagination();

    // 自动缩放到所有结果范围（仅首次搜索或翻页时）
    if (bounds.length > 0) {
        map.fitBounds(L.latLngBounds(bounds), { padding: [60, 60], maxZoom: 16 });
    }
}

// 渲染底部分页器
function renderPoiPagination() {
    const totalPages = getPoiTotalPages();
    if (poiTotalCount <= 0) return;

    const pager = document.createElement('div');
    pager.className = 'poi-pagination';
    pager.innerHTML = `
        <button class="page-btn" data-page="prev" ${poiCurrentPage <= 1 ? 'disabled' : ''}>‹ 上一页</button>
        <span class="page-info">
            第 <b>${poiCurrentPage}</b> / ${totalPages} 页
            <span class="page-total">共 ${poiTotalCount} 条</span>
        </span>
        <button class="page-btn" data-page="next" ${poiCurrentPage >= totalPages ? 'disabled' : ''}>下一页 ›</button>
    `;
    pager.querySelector('[data-page="prev"]').addEventListener('click', () => gotoPoiPage(poiCurrentPage - 1));
    pager.querySelector('[data-page="next"]').addEventListener('click', () => gotoPoiPage(poiCurrentPage + 1));
    poiListEl.appendChild(pager);
}

// 简单的 HTML 转义，防止 POI 字段中出现特殊字符导致布局异常
// （已迁出到 src/utils/dom.js，本文件顶部已 import）

// ========================================================================
// 14. 输入联想（Inputtips）—— 输入时实时请求高德联想接口
// ========================================================================
let tipsDebounceTimer = null;        // 防抖计时器
let tipsAbortController = null;      // 用于取消上一次未完成的请求
let currentTips = [];                // 当前联想结果
let tipsHighlightIndex = -1;         // 键盘上下键高亮项索引

function hidePoiTips() {
    poiTipsEl.classList.remove('active');
    poiTipsEl.innerHTML = '';
    currentTips = [];
    tipsHighlightIndex = -1;
}

function showPoiTips(tips) {
    currentTips = tips;
    tipsHighlightIndex = -1;

    if (!tips || tips.length === 0) {
        hidePoiTips();
        return;
    }

    poiTipsEl.innerHTML = tips.map((t, i) => {
        const district = [t.district, t.address].filter(Boolean).join(' · ');
        const iconInfo = classifyTip(t); // { emoji, cls, label }
        return `<div class="poi-tip-item" data-index="${i}" title="${escapeHtml(iconInfo.label)}">
            <span class="tip-icon ${iconInfo.cls}">${iconInfo.emoji}</span>
            <span class="tip-body">
                <span class="tip-name">${escapeHtml(t.name || '')}</span>
                ${district ? `<span class="tip-district">${escapeHtml(district)}</span>` : ''}
            </span>
        </div>`;
    }).join('');
    poiTipsEl.classList.add('active');

    // 点击联想项 -> 填入输入框并直接搜索
    poiTipsEl.querySelectorAll('.poi-tip-item').forEach((el) => {
        el.addEventListener('mousedown', (e) => {
            e.preventDefault(); // 阻止 input 失焦
            const idx = parseInt(el.getAttribute('data-index'), 10);
            selectTip(idx);
        });
    });
}

// 根据联想项推断类型（POI / 地铁 / 公交 / 地名 / 道路）
//   高德 inputtips 返回字段：
//     - typecode: 多级分类编码，以 150500 开头的为地铁；150700 开头为公交站；190000 为地名；180000 为道路
//     - adcode:   若没有 location/typecode，一般是行政区/地名
//     - location: 空 -> 多为区域/地名；非空 -> 有具体坐标（POI）
function classifyTip(t) {
    const typecode = (t.typecode || '').trim();
    const hasLocation = t.location && typeof t.location === 'string' && t.location.includes(',');

    // 地铁站：typecode 以 150500 开头
    if (typecode.startsWith('150500')) {
        return { emoji: '🚇', cls: 'type-subway', label: '地铁站' };
    }
    // 公交站：typecode 以 150700 开头
    if (typecode.startsWith('150700')) {
        return { emoji: '🚌', cls: 'type-bus', label: '公交站' };
    }
    // 道路：typecode 以 180000/190301 开头
    if (typecode.startsWith('180000') || typecode.startsWith('190301')) {
        return { emoji: '🛣️', cls: 'type-road', label: '道路' };
    }
    // 地名/行政区：typecode 以 190000 开头，或没有 location
    if (typecode.startsWith('190000') || !hasLocation) {
        return { emoji: '📍', cls: 'type-place', label: '地名 / 行政区' };
    }
    // 其他：都视为 POI
    return { emoji: '🏢', cls: 'type-poi', label: '地点 (POI)' };
}

// 选中某个联想项
function selectTip(idx) {
    const tip = currentTips[idx];
    if (!tip) return;
    poiInput.value = tip.name || '';
    hidePoiTips();

    // 若联想项带有坐标，直接定位；否则触发完整搜索
    if (tip.location && typeof tip.location === 'string' && tip.location.includes(',')) {
        const [lngStr, latStr] = tip.location.split(',');
        const lng = parseFloat(lngStr);
        const lat = parseFloat(latStr);
        if (!isNaN(lng) && !isNaN(lat)) {
            // 构造一个 pois 结构复用渲染逻辑
            renderPOIResults([{
                name: tip.name,
                address: tip.address || '',
                location: tip.location,
                pname: '', cityname: tip.district || '', adname: ''
            }]);
            return;
        }
    }
    searchPOI();
}

// 请求高德联想接口
async function fetchInputtips(keyword) {
    if (!checkKey()) return;

    // 取消上一次请求
    if (tipsAbortController) tipsAbortController.abort();
    tipsAbortController = new AbortController();

    try {
        const center = map.getCenter();
        const types = poiCategoryEl.value || '';
        const city = poiCityEl ? (poiCityEl.value || '') : '';
        // city 非空时优先按城市联想（不传 location，避免被附近偏好压制）；
        // city 空时按地图中心附近联想
        const locOrCity = city
            ? `&city=${encodeURIComponent(city)}&citylimit=true`
            : `&location=${center.lng.toFixed(6)},${center.lat.toFixed(6)}`;
        const url = `https://restapi.amap.com/v3/assistant/inputtips` +
                    `?key=${AMAP_WEB_KEY}` +
                    `&keywords=${encodeURIComponent(keyword)}` +
                    (types ? `&type=${types}` : '') +
                    locOrCity +
                    `&datatype=all`;

        const resp = await fetch(url, { signal: tipsAbortController.signal });
        const data = await resp.json();

        if (data.status !== '1') {
            console.warn('联想接口返回异常:', data.info);
            hidePoiTips();
            return;
        }
        // 过滤掉 name 为空的无效条目
        const tips = (data.tips || []).filter(t => t && t.name);
        showPoiTips(tips.slice(0, 10));
    } catch (err) {
        if (err.name === 'AbortError') return;
        console.warn('联想接口请求失败:', err);
        hidePoiTips();
    }
}

// 更新联想项的键盘高亮
function updateTipsHighlight() {
    const items = poiTipsEl.querySelectorAll('.poi-tip-item');
    items.forEach((el, i) => {
        el.classList.toggle('highlight', i === tipsHighlightIndex);
    });
    // 高亮项滚动到可视区
    if (tipsHighlightIndex >= 0 && items[tipsHighlightIndex]) {
        items[tipsHighlightIndex].scrollIntoView({ block: 'nearest' });
    }
}

// 绑定事件
poiBtn.addEventListener('click', searchPOI);

// 输入 -> 防抖 300ms -> 请求联想
poiInput.addEventListener('input', () => {
    const kw = poiInput.value.trim();
    clearTimeout(tipsDebounceTimer);
    if (!kw) {
        hidePoiTips();
        // 输入变为空时，展示历史/收藏
        renderPoiHistory();
        return;
    }
    // 开始输入，隐藏历史
    hidePoiHistory();
    tipsDebounceTimer = setTimeout(() => fetchInputtips(kw), 300);
});

// 聚焦输入框且当前为空时，展示历史/收藏
poiInput.addEventListener('focus', () => {
    if (!poiInput.value.trim()) {
        renderPoiHistory();
    }
});

// 键盘事件：上下选择联想 / 回车搜索 / Esc 关闭
poiInput.addEventListener('keydown', (e) => {
    const tipsActive = poiTipsEl.classList.contains('active') && currentTips.length > 0;

    if (e.key === 'ArrowDown' && tipsActive) {
        e.preventDefault();
        tipsHighlightIndex = (tipsHighlightIndex + 1) % currentTips.length;
        updateTipsHighlight();
    } else if (e.key === 'ArrowUp' && tipsActive) {
        e.preventDefault();
        tipsHighlightIndex = (tipsHighlightIndex - 1 + currentTips.length) % currentTips.length;
        updateTipsHighlight();
    } else if (e.key === 'Enter') {
        if (tipsActive && tipsHighlightIndex >= 0) {
            e.preventDefault();
            selectTip(tipsHighlightIndex);
        } else {
            searchPOI();
        }
    } else if (e.key === 'Escape') {
        hidePoiTips();
    }
});

// 点击输入框外部，关闭联想下拉
document.addEventListener('click', (e) => {
    if (!poiInput.contains(e.target) && !poiTipsEl.contains(e.target)
        && !(poiHistoryEl && poiHistoryEl.contains(e.target))) {
        hidePoiTips();
        hidePoiHistory();
    }
});

// 分类切换时，如果输入框有内容，立即重新搜索
poiCategoryEl.addEventListener('change', () => {
    if (poiInput.value.trim()) {
        searchPOI();
    }
});

// —— 视野内搜索按钮 ——
if (poiBboxBtn) {
    poiBboxBtn.addEventListener('click', () => {
        if (!poiInput.value.trim()) {
            alert('请先输入搜索关键字，再点击"视野内"搜索');
            poiInput.focus();
            return;
        }
        searchPOI(true, { mode: 'bbox' });
    });
}

// —— 城市切换下拉 ——
if (poiCityEl) {
    poiCityEl.addEventListener('change', () => {
        const val = poiCityEl.value;

        // 自定义城市输入
        if (val === '__custom__') {
            const customCity = prompt('请输入城市名称或 adcode（如：厦门 / 0592）：');
            if (customCity && customCity.trim()) {
                const city = customCity.trim();
                // 如果下拉里没有，动态插入一个 option
                let exists = false;
                for (const opt of poiCityEl.options) {
                    if (opt.value === city) { exists = true; break; }
                }
                if (!exists) {
                    const newOpt = document.createElement('option');
                    newOpt.value = city;
                    newOpt.textContent = city;
                    // 插入到"自定义"选项之前
                    const customOpt = poiCityEl.querySelector('option[value="__custom__"]');
                    poiCityEl.insertBefore(newOpt, customOpt);
                }
                poiCityEl.value = city;
            } else {
                // 取消自定义，恢复到空值"全国"
                poiCityEl.value = '';
            }
        }

        // 城市切换后，若输入框有内容，直接按"城市模式"搜索一次（这正是解决"多抓鱼"的关键）
        if (poiInput.value.trim()) {
            searchPOI(true, { mode: poiCityEl.value ? 'city' : 'nearby' });
        }
    });
}

// ========================================================================
// 15. 路径规划（驾车 / 步行 / 骑行 / 公交）
//     高德 Direction API:
//       驾车: https://restapi.amap.com/v3/direction/driving
//       步行: https://restapi.amap.com/v3/direction/walking
//       骑行: https://restapi.amap.com/v4/direction/bicycling （注意是 v4）
//       公交: https://restapi.amap.com/v3/direction/transit/integrated （需 city，跨城需 cityd）
// ========================================================================
const routePanelEl = document.getElementById('route-panel');
const routeHeaderEl = document.getElementById('route-header');
const routeModeBtns = document.querySelectorAll('.route-mode-btn');
const routeOriginTextEl = document.getElementById('route-origin-text');
const routeDestTextEl = document.getElementById('route-destination-text');
const routeOriginClearEl = document.getElementById('route-origin-clear');
const routeDestClearEl = document.getElementById('route-destination-clear');
const routePlanBtn = document.getElementById('route-plan-btn');
const routeClearBtn = document.getElementById('route-clear-btn');
const routeSummaryEl = document.getElementById('route-summary');
const routeCitiesEl = document.getElementById('route-cities');
const routeCityInput = document.getElementById('route-city');
const routeCitydInput = document.getElementById('route-cityd');
const routeTransitsEl = document.getElementById('route-transits');
// 高级特性 DOM
const routeStrategyWrapEl = document.getElementById('route-strategy');
const routeStrategySelect = document.getElementById('route-strategy-select');
const routeWaypointsEl = document.getElementById('route-waypoints');
const addWaypointBtn = document.getElementById('add-waypoint-btn');
const routeAlternativesEl = document.getElementById('route-alternatives');

// 起/终点输入联想相关 DOM
const routeOriginInputWrap = document.getElementById('route-origin-input-wrap');
const routeOriginInput = document.getElementById('route-origin-input');
const routeOriginTipsEl = document.getElementById('route-origin-tips');
const routeDestInputWrap = document.getElementById('route-destination-input-wrap');
const routeDestInput = document.getElementById('route-destination-input');
const routeDestTipsEl = document.getElementById('route-destination-tips');

// 途经点搜索（A 方案）DOM
const waypointSearchWrap = document.getElementById('waypoint-search-wrap');
const waypointSearchInput = document.getElementById('waypoint-search-input');
const waypointSearchClear = document.getElementById('waypoint-search-clear');
const waypointSearchTipsEl = document.getElementById('waypoint-search-tips');

// 📍 "我的位置" 按钮 DOM
const routeOriginLocateBtn = document.getElementById('route-origin-locate');
const routeDestLocateBtn = document.getElementById('route-destination-locate');

// 当前状态
let routeMode = 'driving';              // driving | walking | bicycling | transit
let routeOrigin = null;                  // { lat, lng, name }
let routeDestination = null;             // { lat, lng, name }
let routeOriginMarker = null;
let routeDestMarker = null;
let routePolyline = null;                // 驾/走/骑 模式的当前主路线
let transitPolylines = [];               // 公交模式的多段线
let currentTransits = [];                // 最近一次接口返回的方案列表
let selectedTransitIndex = -1;
// --- 路径规划高级特性状态 ---
let routeWaypoints = [];                 // [{ lat, lng, name }]，最多 16 个，仅 driving 生效
let waypointMarkers = [];                // 与 routeWaypoints 一一对应的 L.Marker
let routeStrategy = '0';                 // 高德 driving strategy（字符串，便于直接拼 url）
const ROUTE_WAYPOINT_LIMIT = 16;         // 高德 driving waypoints 上限
let alternativePolylines = [];           // 多策略对比时所有候选路线（不含主路线）的弱化绘制
let alternativeData = [];                // [{ name, distance, duration, coords, color, strategyText }]
let selectedAlternativeIdx = 0;          // 当前选中的方案索引（主路线）
const ALT_COLORS = ['#1E88E5', '#FB8C00', '#43A047']; // 主线、备选 1、备选 2 的色板

// --- 轨迹动画回放（蚂蚁线 + 移动 Marker）相关状态 ---
let trackAnimCoords = [];                // 当前可回放的坐标序列 [[lat, lng], ...]
let trackAnimMarker = null;              // 沿路线移动的 marker
let trackAnimRafId = null;               // requestAnimationFrame id
let trackAnimPaused = false;             // 暂停状态
let trackAnimProgress = 0;               // 当前已走过的总距离（米）
let trackAnimTotalLen = 0;               // 整条路径的总长度（米）
let trackAnimSpeed = 200;                // 默认动画速度（米/秒，可在面板调整）
let trackAnimLastTs = 0;                 // 上一帧时间戳
let trackAnimFollowCamera = false;       // 是否开启"相机跟随"
let trackAnimTrailLine = null;           // 已走过的路径（灰色线，叠加在蚂蚁线上）
let trackAnimCoordsCum = [];             // 每个坐标点对应的累计距离，用于已走路径插值

// ============== 轨迹动画核心函数 ==============
// Haversine 距离（米），用于累加路径长度、插值推进位置
function haversineMeters(a, b) {
    const R = 6378137;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const sa = Math.sin(dLat / 2) ** 2 +
               Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) *
               Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(sa));
}

// 创建"行驶中"的图标（小汽车/小人/自行车，按路线模式切换）
function createTrackAnimIcon() {
    const emojiMap = { driving: '🚗', walking: '🚶', bicycling: '🚴' };
    const emoji = emojiMap[routeMode] || '📍';
    return L.divIcon({
        className: 'track-anim-marker',
        html: `<div style="font-size:22px;line-height:22px;text-align:center;
                filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4));">${emoji}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });
}

// 根据累计距离 progress（米）在路径上插值出 [lat, lng]
function interpolateOnPath(coords, progress) {
    if (!coords || coords.length < 2) return null;
    if (progress <= 0) return coords[0];
    let walked = 0;
    for (let i = 1; i < coords.length; i++) {
        const segLen = haversineMeters(coords[i - 1], coords[i]);
        if (walked + segLen >= progress) {
            const t = segLen === 0 ? 0 : (progress - walked) / segLen;
            const lat = coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t;
            const lng = coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t;
            return [lat, lng];
        }
        walked += segLen;
    }
    return coords[coords.length - 1];
}

// 重置轨迹动画状态（每次规划新路线后调用）
function resetTrackAnim() {
    stopTrackAnim();
    trackAnimProgress = 0;
    trackAnimTotalLen = 0;
    trackAnimCoordsCum = [0];
    for (let i = 1; i < trackAnimCoords.length; i++) {
        const seg = haversineMeters(trackAnimCoords[i - 1], trackAnimCoords[i]);
        trackAnimTotalLen += seg;
        trackAnimCoordsCum.push(trackAnimTotalLen);
    }
}

// 根据当前 progress 生成"已走过"那一段坐标序列（含最后插值点）
function buildTrailCoords(progress) {
    if (!trackAnimCoords || trackAnimCoords.length < 2 || progress <= 0) return [];
    const out = [trackAnimCoords[0]];
    for (let i = 1; i < trackAnimCoords.length; i++) {
        if (trackAnimCoordsCum[i] <= progress) {
            out.push(trackAnimCoords[i]);
        } else {
            // 走到半段，插值
            const segLen = trackAnimCoordsCum[i] - trackAnimCoordsCum[i - 1];
            const t = segLen === 0 ? 0 : (progress - trackAnimCoordsCum[i - 1]) / segLen;
            const lat = trackAnimCoords[i - 1][0] + (trackAnimCoords[i][0] - trackAnimCoords[i - 1][0]) * t;
            const lng = trackAnimCoords[i - 1][1] + (trackAnimCoords[i][1] - trackAnimCoords[i - 1][1]) * t;
            out.push([lat, lng]);
            break;
        }
    }
    return out;
}

// 更新已走路径（灰色叠加线）
function updateTrailLine(progress) {
    const trail = buildTrailCoords(progress);
    if (trail.length < 2) {
        if (trackAnimTrailLine) {
            try { map.removeLayer(trackAnimTrailLine); } catch (e) {}
            trackAnimTrailLine = null;
        }
        return;
    }
    if (!trackAnimTrailLine) {
        trackAnimTrailLine = L.polyline(trail, {
            color: '#9e9e9e',
            weight: 7,
            opacity: 0.85,
            lineJoin: 'round',
            lineCap: 'round',
            interactive: false
        }).addTo(map);
        // 压在蚂蚁线之下？实际需要盖住蚂蚁线才能"变灰"，这里提升到蚂蚁线之上
        try { trackAnimTrailLine.bringToFront(); } catch (e) {}
    } else {
        trackAnimTrailLine.setLatLngs(trail);
    }
}

// 启动/继续播放
function startTrackAnim() {
    if (!trackAnimCoords || trackAnimCoords.length < 2) return;
    if (trackAnimTotalLen <= 0) return;

    // 若已走完，从头开始
    if (trackAnimProgress >= trackAnimTotalLen) {
        trackAnimProgress = 0;
    }

    // 创建/复用 marker
    if (!trackAnimMarker) {
        const start = interpolateOnPath(trackAnimCoords, trackAnimProgress) || trackAnimCoords[0];
        trackAnimMarker = L.marker(start, {
            icon: createTrackAnimIcon(),
            zIndexOffset: 1000,
            interactive: false
        }).addTo(map);
    }

    trackAnimPaused = false;
    trackAnimLastTs = 0;
    const tick = (ts) => {
        if (trackAnimPaused) { trackAnimRafId = null; return; }
        if (!trackAnimLastTs) trackAnimLastTs = ts;
        const dt = (ts - trackAnimLastTs) / 1000; // 秒
        trackAnimLastTs = ts;

        trackAnimProgress += trackAnimSpeed * dt;
        if (trackAnimProgress >= trackAnimTotalLen) {
            trackAnimProgress = trackAnimTotalLen;
            const end = interpolateOnPath(trackAnimCoords, trackAnimProgress);
            if (end && trackAnimMarker) trackAnimMarker.setLatLng(end);
            updateTrailLine(trackAnimProgress);
            if (trackAnimFollowCamera && end) map.panTo(end, { animate: true, duration: 0.25 });
            updateTrackProgressText(100);
            updateTrackPlayBtn(false, true); // 标记完成
            trackAnimRafId = null;
            return;
        }

        const pos = interpolateOnPath(trackAnimCoords, trackAnimProgress);
        if (pos && trackAnimMarker) trackAnimMarker.setLatLng(pos);
        updateTrailLine(trackAnimProgress);
        if (trackAnimFollowCamera && pos) {
            // 使用 panTo + 关动画效果更流畅（Leaflet 会自动做插值）
            map.panTo(pos, { animate: false });
        }
        const pct = Math.min(100, (trackAnimProgress / trackAnimTotalLen) * 100);
        updateTrackProgressText(pct);

        trackAnimRafId = requestAnimationFrame(tick);
    };
    trackAnimRafId = requestAnimationFrame(tick);
    updateTrackPlayBtn(true, false);
}

// 暂停
function pauseTrackAnim() {
    trackAnimPaused = true;
    if (trackAnimRafId) {
        cancelAnimationFrame(trackAnimRafId);
        trackAnimRafId = null;
    }
    updateTrackPlayBtn(false, false);
}

// 完全停止（清除 marker + 清空 raf，用于路径清理时）
function stopTrackAnim() {
    trackAnimPaused = true;
    if (trackAnimRafId) {
        cancelAnimationFrame(trackAnimRafId);
        trackAnimRafId = null;
    }
    if (trackAnimMarker) {
        try { map.removeLayer(trackAnimMarker); } catch (e) {}
        trackAnimMarker = null;
    }
    if (trackAnimTrailLine) {
        try { map.removeLayer(trackAnimTrailLine); } catch (e) {}
        trackAnimTrailLine = null;
    }
    trackAnimLastTs = 0;
}

// 重放（从头开始）
function replayTrackAnim() {
    stopTrackAnim();
    trackAnimProgress = 0;
    startTrackAnim();
}

// 更新进度百分比文案
function updateTrackProgressText(pct) {
    const el = document.getElementById('track-progress-text');
    if (el) el.textContent = pct.toFixed(1) + '%';
}

// 更新播放按钮状态（playing 正在播放 / finished 已结束）
function updateTrackPlayBtn(playing, finished) {
    const btn = document.getElementById('track-play-btn');
    if (!btn) return;
    if (finished) { btn.textContent = '✅ 已完成'; return; }
    btn.textContent = playing ? '⏸ 暂停' : '▶️ 播放';
}

// 绑定 summary 里的播放控件事件
function bindTrackAnimControls() {
    const playBtn = document.getElementById('track-play-btn');
    const resetBtn = document.getElementById('track-reset-btn');
    const speedSel = document.getElementById('track-speed-select');
    const followCk = document.getElementById('track-follow-checkbox');
    if (playBtn) {
        playBtn.addEventListener('click', () => {
            if (trackAnimRafId) pauseTrackAnim();
            else startTrackAnim();
        });
    }
    if (resetBtn) {
        resetBtn.addEventListener('click', replayTrackAnim);
    }
    if (speedSel) {
        speedSel.addEventListener('change', (e) => {
            trackAnimSpeed = parseInt(e.target.value, 10) || 200;
        });
    }
    if (followCk) {
        followCk.checked = trackAnimFollowCamera;
        followCk.addEventListener('change', (e) => {
            trackAnimFollowCamera = !!e.target.checked;
            // 立刻聚焦一次
            if (trackAnimFollowCamera && trackAnimMarker) {
                map.panTo(trackAnimMarker.getLatLng(), { animate: true });
            }
        });
    }
}

// 起点/终点专用图标
function createRoutePointIcon(type) {
    const color = type === 'origin' ? '#43A047' : '#E53935';
    const label = type === 'origin' ? '起' : '终';
    return L.divIcon({
        className: 'route-point-marker',
        html: `<div style="
            width: 30px; height: 30px; line-height: 30px;
            background: ${color}; color: #fff;
            border: 2px solid #fff; border-radius: 50% 50% 50% 0;
            transform: rotate(-45deg);
            text-align: center; font-size: 13px; font-weight: bold;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        "><span style="display:inline-block;transform:rotate(45deg);">${label}</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 30]
    });
}

// 更新起点/终点 UI 文本
function updateRoutePointsUI() {
    if (routeOrigin) {
        routeOriginTextEl.classList.remove('empty');
        routeOriginTextEl.textContent = routeOrigin.name
            || `${routeOrigin.lng.toFixed(6)}, ${routeOrigin.lat.toFixed(6)}`;
    } else {
        routeOriginTextEl.classList.add('empty');
        routeOriginTextEl.textContent = '未选择起点（右键地图选择）';
    }
    if (routeDestination) {
        routeDestTextEl.classList.remove('empty');
        routeDestTextEl.textContent = routeDestination.name
            || `${routeDestination.lng.toFixed(6)}, ${routeDestination.lat.toFixed(6)}`;
    } else {
        routeDestTextEl.classList.add('empty');
        routeDestTextEl.textContent = '未选择终点（右键地图选择）';
    }
}

// 设置起点/终点（来自右键菜单或其它交互）
function setRouteOrigin(latlng, name) {
    routeOrigin = { lat: latlng.lat, lng: latlng.lng, name: name || '' };
    if (routeOriginMarker) map.removeLayer(routeOriginMarker);
    routeOriginMarker = L.marker(latlng, { icon: createRoutePointIcon('origin') })
        .addTo(map)
        .bindPopup(`<b>起点</b><br/>${name || ''}<br/>${latlng.lng.toFixed(6)}, ${latlng.lat.toFixed(6)}`);
    updateRoutePointsUI();
    // 如果两端都有了，自动规划
    if (routeDestination) planRoute();
}

function setRouteDestination(latlng, name) {
    routeDestination = { lat: latlng.lat, lng: latlng.lng, name: name || '' };
    if (routeDestMarker) map.removeLayer(routeDestMarker);
    routeDestMarker = L.marker(latlng, { icon: createRoutePointIcon('destination') })
        .addTo(map)
        .bindPopup(`<b>终点</b><br/>${name || ''}<br/>${latlng.lng.toFixed(6)}, ${latlng.lat.toFixed(6)}`);
    updateRoutePointsUI();
    if (routeOrigin) planRoute();
}

// ============================================================
// 📍 「我的当前位置」工具 —— 起/终点自动填入支持
// 设计：
//   - 优先 navigator.geolocation（精度高，需用户授权）
//   - 失败/拒绝 -> 降级 高德 /v3/ip 定位（精度只到城市，但不需授权）
//   - 拿到坐标后通过 reverseGeocode 反查地址作为显示名
//   - 用 myLocationCache 缓存，避免反复请求
//   - 首次 fresh=true 强制刷新；其它默认走缓存（5 分钟内）
// ============================================================
let myLocationCache = null;        // { latlng, name, source: 'gps'|'ip', ts }
let myLocationPending = null;      // Promise，并发请求只发一次
const MY_LOCATION_TTL = 5 * 60 * 1000; // 5 分钟

function getMyLocation({ fresh = false, allowIpFallback = true, silent = false } = {}) {
    // 命中缓存
    if (!fresh && myLocationCache && (Date.now() - myLocationCache.ts < MY_LOCATION_TTL)) {
        return Promise.resolve(myLocationCache);
    }
    if (myLocationPending) return myLocationPending;

    myLocationPending = new Promise((resolve) => {
        const tryIp = async () => {
            if (!allowIpFallback || !AMAP_WEB_KEY || AMAP_WEB_KEY === 'YOUR_AMAP_WEB_KEY_HERE') {
                resolve(null); return;
            }
            try {
                const url = `https://restapi.amap.com/v3/ip?key=${AMAP_WEB_KEY}`;
                const resp = await fetch(url);
                const data = await resp.json();
                // 高德 IP 定位返回 rectangle="lng1,lat1;lng2,lat2"，取中点
                if (data.status === '1' && data.rectangle) {
                    const parts = data.rectangle.split(';');
                    if (parts.length === 2) {
                        const [lng1, lat1] = parts[0].split(',').map(Number);
                        const [lng2, lat2] = parts[1].split(',').map(Number);
                        if (!isNaN(lng1) && !isNaN(lat1) && !isNaN(lng2) && !isNaN(lat2)) {
                            const lng = (lng1 + lng2) / 2;
                            const lat = (lat1 + lat2) / 2;
                            const latlng = L.latLng(lat, lng);
                            const name = (data.province || '') + (data.city || '') + '（IP 定位）';
                            myLocationCache = { latlng, name: name || '我的位置', source: 'ip', ts: Date.now() };
                            resolve(myLocationCache);
                            return;
                        }
                    }
                }
                resolve(null);
            } catch (err) {
                console.warn('IP 定位失败:', err);
                resolve(null);
            }
        };

        if (!navigator.geolocation) {
            tryIp();
            return;
        }
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const { latitude, longitude, accuracy } = position.coords;
                // WGS-84 -> GCJ-02
                const [gcjLng, gcjLat] = CoordTransform.wgs84ToGcj02(longitude, latitude);
                const latlng = L.latLng(gcjLat, gcjLng);
                let addr = '';
                try { addr = await reverseGeocode(latlng); } catch (e) {}
                myLocationCache = {
                    latlng,
                    name: addr || '我的当前位置',
                    source: 'gps',
                    accuracy,
                    ts: Date.now()
                };
                resolve(myLocationCache);
            },
            (error) => {
                if (!silent) {
                    console.warn('浏览器定位失败，将尝试 IP 定位兜底:', error && error.message);
                }
                tryIp();
            },
            { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
        );
    }).finally(() => { myLocationPending = null; });

    return myLocationPending;
}

// 把"我的位置"应用到指定端点（origin / destination / waypoint-add）
async function useMyLocationFor(kind, opts = {}) {
    if (typeof checkKey === 'function' && !checkKey()) return null;
    const btn = kind === 'origin' ? routeOriginLocateBtn
              : kind === 'destination' ? routeDestLocateBtn
              : null;
    if (btn) btn.classList.add('loading');
    try {
        const loc = await getMyLocation({ fresh: !!opts.fresh });
        if (!loc) {
            alert('无法获取当前位置：浏览器定位被拒绝且 IP 定位失败');
            return null;
        }
        if (kind === 'origin') {
            setRouteOrigin(loc.latlng, loc.name);
        } else if (kind === 'destination') {
            setRouteDestination(loc.latlng, loc.name);
        } else if (kind === 'waypoint-add') {
            if (typeof addRouteWaypoint === 'function') {
                addRouteWaypoint(loc.latlng, loc.name);
            }
        }
        return loc;
    } finally {
        if (btn) btn.classList.remove('loading');
    }
}

// 📍 按钮点击事件绑定
if (routeOriginLocateBtn) {
    routeOriginLocateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        useMyLocationFor('origin', { fresh: true });
    });
}
if (routeDestLocateBtn) {
    routeDestLocateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        useMyLocationFor('destination', { fresh: true });
    });
}

// 🚀 页面加载后：静默尝试一次定位 + 自动填入起点（若用户尚未设过起点）
// 关键：只在用户尚未设置起点时才填，避免覆盖用户自己的选择
function tryAutoFillOriginByMyLocation() {
    if (routeOrigin) return; // 用户已设
    // 静默调用：失败也不打扰用户，仅记录到缓存
    getMyLocation({ silent: true }).then(loc => {
        if (!loc) return;
        // 二次确认（异步等待期间用户可能已手动选了起点）
        if (routeOrigin) return;
        setRouteOrigin(loc.latlng, loc.name);
    });
}
// 延迟 800ms 执行，让其它初始化先完成
setTimeout(tryAutoFillOriginByMyLocation, 800);


function clearRouteOrigin() {
    routeOrigin = null;
    if (routeOriginMarker) { map.removeLayer(routeOriginMarker); routeOriginMarker = null; }
    clearRoutePolyline();
    updateRoutePointsUI();
}

function clearRouteDestination() {
    routeDestination = null;
    if (routeDestMarker) { map.removeLayer(routeDestMarker); routeDestMarker = null; }
    clearRoutePolyline();
    updateRoutePointsUI();
}

// ============== 途经点（waypoints） ==============
// 紫色编号 marker，标识第几个途经点
function createWaypointIcon(idx) {
    return L.divIcon({
        className: 'route-waypoint-marker',
        html: `<div style="
            width: 26px; height: 26px; line-height: 26px;
            background: #8E24AA; color: #fff;
            border: 2px solid #fff; border-radius: 50%;
            text-align: center; font-size: 12px; font-weight: bold;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        ">${idx + 1}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13]
    });
}

// 重绘所有途经点 marker（编号会随顺序变化，故每次整体重建）
function rebuildWaypointMarkers() {
    waypointMarkers.forEach(m => { try { map.removeLayer(m); } catch (e) {} });
    waypointMarkers = routeWaypoints.map((wp, i) => {
        const marker = L.marker([wp.lat, wp.lng], {
            icon: createWaypointIcon(i),
            draggable: false,
            zIndexOffset: 500
        }).addTo(map).bindPopup(
            `<b>途经点 ${i + 1}</b><br/>${escapeHtml(wp.name || '')}<br/>${wp.lng.toFixed(6)}, ${wp.lat.toFixed(6)}`
        );
        return marker;
    });
}

// 渲染面板里的途经点列表
function renderWaypointsUI() {
    if (!routeWaypointsEl) return;
    // 公交模式不支持途径点（高德接口限制 + 拼接体验差），其它模式都支持
    const supportWaypoint = routeMode !== 'transit';
    if (!supportWaypoint || routeWaypoints.length === 0) {
        routeWaypointsEl.classList.remove('active');
        routeWaypointsEl.innerHTML = '';
    } else {
        routeWaypointsEl.classList.add('active');
        routeWaypointsEl.innerHTML = routeWaypoints.map((wp, i) => {
            const text = escapeHtml(wp.name || `${wp.lng.toFixed(5)}, ${wp.lat.toFixed(5)}`);
            return `
                <div class="waypoint-item" data-idx="${i}">
                    <span class="dot">${i + 1}</span>
                    <span class="text editable" data-act="edit" title="点击编辑此途经点：${text}">${text}</span>
                    <span class="move-btn" data-act="up" title="上移">▲</span>
                    <span class="move-btn" data-act="down" title="下移">▼</span>
                    <span class="clear-btn" data-act="del" title="删除">✕</span>
                </div>`;
        }).join('');
    }
    // 加号按钮可用性：非公交模式 + 未达上限
    if (addWaypointBtn) {
        const canAdd = supportWaypoint && routeWaypoints.length < ROUTE_WAYPOINT_LIMIT;
        addWaypointBtn.disabled = !canAdd;
        addWaypointBtn.style.display = supportWaypoint ? 'block' : 'none';
        addWaypointBtn.textContent = supportWaypoint
            ? `➕ 添加途经点（${routeWaypoints.length}/${ROUTE_WAYPOINT_LIMIT}）`
            : '➕ 添加途经点（公交不支持）';
    }
}

// 是否当前路径模式支持途径点（公交不支持；驾车支持原生 waypoints；骑行/步行用前端分段拼接）
function isWaypointSupportedMode() {
    return routeMode === 'driving' || routeMode === 'walking' || routeMode === 'bicycling';
}

// 添加一个途经点
async function addRouteWaypoint(latlng, name) {
    if (routeWaypoints.length >= ROUTE_WAYPOINT_LIMIT) {
        alert(`途经点最多 ${ROUTE_WAYPOINT_LIMIT} 个`);
        return;
    }
    if (!isWaypointSupportedMode()) {
        // 公交：保留数据但提示用户不会被使用
        alert('途经点在公交模式下不生效（高德公交接口不支持），已为你保留，切到驾车/步行/骑行后会自动启用。');
    }
    routeWaypoints.push({ lat: latlng.lat, lng: latlng.lng, name: name || '' });
    rebuildWaypointMarkers();
    renderWaypointsUI();
    // 异步补地址
    if (!name) {
        const addr = await reverseGeocodeIfPossible(latlng);
        const idx = routeWaypoints.findIndex(
            wp => wp.lat === latlng.lat && wp.lng === latlng.lng
        );
        if (addr && idx >= 0) {
            routeWaypoints[idx].name = addr;
            rebuildWaypointMarkers();
            renderWaypointsUI();
        }
    }
    // 起终点都齐 -> 自动重规划（驾车/步行/骑行）
    if (isWaypointSupportedMode() && routeOrigin && routeDestination) planRoute();
}

// 删除某个途经点
function removeWaypoint(idx) {
    if (idx < 0 || idx >= routeWaypoints.length) return;
    routeWaypoints.splice(idx, 1);
    rebuildWaypointMarkers();
    renderWaypointsUI();
    if (isWaypointSupportedMode() && routeOrigin && routeDestination) planRoute();
}

// 上下移动
function moveWaypoint(idx, dir) {
    const ni = idx + dir;
    if (ni < 0 || ni >= routeWaypoints.length) return;
    const tmp = routeWaypoints[idx];
    routeWaypoints[idx] = routeWaypoints[ni];
    routeWaypoints[ni] = tmp;
    rebuildWaypointMarkers();
    renderWaypointsUI();
    if (isWaypointSupportedMode() && routeOrigin && routeDestination) planRoute();
}

// 清空途经点
function clearAllWaypoints() {
    waypointMarkers.forEach(m => { try { map.removeLayer(m); } catch (e) {} });
    waypointMarkers = [];
    routeWaypoints = [];
    renderWaypointsUI();
}

// ============== B 方案：编辑指定途经点 ==============
// 用新坐标 + 名称替换 idx 位置的途经点；触发自动重规划
async function replaceWaypoint(idx, latlng, name) {
    if (idx < 0 || idx >= routeWaypoints.length) return;
    routeWaypoints[idx] = { lat: latlng.lat, lng: latlng.lng, name: name || '' };
    rebuildWaypointMarkers();
    renderWaypointsUI();
    // 没传 name 时异步反查地址
    if (!name) {
        const addr = await reverseGeocodeIfPossible(latlng);
        if (addr && routeWaypoints[idx]
            && routeWaypoints[idx].lat === latlng.lat
            && routeWaypoints[idx].lng === latlng.lng) {
            routeWaypoints[idx].name = addr;
            rebuildWaypointMarkers();
            renderWaypointsUI();
        }
    }
    if (isWaypointSupportedMode() && routeOrigin && routeDestination) planRoute();
}

// 当前编辑的途经点 idx（-1 表示不在编辑态）
let editingWaypointIdx = -1;
let editingWaypointCleanup = null;

// 进入"编辑某个途经点"状态：把对应 .waypoint-item 替换为 input + tips
function enterWaypointEdit(idx) {
    if (idx < 0 || idx >= routeWaypoints.length) return;
    // 已经在编辑同一条 -> 忽略；编辑另一条 -> 先收起前一个
    if (editingWaypointIdx === idx) return;
    if (editingWaypointCleanup) {
        try { editingWaypointCleanup(); } catch (e) {}
    }
    editingWaypointIdx = idx;

    const itemEl = routeWaypointsEl.querySelector(`.waypoint-item[data-idx="${idx}"]`);
    if (!itemEl) { editingWaypointIdx = -1; return; }
    itemEl.classList.add('editing');

    // 隐藏文字 -> 注入 input 和 tips 容器（注意 tips 复用 .route-tips 样式）
    const textSpan = itemEl.querySelector('.text');
    const moveBtns = itemEl.querySelectorAll('.move-btn');
    moveBtns.forEach(b => b.style.display = 'none');
    if (textSpan) textSpan.style.display = 'none';

    const wp = routeWaypoints[idx];
    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'waypoint-edit-input';
    inputEl.placeholder = '搜索新地点替换 / Enter 确认 / Esc 取消';
    inputEl.value = wp.name || '';
    // 将 input 和 tips 插到 dot 之后
    const dotEl = itemEl.querySelector('.dot');
    const tipsEl = document.createElement('div');
    tipsEl.className = 'route-tips';
    if (dotEl && dotEl.nextSibling) {
        itemEl.insertBefore(inputEl, dotEl.nextSibling);
        itemEl.insertBefore(tipsEl, dotEl.nextSibling.nextSibling);
    } else {
        itemEl.appendChild(inputEl);
        itemEl.appendChild(tipsEl);
    }

    // 用复用的工厂创建一个绑定到该 input/tips 的小控制器
    const ctl = createTipsController({
        inputEl,
        tipsEl,
        onPick: (latlng, name) => { exit(); replaceWaypoint(idx, latlng, name); }
    });

    function exit() {
        // 清理 DOM
        try { inputEl.remove(); } catch (e) {}
        try { tipsEl.remove(); } catch (e) {}
        if (textSpan) textSpan.style.display = '';
        moveBtns.forEach(b => b.style.display = '');
        itemEl.classList.remove('editing');
        editingWaypointIdx = -1;
        editingWaypointCleanup = null;
        document.removeEventListener('click', onDocClick, true);
    }
    function onDocClick(e) {
        if (!itemEl.contains(e.target)) exit();
    }
    // 点击外部退出
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);

    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); exit(); }
    });

    editingWaypointCleanup = exit;

    // 自动 focus 并触发首次联想
    setTimeout(() => {
        inputEl.focus();
        inputEl.select();
        if (inputEl.value.trim()) ctl.fetchTips(inputEl.value.trim());
    }, 0);
}

// ============== A 方案：底部"搜索 POI 添加为途经点"输入框 ==============
let waypointSearchCtl = null;
function setupWaypointSearchPanel() {
    if (!waypointSearchInput || !waypointSearchTipsEl) return;
    const rowEl = waypointSearchInput.closest('.waypoint-search-row');

    const ctl = createTipsController({
        inputEl: waypointSearchInput,
        tipsEl: waypointSearchTipsEl,
        onPick: (latlng, name) => {
            // 添加为新的途经点（注意：到达上限会被 addRouteWaypoint 内部 alert）
            addRouteWaypoint(latlng, name);
            // 清空输入便于继续搜索；保留 focus
            waypointSearchInput.value = '';
            if (rowEl) rowEl.classList.remove('has-value');
            ctl.hideTips();
        }
    });

    waypointSearchInput.addEventListener('input', () => {
        if (rowEl) {
            rowEl.classList.toggle('has-value', !!waypointSearchInput.value);
        }
    });

    if (waypointSearchClear) {
        waypointSearchClear.addEventListener('click', () => {
            waypointSearchInput.value = '';
            if (rowEl) rowEl.classList.remove('has-value');
            ctl.hideTips();
            waypointSearchInput.focus();
        });
    }

    // 点外部收起联想
    document.addEventListener('click', (e) => {
        if (!waypointSearchWrap.contains(e.target)) ctl.hideTips();
    });

    waypointSearchCtl = ctl;
    refreshWaypointSearchVisibility();
}

// 控制搜索框可见性：公交模式隐藏；其它显示
function refreshWaypointSearchVisibility() {
    if (!waypointSearchWrap) return;
    if (routeMode === 'transit') {
        waypointSearchWrap.classList.add('hidden');
        if (waypointSearchCtl) waypointSearchCtl.hideTips();
    } else {
        waypointSearchWrap.classList.remove('hidden');
    }
}

// ============== 通用：tips 控制器工厂（供"编辑某个途经点"和"添加搜索"复用）==============
// 参数：
//   inputEl   <input>       绑定输入框
//   tipsEl    <div>         联想下拉容器（需提前应用 .route-tips 类）
//   onPick    (latlng, name) => void   选中某条联想结果时回调
// 返回：{ fetchTips, hideTips }
function createTipsController({ inputEl, tipsEl, onPick }) {
    let debounceTimer = null;
    let abortCtl = null;
    let tips = [];
    let highlight = -1;

    function hideTips() {
        tipsEl.classList.remove('active');
        tipsEl.innerHTML = '';
        tips = [];
        highlight = -1;
    }

    function getPreferredCity() {
        const fromRoute = (routeCityInput && routeCityInput.value || '').trim();
        if (fromRoute) return fromRoute;
        if (typeof poiCityEl !== 'undefined' && poiCityEl && poiCityEl.value) {
            return poiCityEl.value.trim();
        }
        return '';
    }

    function renderTips(list) {
        tips = list;
        highlight = -1;
        if (!list || !list.length) {
            tipsEl.innerHTML = '<div class="route-tip-empty">无匹配结果</div>';
            tipsEl.classList.add('active');
            return;
        }
        tipsEl.innerHTML = list.map((t, i) => {
            const district = [t.district, t.address].filter(Boolean).join(' · ');
            const info = (typeof classifyTip === 'function') ? classifyTip(t) : { emoji: '📍', label: '' };
            return `<div class="route-tip-item" data-index="${i}" title="${escapeHtml(info.label || '')}">
                <span class="tip-icon">${info.emoji}</span>
                <span class="tip-body">
                    <span class="tip-name">${escapeHtml(t.name || '')}</span>
                    ${district ? `<span class="tip-district">${escapeHtml(district)}</span>` : ''}
                </span>
            </div>`;
        }).join('');
        tipsEl.classList.add('active');
        tipsEl.querySelectorAll('.route-tip-item').forEach(el => {
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const idx = parseInt(el.getAttribute('data-index'), 10);
                pickTip(idx);
            });
        });
    }

    function updateHighlight() {
        const items = tipsEl.querySelectorAll('.route-tip-item');
        items.forEach((el, i) => el.classList.toggle('highlight', i === highlight));
        if (highlight >= 0 && items[highlight]) {
            items[highlight].scrollIntoView({ block: 'nearest' });
        }
    }

    function pickTip(idx) {
        const tip = tips[idx];
        if (!tip) return;
        const name = tip.name || '';
        if (tip.location && typeof tip.location === 'string' && tip.location.includes(',')) {
            const [lngStr, latStr] = tip.location.split(',');
            const lng = parseFloat(lngStr);
            const lat = parseFloat(latStr);
            if (!isNaN(lng) && !isNaN(lat)) {
                onPick(L.latLng(lat, lng), name);
                return;
            }
        }
        // 无坐标 -> geocode
        geocodeAndApply(name, tip.district || '');
    }

    async function geocodeAndApply(keyword, district) {
        if (typeof checkKey === 'function' && !checkKey()) return;
        try {
            const address = district ? `${district}${keyword}` : keyword;
            const city = getPreferredCity();
            const url = `https://restapi.amap.com/v3/geocode/geo` +
                        `?key=${AMAP_WEB_KEY}&address=${encodeURIComponent(address)}` +
                        (city ? `&city=${encodeURIComponent(city)}` : '');
            const resp = await fetch(url);
            const data = await resp.json();
            if (data.status === '1' && data.geocodes && data.geocodes.length) {
                const [lng, lat] = data.geocodes[0].location.split(',').map(Number);
                onPick(L.latLng(lat, lng), keyword);
            } else {
                alert('未找到该位置坐标，请换个关键字');
            }
        } catch (err) {
            console.warn('geocode 失败:', err);
            alert('地理编码失败：' + err.message);
        }
    }

    async function fetchTips(keyword) {
        if (typeof checkKey === 'function' && !checkKey()) return;
        if (abortCtl) abortCtl.abort();
        abortCtl = new AbortController();
        try {
            const city = getPreferredCity();
            const center = map.getCenter();
            const locOrCity = city
                ? `&city=${encodeURIComponent(city)}&citylimit=true`
                : `&location=${center.lng.toFixed(6)},${center.lat.toFixed(6)}`;
            const url = `https://restapi.amap.com/v3/assistant/inputtips` +
                        `?key=${AMAP_WEB_KEY}` +
                        `&keywords=${encodeURIComponent(keyword)}` +
                        locOrCity +
                        `&datatype=all`;
            const resp = await fetch(url, { signal: abortCtl.signal });
            const data = await resp.json();
            if (data.status !== '1') { hideTips(); return; }
            const list = (data.tips || []).filter(t => t && t.name).slice(0, 10);
            renderTips(list);
        } catch (err) {
            if (err.name === 'AbortError') return;
            console.warn('途经点联想失败:', err);
            hideTips();
        }
    }

    inputEl.addEventListener('input', () => {
        const kw = inputEl.value.trim();
        clearTimeout(debounceTimer);
        if (!kw) { hideTips(); return; }
        debounceTimer = setTimeout(() => fetchTips(kw), 300);
    });

    inputEl.addEventListener('keydown', (e) => {
        const active = tipsEl.classList.contains('active') && tips.length > 0;
        if (e.key === 'ArrowDown' && active) {
            e.preventDefault();
            highlight = (highlight + 1) % tips.length;
            updateHighlight();
        } else if (e.key === 'ArrowUp' && active) {
            e.preventDefault();
            highlight = (highlight - 1 + tips.length) % tips.length;
            updateHighlight();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (active && highlight >= 0) {
                pickTip(highlight);
            } else if (inputEl.value.trim()) {
                geocodeAndApply(inputEl.value.trim(), '');
            }
        }
    });

    return { fetchTips, hideTips };
}

// 单独抽出一个"安全 reverseGeocode"小工具
async function reverseGeocodeIfPossible(latlng) {
    try {
        if (typeof reverseGeocode === 'function') {
            return await reverseGeocode(latlng);
        }
    } catch (e) { /* ignore */ }
    return '';
}

function clearRoutePolyline() {
    // 先停掉轨迹回放动画
    stopTrackAnim();
    // 同时停掉实时导航（如有）
    if (typeof stopNavigation === 'function') stopNavigation({ silent: true });
    if (routePolyline) { map.removeLayer(routePolyline); routePolyline = null; }
    // 公交模式的多段线
    if (transitPolylines.length) {
        transitPolylines.forEach(pl => { try { map.removeLayer(pl); } catch (e) {} });
        transitPolylines = [];
    }
    // 多策略备选路线
    if (alternativePolylines.length) {
        alternativePolylines.forEach(pl => { try { map.removeLayer(pl); } catch (e) {} });
        alternativePolylines = [];
    }
    alternativeData = [];
    selectedAlternativeIdx = 0;
    if (routeAlternativesEl) {
        routeAlternativesEl.classList.remove('active');
        routeAlternativesEl.innerHTML = '';
    }
    routeSummaryEl.classList.remove('active');
    routeSummaryEl.innerHTML = '';
    // 不在此清空方案列表（这样用户点击其它方案仍可看到列表）
}

function clearAllRoute() {
    clearRouteOrigin();
    clearRouteDestination();
    clearAllWaypoints();
    clearRoutePolyline();
    // 同时清空公交方案列表
    currentTransits = [];
    selectedTransitIndex = -1;
    routeTransitsEl.classList.remove('active');
    routeTransitsEl.innerHTML = '';
}

// 解析高德 polyline 字符串 "lng1,lat1;lng2,lat2;..." -> Leaflet [lat, lng][] 数组
function parseAmapPolyline(str) {
    if (!str) return [];
    return str.split(';').map(pair => {
        const [lngStr, latStr] = pair.split(',');
        const lng = parseFloat(lngStr);
        const lat = parseFloat(latStr);
        return (isNaN(lng) || isNaN(lat)) ? null : [lat, lng];
    }).filter(Boolean);
}

// 格式化距离（米 -> "x.x 公里" 或 "x 米"）
function formatDistance(meters) {
    const m = Number(meters) || 0;
    return m >= 1000 ? `${(m / 1000).toFixed(2)} 公里` : `${Math.round(m)} 米`;
}

// 格式化时间（秒 -> "x 小时 y 分钟" / "y 分钟"）
function formatDuration(seconds) {
    const s = Number(seconds) || 0;
    const h = Math.floor(s / 3600);
    const m = Math.round((s - h * 3600) / 60);
    if (h > 0) return `${h} 小时 ${m} 分钟`;
    return `${m} 分钟`;
}

// 执行路径规划
// === 多策略对比：渲染主路线 + 备选弱化路线 ===
function renderMainRoute(idx) {
    if (!alternativeData || !alternativeData.length) return;
    selectedAlternativeIdx = Math.max(0, Math.min(idx, alternativeData.length - 1));

    // 移除旧的主线 + 备选线
    if (routePolyline) { try { map.removeLayer(routePolyline); } catch (e) {} routePolyline = null; }
    alternativePolylines.forEach(pl => { try { map.removeLayer(pl); } catch (e) {} });
    alternativePolylines = [];

    const modeColorMap = {
        driving: '#1E88E5',
        walking: '#43A047',
        bicycling: '#FB8C00'
    };

    // 先画备选（灰底淡色），可点击切换
    alternativeData.forEach((p, i) => {
        if (i === selectedAlternativeIdx) return;
        const pl = L.polyline(p.coords, {
            color: p.color,
            weight: 5,
            opacity: 0.45,
            dashArray: '8 8',
            lineJoin: 'round',
            lineCap: 'round'
        }).addTo(map);
        // 鼠标悬停高亮
        pl.on('mouseover', () => pl.setStyle({ opacity: 0.85, weight: 6 }));
        pl.on('mouseout',  () => pl.setStyle({ opacity: 0.45, weight: 5 }));
        // 点击切换为主路线
        pl.on('click', () => renderMainRoute(i));
        // 提示
        pl.bindTooltip(
            `${escapeHtml(p.name)} · ${formatDistance(p.distance)} · ${formatDuration(p.duration)}`,
            { sticky: true }
        );
        alternativePolylines.push(pl);
    });

    // 主线：蚂蚁线
    const main = alternativeData[selectedAlternativeIdx];
    const mainColor = (alternativeData.length > 1) ? main.color : modeColorMap[routeMode];
    routePolyline = antPath(main.coords, {
        color: mainColor,
        pulseColor: '#ffffff',
        weight: 6,
        opacity: 0.95,
        delay: 1200,
        dashArray: [12, 22],
        lineJoin: 'round',
        lineCap: 'round',
        paused: false,
        reverse: false,
        hardwareAccelerated: true
    }).addTo(map);

    // 缓存坐标供"轨迹回放"使用
    trackAnimCoords = main.coords.slice();
    resetTrackAnim();

    // 摘要
    const modeLabel = { driving: '驾车', walking: '步行', bicycling: '骑行' }[routeMode];
    const wpInfo = ((routeMode === 'driving' || routeMode === 'walking' || routeMode === 'bicycling') && routeWaypoints.length)
        ? `<div class="summary-line" style="color:#8E24AA;">途经点：${routeWaypoints.length} 个${routeMode !== 'driving' ? '（分段拼接）' : ''}</div>`
        : '';
    routeSummaryEl.innerHTML =
        `<div class="summary-line"><b>${modeLabel}路线</b></div>` +
        `<div class="summary-line">距离：<span class="distance">${formatDistance(main.distance)}</span></div>` +
        `<div class="summary-line">预计耗时：${formatDuration(main.duration)}</div>` +
        (main.strategyText ? `<div class="summary-line" style="color:#888;">策略：${escapeHtml(main.strategyText)}</div>` : '') +
        wpInfo +
        `<div class="summary-line track-anim-bar" style="margin-top:8px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;">
            <button id="track-play-btn" style="padding:3px 10px;font-size:12px;border:1px solid #1E88E5;background:#fff;color:#1E88E5;border-radius:3px;cursor:pointer;">▶️ 播放</button>
            <button id="track-reset-btn" style="padding:3px 10px;font-size:12px;border:1px solid #888;background:#fff;color:#555;border-radius:3px;cursor:pointer;">⟲ 重放</button>
            <label style="font-size:11px;color:#666;">速度
                <select id="track-speed-select" style="font-size:11px;">
                    <option value="60">🐢 慢 (60 m/s)</option>
                    <option value="200" selected>🚗 正常 (200 m/s)</option>
                    <option value="600">🚀 快 (600 m/s)</option>
                    <option value="1500">⚡ 极速 (1500 m/s)</option>
                </select>
            </label>
            <label style="font-size:11px;color:#666;display:inline-flex;align-items:center;gap:3px;">
                <input type="checkbox" id="track-follow-checkbox" style="margin:0;"> 📷 跟随
            </label>
            <span id="track-progress-text" style="font-size:11px;color:#888;">0%</span>
        </div>` +
        // ============ 实时导航入口（仅 driving / walking / bicycling） ============
        `<div class="nav-launch-row">
            <button class="nav-real-btn" id="nav-start-real-btn">🧭 开始导航</button>
            <button class="nav-sim-btn"  id="nav-start-sim-btn">🎮 模拟导航</button>
            <button class="nav-history-btn" id="nav-history-open-btn" title="导航历史记录">📜</button>
        </div>`;
    setTimeout(bindTrackAnimControls, 0);
    setTimeout(bindNavLaunchControls, 0);

    // 同步候选卡片高亮
    if (routeAlternativesEl) {
        routeAlternativesEl.querySelectorAll('.alt-item').forEach((el, i) => {
            el.classList.toggle('active', i === selectedAlternativeIdx);
        });
    }
}

// 渲染候选方案卡片列表（仅当超过 1 条路径时显示）
function renderRouteAlternatives() {
    if (!routeAlternativesEl) return;
    if (!alternativeData || alternativeData.length <= 1) {
        routeAlternativesEl.classList.remove('active');
        routeAlternativesEl.innerHTML = '';
        return;
    }
    routeAlternativesEl.classList.add('active');
    const html = [`<div class="alt-title">🆚 ${alternativeData.length} 条候选路线（点击切换主路线）</div>`];
    alternativeData.forEach((p, i) => {
        html.push(`
            <div class="alt-item ${i === selectedAlternativeIdx ? 'active' : ''}" data-idx="${i}">
                <span class="alt-color" style="background:${p.color};"></span>
                <div class="alt-info">
                    <div class="alt-name">${escapeHtml(p.name)}</div>
                    <div class="alt-meta">${formatDistance(p.distance)} · ${formatDuration(p.duration)}</div>
                </div>
            </div>
        `);
    });
    routeAlternativesEl.innerHTML = html.join('');
    routeAlternativesEl.querySelectorAll('.alt-item').forEach(el => {
        el.addEventListener('click', () => {
            const i = parseInt(el.getAttribute('data-idx'), 10);
            if (!isNaN(i)) renderMainRoute(i);
        });
    });
}

// ============== 步行 / 骑行的"分段拼接式途径点"工具函数 ==============
// 高德 walking / bicycling 接口本身不支持 waypoints 参数，
// 这里把 [起点, wp1, wp2, ..., 终点] 拆成 N+1 段独立调用，
// 把每段的 polyline / distance / duration 累加合并成一条整路径。
//
// 注意：
//  - 并发调用 fetch（Promise.all），避免顺序串行拖慢响应；
//  - 段间衔接处会有重复点，做去重以避免动画"原地停顿"；
//  - 任何一段失败 -> 抛错，由上层 catch 统一处理。
async function planRouteWithWaypointsSegmented(mode, origin, dest, waypoints) {
    // 构造点序列：起点 + 途经点 + 终点
    const pts = [origin, ...waypoints, dest];

    // 单段请求构造器
    const fetchOneSegment = async (a, b) => {
        const o = `${a.lng.toFixed(6)},${a.lat.toFixed(6)}`;
        const d = `${b.lng.toFixed(6)},${b.lat.toFixed(6)}`;
        let url, isV4 = false;
        if (mode === 'walking') {
            url = `https://restapi.amap.com/v3/direction/walking` +
                  `?key=${AMAP_WEB_KEY}&origin=${o}&destination=${d}&output=JSON`;
        } else { // bicycling
            isV4 = true;
            url = `https://restapi.amap.com/v4/direction/bicycling` +
                  `?key=${AMAP_WEB_KEY}&origin=${o}&destination=${d}`;
        }
        const resp = await fetch(url);
        const data = await resp.json();
        let path;
        if (isV4) {
            if (data.errcode !== 0) throw new Error(data.errmsg || '骑行段规划失败');
            path = (data.data && data.data.paths && data.data.paths[0]);
        } else {
            if (data.status !== '1') throw new Error(data.info || '步行段规划失败');
            path = (data.route && data.route.paths && data.route.paths[0]);
        }
        if (!path) throw new Error('某段路径无结果');
        const coords = [];
        (path.steps || []).forEach(step => {
            coords.push(...parseAmapPolyline(step.polyline));
        });
        return {
            coords,
            distance: Number(path.distance) || 0,
            duration: Number(path.duration) || 0
        };
    };

    // 并发拉所有段
    const tasks = [];
    for (let i = 0; i < pts.length - 1; i++) {
        tasks.push(fetchOneSegment(pts[i], pts[i + 1]));
    }
    const segs = await Promise.all(tasks);

    // 拼接 coords：相邻段尾点 / 头点重合时只保留一个
    const merged = [];
    let totalDist = 0, totalDur = 0;
    segs.forEach((seg, idx) => {
        totalDist += seg.distance;
        totalDur += seg.duration;
        if (!seg.coords.length) return;
        if (idx === 0) {
            merged.push(...seg.coords);
        } else {
            const last = merged[merged.length - 1];
            const first = seg.coords[0];
            // 距离 < 1m 视为同点 -> 跳过首点
            const dup = last && first && Math.abs(last[0] - first[0]) < 1e-5
                                       && Math.abs(last[1] - first[1]) < 1e-5;
            merged.push(...(dup ? seg.coords.slice(1) : seg.coords));
        }
    });

    return { coords: merged, distance: totalDist, duration: totalDur };
}

async function planRoute() {
    if (!routeOrigin || !routeDestination) {
        alert('请先设置起点和终点（右键地图选择）');
        return;
    }
    if (!checkKey()) return;

    // 公交走独立分支
    if (routeMode === 'transit') {
        return planTransit();
    }

    clearRoutePolyline();
    routePlanBtn.disabled = true;
    routePlanBtn.textContent = '规划中...';
    routeSummaryEl.classList.add('active');
    routeSummaryEl.innerHTML = '<div class="summary-line">正在规划路径...</div>';

    const originStr = `${routeOrigin.lng.toFixed(6)},${routeOrigin.lat.toFixed(6)}`;
    const destStr = `${routeDestination.lng.toFixed(6)},${routeDestination.lat.toFixed(6)}`;

    // 仅 driving 支持原生 waypoints / strategy；walking/bicycling 用前端分段拼接
    const isDriving = routeMode === 'driving';
    const waypointsStr = (isDriving && routeWaypoints.length)
        ? routeWaypoints.map(w => `${w.lng.toFixed(6)},${w.lat.toFixed(6)}`).join(';')
        : '';
    const strategy = isDriving ? (routeStrategy || '0') : null;
    const isMultiStrategy = isDriving && strategy === '5';

    try {
        // ===== 步行 / 骑行：有途经点 -> 走"前端分段拼接"分支 =====
        if (!isDriving && routeWaypoints.length > 0) {
            const merged = await planRouteWithWaypointsSegmented(routeMode, routeOrigin, routeDestination, routeWaypoints);
            alternativeData = [{
                coords: merged.coords,
                distance: merged.distance,
                duration: merged.duration,
                strategyText: `${routeMode === 'walking' ? '步行' : '骑行'} · ${routeWaypoints.length} 个途经点（分段拼接）`,
                color: '#1E88E5',
                name: routeMode === 'walking' ? '步行方案' : '骑行方案'
            }];
            selectedAlternativeIdx = 0;
            renderRouteAlternatives();
            renderMainRoute(0);
            const allBounds = L.latLngBounds(merged.coords);
            if (allBounds.isValid()) map.fitBounds(allBounds, { padding: [60, 60] });
            return;
        }

        let url, apiVersion;
        if (isDriving) {
            apiVersion = 'v3';
            // strategy=5 时高德会返回多条 paths（速度 / 距离 / 不走高速 等组合）
            url = `https://restapi.amap.com/v3/direction/driving` +
                  `?key=${AMAP_WEB_KEY}&origin=${originStr}&destination=${destStr}` +
                  `&extensions=base&output=JSON&strategy=${strategy}` +
                  (waypointsStr ? `&waypoints=${encodeURIComponent(waypointsStr)}` : '');
        } else if (routeMode === 'walking') {
            apiVersion = 'v3';
            url = `https://restapi.amap.com/v3/direction/walking` +
                  `?key=${AMAP_WEB_KEY}&origin=${originStr}&destination=${destStr}&output=JSON`;
        } else { // bicycling -> v4
            apiVersion = 'v4';
            url = `https://restapi.amap.com/v4/direction/bicycling` +
                  `?key=${AMAP_WEB_KEY}&origin=${originStr}&destination=${destStr}`;
        }

        const resp = await fetch(url);
        const data = await resp.json();

        // v3 / v4 响应结构不同
        let paths = []; // [{ distance, duration, steps, strategy }]
        if (apiVersion === 'v4') {
            if (data.errcode !== 0) throw new Error(data.errmsg || '骑行规划失败');
            const all = (data.data && data.data.paths) || [];
            if (!all.length) throw new Error('未找到可用骑行路径');
            paths = all.slice(0, 1);
        } else {
            if (data.status !== '1') throw new Error(data.info || '路径规划失败');
            const all = (data.route && data.route.paths) || [];
            if (!all.length) throw new Error('未找到可用路径');
            // 多策略对比时最多取 3 条
            paths = isMultiStrategy ? all.slice(0, 3) : all.slice(0, 1);
        }

        // 把每条 path 拍平成 coords + meta
        const pathInfos = paths.map((p, i) => {
            const coords = [];
            (p.steps || []).forEach(step => {
                coords.push(...parseAmapPolyline(step.polyline));
            });
            return {
                coords,
                distance: Number(p.distance) || 0,
                duration: Number(p.duration) || 0,
                strategyText: p.strategy || '',
                color: ALT_COLORS[i] || '#1E88E5',
                name: p.strategy || `方案 ${i + 1}`
            };
        }).filter(p => p.coords.length >= 2);

        if (!pathInfos.length) throw new Error('路径数据为空');

        alternativeData = pathInfos;
        // 若上次记忆的 idx 越界，重置为 0
        if (selectedAlternativeIdx >= alternativeData.length) selectedAlternativeIdx = 0;

        renderRouteAlternatives();   // 渲染候选卡片
        renderMainRoute(selectedAlternativeIdx);  // 绘制主路线 + 摘要

        // 自适应缩放
        const allBounds = L.latLngBounds([]);
        alternativeData.forEach(p => p.coords.forEach(c => allBounds.extend(c)));
        if (allBounds.isValid()) map.fitBounds(allBounds, { padding: [60, 60] });

    } catch (err) {
        console.error('路径规划失败:', err);
        routeSummaryEl.innerHTML = `<div class="summary-line" style="color:#E53935;">规划失败：${escapeHtml(err.message)}</div>`;
    } finally {
        routePlanBtn.disabled = false;
        routePlanBtn.textContent = '开始规划';
    }
}

// ------- 公交路径规划 -------
// 调 /v3/direction/transit/integrated，把 transits[] 渲染为方案列表，
// 点选某方案后再绘制对应的分段 polyline。
async function planTransit() {
    // 城市必填
    let city = (routeCityInput.value || '').trim();
    let cityd = (routeCitydInput.value || '').trim();
    if (!city) {
        // 给一个合理的默认值：当前城市下拉（如果有）或者兜底"北京"
        const poiCity = (typeof poiCityEl !== 'undefined' && poiCityEl && poiCityEl.value) ? poiCityEl.value.trim() : '';
        city = poiCity || '北京';
        routeCityInput.value = city;
    }

    clearRoutePolyline();
    currentTransits = [];
    selectedTransitIndex = -1;
    routeTransitsEl.classList.remove('active');
    routeTransitsEl.innerHTML = '';

    routePlanBtn.disabled = true;
    routePlanBtn.textContent = '规划中...';
    routeSummaryEl.classList.add('active');
    routeSummaryEl.innerHTML = '<div class="summary-line">正在规划公交路线...</div>';

    const originStr = `${routeOrigin.lng.toFixed(6)},${routeOrigin.lat.toFixed(6)}`;
    const destStr = `${routeDestination.lng.toFixed(6)},${routeDestination.lat.toFixed(6)}`;

    try {
        let url = `https://restapi.amap.com/v3/direction/transit/integrated` +
                  `?key=${AMAP_WEB_KEY}&origin=${originStr}&destination=${destStr}` +
                  `&city=${encodeURIComponent(city)}&output=JSON&strategy=0&nightflag=0`;
        if (cityd) {
            url += `&cityd=${encodeURIComponent(cityd)}`;
        }
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.status !== '1') throw new Error(data.info || '公交规划失败');

        const transits = (data.route && data.route.transits) || [];
        if (!transits.length) {
            throw new Error('未找到公交方案，请检查城市或尝试改用驾车/步行');
        }

        currentTransits = transits;
        renderTransitList();
        // 默认展示第一套方案的摘要，并自动绘制
        selectTransit(0);
    } catch (err) {
        console.error('公交规划失败:', err);
        routeSummaryEl.innerHTML = `<div class="summary-line" style="color:#E53935;">规划失败：${escapeHtml(err.message)}</div>`;
    } finally {
        routePlanBtn.disabled = false;
        routePlanBtn.textContent = '开始规划';
    }
}

// 从 transit 方案中抽出"换乘链"文字描述（用于列表摘要）
function extractTransitChain(transit) {
    const parts = [];
    (transit.segments || []).forEach(seg => {
        // 步行段
        if (seg.walking && seg.walking.steps && seg.walking.steps.length) {
            const walkDist = Number(seg.walking.distance) || 0;
            if (walkDist >= 50) {
                parts.push({ type: 'walk', text: `步行${formatDistance(walkDist)}` });
            }
        }
        // 公交段（可能有多条备选 buslines，高德默认第一条）
        if (seg.bus && seg.bus.buslines && seg.bus.buslines.length) {
            const line = seg.bus.buslines[0];
            const isSubway = (line.type || '').indexOf('地铁') !== -1;
            parts.push({
                type: isSubway ? 'subway' : 'bus',
                text: (line.name || '').replace(/\(.*?\)/g, '')
            });
        }
        // 火车段（跨城）
        if (seg.railway && seg.railway.name) {
            parts.push({ type: 'railway', text: seg.railway.name });
        }
        // 出租车段
        if (seg.taxi && Number(seg.taxi.distance) > 0) {
            parts.push({ type: 'walk', text: `出租${formatDistance(seg.taxi.distance)}` });
        }
    });
    return parts;
}

function renderTransitList() {
    if (!currentTransits.length) {
        routeTransitsEl.classList.remove('active');
        routeTransitsEl.innerHTML = '';
        return;
    }
    const html = currentTransits.map((t, i) => {
        const chain = extractTransitChain(t);
        const chainHtml = chain.map(p =>
            `<span class="seg-tag ${p.type}">${escapeHtml(p.text)}</span>`
        ).join('<span class="seg-sep">›</span>');
        const cost = Number(t.cost) || 0;
        const walkDist = Number(t.walking_distance) || 0;
        return `
            <div class="transit-item" data-idx="${i}">
                <div class="transit-title">方案 ${i + 1}：${formatDuration(t.duration)}</div>
                <div class="transit-meta">
                    总距离 ${formatDistance(t.distance)}
                    · 步行 ${formatDistance(walkDist)}
                    ${cost > 0 ? `· 票价 ¥${cost}` : ''}
                </div>
                <div class="transit-segs">${chainHtml || '—'}</div>
            </div>
        `;
    }).join('');
    routeTransitsEl.innerHTML = html;
    routeTransitsEl.classList.add('active');
    // 绑点击
    routeTransitsEl.querySelectorAll('.transit-item').forEach(el => {
        el.addEventListener('click', () => {
            const idx = Number(el.getAttribute('data-idx'));
            selectTransit(idx);
        });
    });
}

function selectTransit(idx) {
    if (idx < 0 || idx >= currentTransits.length) return;
    selectedTransitIndex = idx;
    // 高亮
    routeTransitsEl.querySelectorAll('.transit-item').forEach((el, i) => {
        el.classList.toggle('active', i === idx);
    });
    const transit = currentTransits[idx];
    // 摘要
    const cost = Number(transit.cost) || 0;
    routeSummaryEl.innerHTML =
        `<div class="summary-line"><b>公交方案 ${idx + 1}</b></div>` +
        `<div class="summary-line">预计耗时：<span class="distance">${formatDuration(transit.duration)}</span></div>` +
        `<div class="summary-line">总距离：${formatDistance(transit.distance)} · 步行 ${formatDistance(transit.walking_distance)}</div>` +
        (cost > 0 ? `<div class="summary-line">预估票价：¥${cost}</div>` : '');
    routeSummaryEl.classList.add('active');
    // 绘制分段
    drawTransitSegments(transit);
}

// 绘制一个公交方案的所有分段 polyline
function drawTransitSegments(transit) {
    // 清掉旧的公交线
    if (transitPolylines.length) {
        transitPolylines.forEach(pl => { try { map.removeLayer(pl); } catch (e) {} });
        transitPolylines = [];
    }
    const allBounds = [];
    (transit.segments || []).forEach(seg => {
        // 1) 步行段（灰虚线）
        if (seg.walking && seg.walking.steps) {
            seg.walking.steps.forEach(step => {
                const pts = parseAmapPolyline(step.polyline);
                if (pts.length >= 2) {
                    const pl = L.polyline(pts, {
                        color: '#888',
                        weight: 4,
                        opacity: 0.8,
                        dashArray: '6,6',
                        lineJoin: 'round',
                        lineCap: 'round'
                    }).addTo(map);
                    transitPolylines.push(pl);
                    allBounds.push(pl.getBounds());
                }
            });
        }
        // 2) 公交/地铁段（第一条备选线路的 polyline）
        if (seg.bus && seg.bus.buslines && seg.bus.buslines.length) {
            const line = seg.bus.buslines[0];
            const pts = parseAmapPolyline(line.polyline);
            if (pts.length >= 2) {
                const isSubway = (line.type || '').indexOf('地铁') !== -1;
                const pl = L.polyline(pts, {
                    color: isSubway ? '#43A047' : '#1E88E5',
                    weight: 6,
                    opacity: 0.9,
                    lineJoin: 'round',
                    lineCap: 'round'
                }).addTo(map);
                pl.bindPopup(`<b>${escapeHtml(line.name || '')}</b><br/>
                    ${escapeHtml(line.departure_stop && line.departure_stop.name || '')}
                    → ${escapeHtml(line.arrival_stop && line.arrival_stop.name || '')}<br/>
                    经停 ${line.via_num || 0} 站`);
                transitPolylines.push(pl);
                allBounds.push(pl.getBounds());
            }
        }
        // 3) 火车段（紫色）
        if (seg.railway && seg.railway.spaces && seg.railway.name) {
            // railway 不直接给 polyline，只有 departure_station / arrival_station 坐标，连线处理
            const ds = seg.railway.departure_station;
            const as = seg.railway.arrival_station;
            if (ds && as && ds.location && as.location) {
                const [lng1, lat1] = ds.location.split(',').map(Number);
                const [lng2, lat2] = as.location.split(',').map(Number);
                if (!isNaN(lng1) && !isNaN(lat1) && !isNaN(lng2) && !isNaN(lat2)) {
                    const pl = L.polyline([[lat1, lng1], [lat2, lng2]], {
                        color: '#8E24AA',
                        weight: 5,
                        opacity: 0.85
                    }).addTo(map);
                    pl.bindPopup(`<b>${escapeHtml(seg.railway.name)}</b><br/>
                        ${escapeHtml(ds.name || '')} → ${escapeHtml(as.name || '')}`);
                    transitPolylines.push(pl);
                    allBounds.push(pl.getBounds());
                }
            }
        }
    });
    // 自适应缩放
    if (allBounds.length) {
        let merged = allBounds[0];
        for (let i = 1; i < allBounds.length; i++) merged = merged.extend(allBounds[i]);
        // 也把起终点 marker 纳入
        if (routeOrigin) merged = merged.extend([routeOrigin.lat, routeOrigin.lng]);
        if (routeDestination) merged = merged.extend([routeDestination.lat, routeDestination.lng]);
        map.fitBounds(merged, { padding: [60, 60] });
    }
}

// 面板折叠/展开
routeHeaderEl.addEventListener('click', () => {
    routePanelEl.classList.toggle('collapsed');
});

// 出行方式切换
routeModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        routeModeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        routeMode = btn.getAttribute('data-mode');
        // 公交模式显示城市输入行
        if (routeMode === 'transit') {
            routeCitiesEl.classList.add('active');
        } else {
            routeCitiesEl.classList.remove('active');
            // 切出公交，隐藏方案列表
            routeTransitsEl.classList.remove('active');
        }
        // 仅 driving 模式显示策略行
        if (routeMode === 'driving') {
            routeStrategyWrapEl.classList.add('active');
        } else {
            routeStrategyWrapEl.classList.remove('active');
        }
        // 重渲染途经点 UI（非 driving 时途经点列表会隐藏，但状态保留）
        renderWaypointsUI();
        // 同步途经点搜索框可见性（公交模式隐藏）
        if (typeof refreshWaypointSearchVisibility === 'function') {
            refreshWaypointSearchVisibility();
        }
        // 切到非 driving 时，备选路线对比卡片也隐藏
        if (routeMode !== 'driving' && routeAlternativesEl) {
            routeAlternativesEl.classList.remove('active');
        }
        // 如果已经有起终点，自动重新规划
        if (routeOrigin && routeDestination) planRoute();
    });
});

// 驾车策略改变
if (routeStrategySelect) {
    routeStrategySelect.addEventListener('change', () => {
        routeStrategy = routeStrategySelect.value || '0';
        if (routeMode === 'driving' && routeOrigin && routeDestination) planRoute();
    });
}

// "添加途经点"按钮：右键菜单是主入口；这里点击给一个引导提示
if (addWaypointBtn) {
    addWaypointBtn.addEventListener('click', () => {
        if (routeMode === 'transit') {
            alert('途经点在公交模式下不支持');
            return;
        }
        if (routeWaypoints.length >= ROUTE_WAYPOINT_LIMIT) {
            alert(`最多 ${ROUTE_WAYPOINT_LIMIT} 个途经点`);
            return;
        }
        alert('请在地图上 →【右键】→ 选择「🟣 设为途经点」即可添加');
    });
}

// 途经点列表的事件委托：上移 / 下移 / 删除 / 编辑
if (routeWaypointsEl) {
    routeWaypointsEl.addEventListener('click', (e) => {
        const wrap = e.target.closest('.waypoint-item');
        if (!wrap) return;
        const idx = parseInt(wrap.getAttribute('data-idx'), 10);
        if (isNaN(idx)) return;
        const act = e.target.getAttribute('data-act');
        if (act === 'del') removeWaypoint(idx);
        else if (act === 'up') moveWaypoint(idx, -1);
        else if (act === 'down') moveWaypoint(idx, +1);
        else if (act === 'edit') enterWaypointEdit(idx);
    });
}

// 初始化策略行可见性（默认 driving）
if (routeStrategyWrapEl && routeMode === 'driving') {
    routeStrategyWrapEl.classList.add('active');
}
renderWaypointsUI();
setupWaypointSearchPanel();

// 城市输入改变后，若当前是公交模式且起终点完备，按回车或失焦触发重新规划
[routeCityInput, routeCitydInput].forEach(inp => {
    inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && routeMode === 'transit' && routeOrigin && routeDestination) {
            planRoute();
        }
    });
});

routeOriginClearEl.addEventListener('click', clearRouteOrigin);
routeDestClearEl.addEventListener('click', clearRouteDestination);
routePlanBtn.addEventListener('click', planRoute);
routeClearBtn.addEventListener('click', clearAllRoute);

// ------- 起/终点输入联想控制器（与 POI 搜索的 inputtips 独立一份，避免状态耦合） -------
// 两个入口（起点 / 终点）共用一份控制器工厂。
// 行为：
//   1) 点击文本行 -> 切换到输入框；自动 focus 并拉起联想（若有当前值）
//   2) 输入防抖 300ms -> 请求 /v3/assistant/inputtips，按"路径规划城市 -> POI 城市 -> 地图中心附近"顺序选参
//   3) ↑↓ 选择、Enter 选中、Esc/点击外部 收起
//   4) 选中后若 tip 带 location 直接 setRouteOrigin/Destination；否则按城市模式做一次 geocode 回填
function createRoutePointInputController(kind) {
    // kind: 'origin' | 'destination'
    const isOrigin = kind === 'origin';
    const textEl = isOrigin ? routeOriginTextEl : routeDestTextEl;
    const wrapEl = isOrigin ? routeOriginInputWrap : routeDestInputWrap;
    const inputEl = isOrigin ? routeOriginInput : routeDestInput;
    const tipsEl = isOrigin ? routeOriginTipsEl : routeDestTipsEl;
    const applyPoint = isOrigin ? setRouteOrigin : setRouteDestination;

    let debounceTimer = null;
    let abortCtl = null;
    let tips = [];
    let highlight = -1;

    function enterEdit() {
        // 预填：若已有点，填入名称；否则空
        const current = isOrigin ? routeOrigin : routeDestination;
        inputEl.value = current ? (current.name || '') : '';
        textEl.style.display = 'none';
        wrapEl.classList.add('active');
        // 下一帧 focus，避免点击事件仍在传播时选区异常
        setTimeout(() => {
            inputEl.focus();
            inputEl.select();
            if (inputEl.value.trim()) {
                fetchTips(inputEl.value.trim());
            } else {
                // 空输入也展示一下"📍 我的位置"项
                renderTips([]);
            }
        }, 0);
    }

    function exitEdit() {
        wrapEl.classList.remove('active');
        textEl.style.display = '';
        hideTips();
    }

    function hideTips() {
        tipsEl.classList.remove('active');
        tipsEl.innerHTML = '';
        tips = [];
        highlight = -1;
    }

    function renderTips(list) {
        // 永远把"📍 我的位置"作为第 0 项；后面再跟搜索结果
        const myItem = {
            __myLocation: true,
            name: myLocationCache ? `📍 我的位置（${myLocationCache.name || '已定位'}）` : '📍 使用我的当前位置',
            district: myLocationCache && myLocationCache.source === 'ip' ? 'IP 粗略定位' : '点击使用浏览器精确定位'
        };
        const merged = [myItem, ...(list || [])];
        tips = merged;
        highlight = -1;
        tipsEl.innerHTML = merged.map((t, i) => {
            if (t.__myLocation) {
                return `<div class="route-tip-item my-location" data-index="${i}" title="使用当前定位">
                    <span class="tip-icon">📍</span>
                    <span class="tip-body">
                        <span class="tip-name">${escapeHtml(t.name)}</span>
                        <span class="tip-district">${escapeHtml(t.district)}</span>
                    </span>
                </div>`;
            }
            const district = [t.district, t.address].filter(Boolean).join(' · ');
            const info = classifyTip(t);
            return `<div class="route-tip-item" data-index="${i}" title="${escapeHtml(info.label)}">
                <span class="tip-icon">${info.emoji}</span>
                <span class="tip-body">
                    <span class="tip-name">${escapeHtml(t.name || '')}</span>
                    ${district ? `<span class="tip-district">${escapeHtml(district)}</span>` : ''}
                </span>
            </div>`;
        }).join('');
        // 若没搜索结果且不是空输入态，加一句无匹配提示
        if ((!list || !list.length) && inputEl.value.trim()) {
            tipsEl.innerHTML += '<div class="route-tip-empty">无匹配结果</div>';
        }
        tipsEl.classList.add('active');
        tipsEl.querySelectorAll('.route-tip-item').forEach(el => {
            el.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const idx = parseInt(el.getAttribute('data-index'), 10);
                pickTip(idx);
            });
        });
    }

    function updateHighlight() {
        const items = tipsEl.querySelectorAll('.route-tip-item');
        items.forEach((el, i) => el.classList.toggle('highlight', i === highlight));
        if (highlight >= 0 && items[highlight]) {
            items[highlight].scrollIntoView({ block: 'nearest' });
        }
    }

    function pickTip(idx) {
        const tip = tips[idx];
        if (!tip) return;
        // "📍 我的位置" 特殊项
        if (tip.__myLocation) {
            // 缓存命中直接用，否则触发一次定位
            (myLocationCache
                ? Promise.resolve(myLocationCache)
                : getMyLocation({ fresh: true })
            ).then(loc => {
                if (!loc) {
                    alert('无法获取当前位置：浏览器定位被拒绝且 IP 定位失败');
                    return;
                }
                applyPoint(loc.latlng, loc.name);
                exitEdit();
            });
            return;
        }
        const name = tip.name || '';
        // 有坐标直接用
        if (tip.location && typeof tip.location === 'string' && tip.location.includes(',')) {
            const [lngStr, latStr] = tip.location.split(',');
            const lng = parseFloat(lngStr);
            const lat = parseFloat(latStr);
            if (!isNaN(lng) && !isNaN(lat)) {
                applyPoint(L.latLng(lat, lng), name);
                exitEdit();
                return;
            }
        }
        // 无坐标（多为纯地名/行政区）：退化到 geocode
        geocodeAndApply(name, tip.district || '');
    }

    async function geocodeAndApply(keyword, district) {
        if (!checkKey()) return;
        try {
            // 拼上 district 让地址更唯一
            const address = district ? `${district}${keyword}` : keyword;
            const city = getPreferredCity();
            const url = `https://restapi.amap.com/v3/geocode/geo` +
                        `?key=${AMAP_WEB_KEY}&address=${encodeURIComponent(address)}` +
                        (city ? `&city=${encodeURIComponent(city)}` : '');
            const resp = await fetch(url);
            const data = await resp.json();
            if (data.status === '1' && data.geocodes && data.geocodes.length) {
                const [lng, lat] = data.geocodes[0].location.split(',').map(Number);
                applyPoint(L.latLng(lat, lng), keyword);
                exitEdit();
            } else {
                alert('未找到该位置的坐标，请换个关键字试试');
            }
        } catch (err) {
            console.warn('geocode 失败:', err);
            alert('地理编码失败：' + err.message);
        }
    }

    // 获取联想时优先使用的城市：路径规划起点城市 > POI 城市下拉 > 空
    function getPreferredCity() {
        const fromRoute = (routeCityInput && routeCityInput.value || '').trim();
        if (fromRoute) return fromRoute;
        if (typeof poiCityEl !== 'undefined' && poiCityEl && poiCityEl.value) {
            return poiCityEl.value.trim();
        }
        return '';
    }

    async function fetchTips(keyword) {
        if (!checkKey()) return;
        if (abortCtl) abortCtl.abort();
        abortCtl = new AbortController();
        try {
            const city = getPreferredCity();
            const center = map.getCenter();
            const locOrCity = city
                ? `&city=${encodeURIComponent(city)}&citylimit=true`
                : `&location=${center.lng.toFixed(6)},${center.lat.toFixed(6)}`;
            const url = `https://restapi.amap.com/v3/assistant/inputtips` +
                        `?key=${AMAP_WEB_KEY}` +
                        `&keywords=${encodeURIComponent(keyword)}` +
                        locOrCity +
                        `&datatype=all`;
            const resp = await fetch(url, { signal: abortCtl.signal });
            const data = await resp.json();
            if (data.status !== '1') {
                console.warn('路径规划联想接口返回异常:', data.info);
                hideTips();
                return;
            }
            const list = (data.tips || []).filter(t => t && t.name).slice(0, 10);
            renderTips(list);
        } catch (err) {
            if (err.name === 'AbortError') return;
            console.warn('路径规划联想失败:', err);
            hideTips();
        }
    }

    // 点击文本 -> 进入编辑
    textEl.addEventListener('click', () => enterEdit());

    inputEl.addEventListener('input', () => {
        const kw = inputEl.value.trim();
        clearTimeout(debounceTimer);
        if (!kw) {
            // 清空时仍展示"📍 我的位置"固定项
            renderTips([]);
            return;
        }
        debounceTimer = setTimeout(() => fetchTips(kw), 300);
    });

    inputEl.addEventListener('keydown', (e) => {
        const active = tipsEl.classList.contains('active') && tips.length > 0;
        if (e.key === 'ArrowDown' && active) {
            e.preventDefault();
            highlight = (highlight + 1) % tips.length;
            updateHighlight();
        } else if (e.key === 'ArrowUp' && active) {
            e.preventDefault();
            highlight = (highlight - 1 + tips.length) % tips.length;
            updateHighlight();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (active && highlight >= 0) {
                pickTip(highlight);
            } else if (inputEl.value.trim()) {
                // 没有 tip 高亮时：把输入当地址去 geocode
                geocodeAndApply(inputEl.value.trim(), '');
            }
        } else if (e.key === 'Escape') {
            exitEdit();
        }
    });

    // 失焦：延迟关闭（让 mousedown 的选择先触发）
    inputEl.addEventListener('blur', () => {
        setTimeout(() => {
            if (!tipsEl.contains(document.activeElement)) {
                exitEdit();
            }
        }, 150);
    });

    return { enterEdit, exitEdit, hideTips };
}

const routeOriginInputCtl = createRoutePointInputController('origin');
const routeDestInputCtl = createRoutePointInputController('destination');

// 点击其他区域时主动收起联想
document.addEventListener('click', (e) => {
    if (!routeOriginInputWrap.contains(e.target) && !routeOriginTextEl.contains(e.target)) {
        routeOriginInputCtl.hideTips();
    }
    if (!routeDestInputWrap.contains(e.target) && !routeDestTextEl.contains(e.target)) {
        routeDestInputCtl.hideTips();
    }
});

// ========================================================================
// 16. 地图右键菜单（从这里出发 / 到这里去 / 复制坐标 / 以此为中心）
// ========================================================================
const contextMenuEl = document.getElementById('map-context-menu');
const menuCoordEl = document.getElementById('menu-coord');
const menuAddressEl = document.getElementById('menu-address');
let contextMenuLatLng = null;
let menuAddressReqId = 0; // 用于丢弃过期的逆地理请求

// 显示右键菜单
function showContextMenu(containerPoint, latlng) {
    contextMenuLatLng = latlng;
    menuCoordEl.textContent = `${latlng.lng.toFixed(6)}, ${latlng.lat.toFixed(6)}`;

    // 先清空/显示"加载中"
    menuAddressEl.classList.remove('empty');
    menuAddressEl.classList.add('loading');
    menuAddressEl.textContent = '📍 获取地址中...';

    // 先显示以便测量尺寸
    contextMenuEl.classList.add('active');

    // 边界检测，防止菜单超出窗口
    const mapRect = map.getContainer().getBoundingClientRect();
    const menuRect = contextMenuEl.getBoundingClientRect();
    let left = mapRect.left + containerPoint.x;
    let top = mapRect.top + containerPoint.y;
    if (left + menuRect.width > window.innerWidth - 10) {
        left = window.innerWidth - menuRect.width - 10;
    }
    if (top + menuRect.height > window.innerHeight - 10) {
        top = window.innerHeight - menuRect.height - 10;
    }
    contextMenuEl.style.left = left + 'px';
    contextMenuEl.style.top = top + 'px';

    // 异步请求逆地理地址，更新到菜单
    const reqId = ++menuAddressReqId;
    reverseGeocode(latlng).then(addr => {
        // 如果期间用户又打开了另一个位置的菜单，丢弃这次结果
        if (reqId !== menuAddressReqId) return;
        if (!contextMenuEl.classList.contains('active')) return;
        menuAddressEl.classList.remove('loading');
        if (addr) {
            menuAddressEl.textContent = '📍 ' + addr;
        } else {
            menuAddressEl.classList.add('empty');
            menuAddressEl.textContent = '';
        }
    }).catch(() => {
        if (reqId !== menuAddressReqId) return;
        menuAddressEl.classList.remove('loading');
        menuAddressEl.classList.add('empty');
        menuAddressEl.textContent = '';
    });
}

function hideContextMenu() {
    contextMenuEl.classList.remove('active');
    contextMenuLatLng = null;
    menuAddressReqId++; // 使"正在进行中"的请求失效
}

// 监听地图右键（Leaflet 已封装 contextmenu 事件，触摸长按也会触发）
map.on('contextmenu', (e) => {
    // 阻止浏览器默认右键菜单（Leaflet 已经阻止了地图容器上的默认菜单）
    if (e.originalEvent) e.originalEvent.preventDefault();
    showContextMenu(e.containerPoint, e.latlng);
});

// 点击地图/其他位置 -> 关闭菜单
map.on('click movestart zoomstart', hideContextMenu);
document.addEventListener('click', (e) => {
    if (!contextMenuEl.contains(e.target)) hideContextMenu();
});
// Esc 关闭
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
});

// 逆地理编码（可选），用于给右键选中的点补一个"地址名"
async function reverseGeocode(latlng) {
    if (!AMAP_WEB_KEY || AMAP_WEB_KEY === 'YOUR_AMAP_WEB_KEY_HERE') return '';
    try {
        const url = `https://restapi.amap.com/v3/geocode/regeo` +
                    `?key=${AMAP_WEB_KEY}` +
                    `&location=${latlng.lng.toFixed(6)},${latlng.lat.toFixed(6)}` +
                    `&extensions=base&output=JSON`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (data.status === '1' && data.regeocode) {
            return data.regeocode.formatted_address || '';
        }
    } catch (err) {
        console.warn('逆地理编码失败:', err);
    }
    return '';
}

// 菜单项点击
contextMenuEl.addEventListener('click', async (e) => {
    const item = e.target.closest('.menu-item');
    if (!item || !contextMenuLatLng) return;
    const action = item.getAttribute('data-action');
    const latlng = contextMenuLatLng;
    hideContextMenu();

    switch (action) {
        case 'set-origin': {
            // 先用坐标立即设置，然后异步补地址
            setRouteOrigin(latlng, '');
            const addr = await reverseGeocode(latlng);
            if (addr && routeOrigin
                && routeOrigin.lat === latlng.lat && routeOrigin.lng === latlng.lng) {
                routeOrigin.name = addr;
                updateRoutePointsUI();
                if (routeOriginMarker) {
                    routeOriginMarker.bindPopup(
                        `<b>起点</b><br/>${escapeHtml(addr)}<br/>${latlng.lng.toFixed(6)}, ${latlng.lat.toFixed(6)}`
                    );
                }
            }
            break;
        }
        case 'set-destination': {
            setRouteDestination(latlng, '');
            const addr = await reverseGeocode(latlng);
            if (addr && routeDestination
                && routeDestination.lat === latlng.lat && routeDestination.lng === latlng.lng) {
                routeDestination.name = addr;
                updateRoutePointsUI();
                if (routeDestMarker) {
                    routeDestMarker.bindPopup(
                        `<b>终点</b><br/>${escapeHtml(addr)}<br/>${latlng.lng.toFixed(6)}, ${latlng.lat.toFixed(6)}`
                    );
                }
            }
            break;
        }
        case 'set-waypoint': {
            // 添加途经点（驾车=原生 waypoints；步行/骑行=前端分段拼接；公交不支持）
            await addRouteWaypoint(latlng, '');
            break;
        }
        case 'copy-coord': {
            const text = `${latlng.lng.toFixed(6)}, ${latlng.lat.toFixed(6)}`;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                } else {
                    // 回退：使用临时 textarea
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                }
                // 简单提示
                console.log('已复制坐标:', text);
            } catch (err) {
                console.warn('复制失败:', err);
                alert('复制失败，请手动复制：' + text);
            }
            break;
        }
        case 'center-here': {
            map.panTo(latlng);
            break;
        }
        case 'show-address': {
            // 显示加载 popup
            const loadingPopup = L.popup({ closeOnClick: true, autoClose: true })
                .setLatLng(latlng)
                .setContent('📍 正在获取地址...')
                .openOn(map);
            const addr = await reverseGeocode(latlng);
            const coordText = `${latlng.lng.toFixed(6)}, ${latlng.lat.toFixed(6)}`;
            const popupHtml = addr
                ? `<div style="min-width:200px;">
                       <div style="font-weight:bold;color:#333;margin-bottom:4px;">📍 ${escapeHtml(addr)}</div>
                       <div style="color:#888;font-size:12px;font-family:Menlo,Monaco,monospace;">${coordText}</div>
                       <div style="margin-top:6px;color:#43A047;font-size:12px;">✓ 地址已复制到剪贴板</div>
                   </div>`
                : `<div style="min-width:200px;">
                       <div style="color:#E53935;">未能获取地址（请检查 Key 或网络）</div>
                       <div style="color:#888;font-size:12px;font-family:Menlo,Monaco,monospace;margin-top:4px;">${coordText}</div>
                   </div>`;
            // 关闭旧 popup，打开新的
            map.closePopup(loadingPopup);
            L.popup({ closeOnClick: true, autoClose: true })
                .setLatLng(latlng)
                .setContent(popupHtml)
                .openOn(map);
            // 复制地址（有地址则复制地址，无则复制坐标）
            if (addr) {
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        await navigator.clipboard.writeText(addr);
                    } else {
                        const ta = document.createElement('textarea');
                        ta.value = addr;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                    }
                } catch (_) { /* ignore */ }
            }
            break;
        }
    }
});

// ========================================================================
// 17. POI 详情抽屉 + 图片灯箱
//     展示：名称、分类、电话、地址、评分、营业时间、照片、经纬度
//     数据来源：
//       - 列表已有数据（搜索时 extensions=all 已包含大多数字段）
//       - 需要更完整数据时，再调用 v3/place/detail 补充
// ========================================================================
const poiDrawerEl = document.getElementById('poi-drawer');
const drawerNameEl = document.getElementById('drawer-name');
const drawerTypeEl = document.getElementById('drawer-type');
const drawerBodyEl = document.getElementById('drawer-body');
const drawerCloseEl = document.getElementById('drawer-close');
const drawerLocateBtn = document.getElementById('drawer-locate');
const drawerAsOriginBtn = document.getElementById('drawer-as-origin');
const drawerAsDestBtn = document.getElementById('drawer-as-dest');

const photoLightboxEl = document.getElementById('photo-lightbox');
const photoLightboxImgEl = document.getElementById('photo-lightbox-img');

// 当前抽屉展示的 poi 和经纬度
let currentDrawerPoi = null;
let currentDrawerLatLng = null;

function openPoiDrawer(poi, latlng) {
    currentDrawerPoi = poi;
    currentDrawerLatLng = latlng;

    // 头部
    drawerNameEl.textContent = poi.name || '-';
    drawerTypeEl.textContent = (poi.type || '').replace(/;/g, ' · ');

    // 先渲染已有数据
    drawerBodyEl.innerHTML = renderDrawerBody(poi);

    // 绑定照片点击事件（灯箱）
    bindDrawerPhotoClicks();

    poiDrawerEl.classList.add('active');

    // 如果关键字段缺失，异步拉取详情补全
    const needsFetch = !poi._detailFetched
        && (!poi.photos || poi.photos.length === 0
            || !poi.tel || (Array.isArray(poi.tel) && poi.tel.length === 0)
            || !poi.biz_ext);
    if (needsFetch && poi.id && AMAP_WEB_KEY && AMAP_WEB_KEY !== 'YOUR_AMAP_WEB_KEY_HERE') {
        fetchPoiDetail(poi.id).then(detail => {
            if (!detail) return;
            // 合并到 poi（保留原字段为主，detail 字段补充）
            const merged = Object.assign({}, detail, poi, {
                // 下列字段若原 poi 缺失，则用 detail 的
                photos: (poi.photos && poi.photos.length) ? poi.photos : (detail.photos || []),
                tel: poi.tel || detail.tel || '',
                biz_ext: poi.biz_ext || detail.biz_ext,
                type: poi.type || detail.type || '',
                _detailFetched: true
            });
            // 如果抽屉还停留在同一个 poi 上，则刷新
            if (currentDrawerPoi && currentDrawerPoi.id === poi.id) {
                currentDrawerPoi = merged;
                drawerBodyEl.innerHTML = renderDrawerBody(merged);
                bindDrawerPhotoClicks();
            }
        }).catch(err => {
            console.warn('拉取 POI 详情失败:', err);
        });
    }
}

function closePoiDrawer() {
    poiDrawerEl.classList.remove('active');
    currentDrawerPoi = null;
    currentDrawerLatLng = null;
}

// 渲染抽屉 body 内容
function renderDrawerBody(poi) {
    const parts = [];

    // 照片
    const photos = Array.isArray(poi.photos) ? poi.photos.filter(p => p && p.url) : [];
    if (photos.length > 0) {
        const cls = photos.length === 1 ? 'single' : '';
        parts.push(`
            <div class="drawer-photos ${cls}">
                ${photos.slice(0, 6).map(p => `
                    <img class="photo" src="${escapeAttr(p.url)}" alt="${escapeAttr(p.title || '')}" loading="lazy" />
                `).join('')}
            </div>
        `);
    }

    // 地址
    const address = (typeof poi.address === 'string' && poi.address)
        ? poi.address
        : [poi.pname, poi.cityname, poi.adname].filter(Boolean).join('');
    if (address) {
        parts.push(section('📍 地址', escapeHtml(address)));
    }

    // 电话
    const tel = Array.isArray(poi.tel) ? poi.tel.filter(Boolean).join('、') : (poi.tel || '');
    if (tel && typeof tel === 'string' && tel.trim()) {
        const telLinks = tel.split(/[;、,，]/).map(t => t.trim()).filter(Boolean)
            .map(t => `<a href="tel:${escapeAttr(t)}">${escapeHtml(t)}</a>`).join('、');
        parts.push(section('📞 电话', telLinks));
    }

    // 评分（通常在 biz_ext.rating）
    const rating = poi.biz_ext && poi.biz_ext.rating;
    const cost = poi.biz_ext && poi.biz_ext.cost;
    const ratingHtml = (rating && rating !== '' && rating !== '0')
        ? `<span class="drawer-rating">★ ${escapeHtml(String(rating))}</span>`
        : `<span class="drawer-rating empty">暂无评分</span>`;
    const costHtml = (cost && cost !== '' && cost !== '0')
        ? `<span style="margin-left:10px;color:#555;">人均 ¥${escapeHtml(String(cost))}</span>`
        : '';
    parts.push(section('⭐ 评分', ratingHtml + costHtml));

    // 营业时间（biz_ext.open_time 或 business_area 等）
    const openTime = (poi.biz_ext && poi.biz_ext.open_time)
        || poi.opentime_today
        || poi.opentime_week
        || '';
    if (openTime) {
        parts.push(section('🕒 营业时间', escapeHtml(openTime)));
    }

    // 所属商圈 / 分类
    if (poi.business_area) {
        parts.push(section('🏬 所属商圈', escapeHtml(poi.business_area)));
    }
    if (poi.type) {
        parts.push(section('🏷️ 分类', escapeHtml(poi.type.replace(/;/g, ' · '))));
    }

    // 经纬度
    const [lngStr, latStr] = (poi.location || '').split(',');
    if (lngStr && latStr) {
        parts.push(section('🧭 经纬度',
            `<span style="font-family:Menlo,Monaco,monospace;font-size:12px;">${escapeHtml(lngStr)}, ${escapeHtml(latStr)}</span>
             <a href="javascript:void(0)" id="drawer-copy-coord" style="margin-left:10px;font-size:12px;">📋 复制</a>`
        ));
    }

    if (parts.length === 0) {
        return `<div class="drawer-empty">暂无更多详情信息</div>`;
    }
    return parts.join('');
}

function section(label, content) {
    return `
        <div class="drawer-section">
            <div class="section-label">${label}</div>
            <div class="section-content">${content}</div>
        </div>
    `;
}

// 绑定抽屉内的交互（照片灯箱、复制坐标）
function bindDrawerPhotoClicks() {
    drawerBodyEl.querySelectorAll('.drawer-photos .photo').forEach(img => {
        img.addEventListener('click', () => {
            photoLightboxImgEl.src = img.src;
            photoLightboxEl.classList.add('active');
        });
    });
    const copyEl = drawerBodyEl.querySelector('#drawer-copy-coord');
    if (copyEl && currentDrawerPoi) {
        copyEl.addEventListener('click', async () => {
            const text = currentDrawerPoi.location || '';
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                } else {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                }
                copyEl.textContent = '✓ 已复制';
                setTimeout(() => { copyEl.textContent = '📋 复制'; }, 1500);
            } catch (err) {
                alert('复制失败：' + text);
            }
        });
    }
}

// 调用高德 place/detail 获取 POI 详情（补充照片、评分、营业时间等）
async function fetchPoiDetail(poiId) {
    const url = `https://restapi.amap.com/v3/place/detail` +
                `?key=${AMAP_WEB_KEY}` +
                `&id=${encodeURIComponent(poiId)}` +
                `&extensions=all&output=JSON`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== '1') return null;
    const pois = data.pois || [];
    return pois[0] || null;
}

// HTML 属性转义（用于 src/alt 等）
function escapeAttr(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ==== 抽屉事件绑定 ====
drawerCloseEl.addEventListener('click', closePoiDrawer);

drawerLocateBtn.addEventListener('click', () => {
    if (currentDrawerLatLng) {
        map.setView(currentDrawerLatLng, 18);
    }
});

drawerAsOriginBtn.addEventListener('click', () => {
    if (currentDrawerLatLng && currentDrawerPoi) {
        setRouteOrigin(currentDrawerLatLng, currentDrawerPoi.name || '');
    }
});

drawerAsDestBtn.addEventListener('click', () => {
    if (currentDrawerLatLng && currentDrawerPoi) {
        setRouteDestination(currentDrawerLatLng, currentDrawerPoi.name || '');
    }
});

// C: POI 抽屉"设为途经点"按钮
const drawerAsWaypointBtn = document.getElementById('drawer-as-waypoint');
if (drawerAsWaypointBtn) {
    drawerAsWaypointBtn.addEventListener('click', () => {
        if (currentDrawerLatLng && currentDrawerPoi) {
            // addRouteWaypoint 内部已自动处理：上限校验、提示、自动重规划
            addRouteWaypoint(currentDrawerLatLng, currentDrawerPoi.name || '');
        }
    });
}

// Esc 关闭抽屉/灯箱
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (photoLightboxEl.classList.contains('active')) {
            photoLightboxEl.classList.remove('active');
            photoLightboxImgEl.src = '';
        } else if (poiDrawerEl.classList.contains('active')) {
            closePoiDrawer();
        }
    }
});

// 点击灯箱背景关闭
photoLightboxEl.addEventListener('click', () => {
    photoLightboxEl.classList.remove('active');
    photoLightboxImgEl.src = '';
});

// ========================================================================
// 18. 测距 / 测面积 工具
//     - 左键点击地图 => 添加顶点
//     - 双击 / 回车 / 点击第一个点 => 结束
//     - Esc => 取消本次测量
//     - 切换模式或"清除"会清理所有图层
// ========================================================================
const measureDistanceBtn = document.getElementById('measure-distance-btn');
const measureAreaBtn = document.getElementById('measure-area-btn');
const measureClearBtn = document.getElementById('measure-clear-btn');
const measureHintEl = document.getElementById('measure-hint');

// 'idle' | 'distance' | 'area'
let measureMode = 'idle';
let measurePoints = [];              // 当前测量的点序列 [L.LatLng]
let measurePolyline = null;          // 距离模式：动态折线
let measurePolygon = null;           // 面积模式：动态多边形
let measurePreviewLine = null;       // 鼠标预览线（从最后一点到鼠标）
let measureVertexMarkers = [];       // 顶点小圆点
let measureTooltips = [];            // 每段/总计的 tooltip
let measureFinalLayers = [];         // 完成后保留的图层（下次清除才删除）

// ---- 几何工具 ----
// 球面距离（米）：复用 Leaflet 的 distanceTo（底层是 haversine）
function measureDistance(a, b) {
    return a.distanceTo(b);
}

// 折线总距离
function totalPolylineDistance(pts) {
    let sum = 0;
    for (let i = 1; i < pts.length; i++) sum += measureDistance(pts[i - 1], pts[i]);
    return sum;
}

// 球面多边形面积（平方米）——使用 L.GeometryUtil 的简化实现
// Leaflet 没有自带此函数，这里用球面 Excess 公式近似
function sphericalPolygonArea(latlngs) {
    if (!latlngs || latlngs.length < 3) return 0;
    const R = 6378137; // 地球半径（米）
    let area = 0;
    const n = latlngs.length;
    for (let i = 0; i < n; i++) {
        const p1 = latlngs[i];
        const p2 = latlngs[(i + 1) % n];
        area += (p2.lng - p1.lng) * Math.PI / 180 *
                (2 + Math.sin(p1.lat * Math.PI / 180) + Math.sin(p2.lat * Math.PI / 180));
    }
    area = Math.abs(area * R * R / 2);
    return area;
}

function formatLen(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(2)} 公里` : `${m.toFixed(1)} 米`;
}
function formatArea(m2) {
    if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toFixed(2)} 平方公里`;
    if (m2 >= 10_000)   return `${(m2 / 10_000).toFixed(2)} 公顷 (${(m2 / 1_000_000).toFixed(3)} km²)`;
    return `${m2.toFixed(1)} 平方米`;
}

// ---- 辅助函数 ----
function setMeasureHint(text, visible = true) {
    measureHintEl.textContent = text;
    measureHintEl.classList.toggle('active', !!(visible && text));
}

function setMeasureMode(mode) {
    // 切换模式时清空当前进行中的测量
    cancelCurrentMeasurement(true);

    measureMode = mode;
    measureDistanceBtn.classList.toggle('active', mode === 'distance');
    measureAreaBtn.classList.toggle('active', mode === 'area');

    if (mode === 'distance') {
        setMeasureHint('🖱️ 左键点击添加顶点，双击/回车结束，Esc 取消');
        map.getContainer().style.cursor = 'crosshair';
        map.doubleClickZoom.disable();
    } else if (mode === 'area') {
        setMeasureHint('🖱️ 左键点击围出多边形，双击/回车结束（至少 3 点），Esc 取消');
        map.getContainer().style.cursor = 'crosshair';
        map.doubleClickZoom.disable();
    } else {
        setMeasureHint('', false);
        map.getContainer().style.cursor = '';
        map.doubleClickZoom.enable();
    }
}

// 清理当前进行中的绘制（不清除已完成的测量结果）
function cancelCurrentMeasurement(silent = false) {
    if (measurePolyline) { map.removeLayer(measurePolyline); measurePolyline = null; }
    if (measurePolygon)  { map.removeLayer(measurePolygon);  measurePolygon = null; }
    if (measurePreviewLine) { map.removeLayer(measurePreviewLine); measurePreviewLine = null; }
    measureVertexMarkers.forEach(m => map.removeLayer(m));
    measureVertexMarkers = [];
    measureTooltips.forEach(t => map.removeLayer(t));
    measureTooltips = [];
    measurePoints = [];
    if (!silent) setMeasureHint('', false);
}

// 清除所有（含已完成的）
function clearAllMeasurements() {
    cancelCurrentMeasurement(true);
    measureFinalLayers.forEach(l => map.removeLayer(l));
    measureFinalLayers = [];
    setMeasureMode('idle');
}

// 顶点图标
function createMeasureVertexIcon(isFirst) {
    const color = isFirst ? '#43A047' : '#1E88E5';
    return L.divIcon({
        className: 'measure-vertex',
        html: `<div style="width:10px;height:10px;background:${color};border:2px solid #fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></div>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7]
    });
}

// 添加一个顶点
function addMeasureVertex(latlng) {
    measurePoints.push(latlng);

    // 顶点标记
    const vMarker = L.marker(latlng, {
        icon: createMeasureVertexIcon(measurePoints.length === 1),
        interactive: true,
        keyboard: false
    }).addTo(map);
    // 点击第一个顶点 => 尝试闭合（面积模式）/ 结束（距离模式）
    if (measurePoints.length === 1) {
        vMarker.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            finishMeasurement();
        });
    }
    measureVertexMarkers.push(vMarker);

    updateMeasureShape();
}

// 更新折线/多边形
function updateMeasureShape(previewLatlng = null) {
    if (measureMode === 'distance') {
        const pts = previewLatlng ? [...measurePoints, previewLatlng] : [...measurePoints];
        if (pts.length >= 2) {
            if (!measurePolyline) {
                measurePolyline = L.polyline(pts, {
                    color: '#1E88E5', weight: 4, opacity: 0.85,
                    dashArray: previewLatlng ? '6,6' : null
                }).addTo(map);
            } else {
                measurePolyline.setLatLngs(pts);
                measurePolyline.setStyle({ dashArray: previewLatlng ? '6,6' : null });
            }
        }
        updateDistanceTooltips(previewLatlng);
    } else if (measureMode === 'area') {
        const pts = previewLatlng ? [...measurePoints, previewLatlng] : [...measurePoints];
        if (pts.length >= 2) {
            if (!measurePolygon) {
                measurePolygon = L.polygon(pts, {
                    color: '#43A047', weight: 3, opacity: 0.9,
                    fillColor: '#A5D6A7', fillOpacity: 0.25,
                    dashArray: previewLatlng ? '6,6' : null
                }).addTo(map);
            } else {
                measurePolygon.setLatLngs(pts);
                measurePolygon.setStyle({ dashArray: previewLatlng ? '6,6' : null });
            }
        }
        updateAreaTooltip(previewLatlng);
    }
}

// 距离模式 tooltip：每段中点显示分段距离 + 最后一点显示总计
function updateDistanceTooltips(previewLatlng) {
    measureTooltips.forEach(t => map.removeLayer(t));
    measureTooltips = [];

    const pts = previewLatlng ? [...measurePoints, previewLatlng] : [...measurePoints];
    if (pts.length < 2) return;

    // 段距离（只显示已确定的段，不显示预览段的数字，避免闪烁过多）
    const finalCount = measurePoints.length;
    for (let i = 1; i < pts.length; i++) {
        const mid = L.latLng(
            (pts[i - 1].lat + pts[i].lat) / 2,
            (pts[i - 1].lng + pts[i].lng) / 2
        );
        const d = measureDistance(pts[i - 1], pts[i]);
        const isPreviewSeg = (i >= finalCount); // 预览段
        const t = L.tooltip({
            permanent: true,
            direction: 'center',
            className: 'measure-tooltip',
            offset: [0, 0]
        }).setLatLng(mid).setContent(isPreviewSeg ? `<i>${formatLen(d)}</i>` : formatLen(d)).addTo(map);
        measureTooltips.push(t);
    }

    // 总距离
    const total = totalPolylineDistance(pts);
    const last = pts[pts.length - 1];
    const totalTip = L.tooltip({
        permanent: true,
        direction: 'right',
        className: 'measure-tooltip total',
        offset: [10, 0]
    }).setLatLng(last).setContent('总计 ' + formatLen(total)).addTo(map);
    measureTooltips.push(totalTip);
}

// 面积模式 tooltip：质心显示面积 + 周长
function updateAreaTooltip(previewLatlng) {
    measureTooltips.forEach(t => map.removeLayer(t));
    measureTooltips = [];

    const pts = previewLatlng ? [...measurePoints, previewLatlng] : [...measurePoints];
    if (pts.length < 3) return;

    // 质心
    let lat = 0, lng = 0;
    pts.forEach(p => { lat += p.lat; lng += p.lng; });
    const centroid = L.latLng(lat / pts.length, lng / pts.length);

    const area = sphericalPolygonArea(pts);
    // 周长（闭合）
    let perim = totalPolylineDistance(pts) + measureDistance(pts[pts.length - 1], pts[0]);

    const t = L.tooltip({
        permanent: true,
        direction: 'center',
        className: 'measure-tooltip area',
        offset: [0, 0]
    }).setLatLng(centroid)
      .setContent(`📐 ${formatArea(area)}<br/>周长 ${formatLen(perim)}`)
      .addTo(map);
    measureTooltips.push(t);
}

// 结束当前测量（保留结果）
function finishMeasurement() {
    if (measureMode === 'distance') {
        if (measurePoints.length < 2) return;
        // 移除预览线
        if (measurePreviewLine) { map.removeLayer(measurePreviewLine); measurePreviewLine = null; }
        // 最终 polyline 改为实线
        if (measurePolyline) {
            measurePolyline.setStyle({ dashArray: null });
            measureFinalLayers.push(measurePolyline);
            measurePolyline = null;
        }
        updateDistanceTooltips(null);
        // 保留 tooltip 和顶点到 finalLayers
        measureTooltips.forEach(t => measureFinalLayers.push(t));
        measureVertexMarkers.forEach(m => measureFinalLayers.push(m));
        measureTooltips = [];
        measureVertexMarkers = [];
        measurePoints = [];
        setMeasureMode('idle');
    } else if (measureMode === 'area') {
        if (measurePoints.length < 3) {
            // 少于 3 点取消
            cancelCurrentMeasurement();
            setMeasureMode('idle');
            return;
        }
        if (measurePolygon) {
            measurePolygon.setStyle({ dashArray: null });
            measureFinalLayers.push(measurePolygon);
            measurePolygon = null;
        }
        updateAreaTooltip(null);
        measureTooltips.forEach(t => measureFinalLayers.push(t));
        measureVertexMarkers.forEach(m => measureFinalLayers.push(m));
        measureTooltips = [];
        measureVertexMarkers = [];
        measurePoints = [];
        setMeasureMode('idle');
    }
}

// ---- 地图事件 ----
map.on('click', (e) => {
    if (measureMode === 'idle') return;
    // 阻止冒泡到调试 popup（保持功能独立）
    addMeasureVertex(e.latlng);
});

map.on('mousemove', (e) => {
    if (measureMode === 'idle' || measurePoints.length === 0) return;
    updateMeasureShape(e.latlng);
});

map.on('dblclick', (e) => {
    if (measureMode === 'idle') return;
    // 避免 Leaflet 默认的双击缩放
    L.DomEvent.stop(e);
    finishMeasurement();
});

// 进入测量模式时禁用双击缩放（在 setMeasureMode 内已直接处理）

// 键盘：Enter 结束，Esc 取消
document.addEventListener('keydown', (e) => {
    if (measureMode === 'idle') return;
    if (e.key === 'Enter') {
        e.preventDefault();
        finishMeasurement();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelCurrentMeasurement();
        setMeasureMode('idle');
    }
});

// ---- 按钮事件 ----
measureDistanceBtn.addEventListener('click', () => {
    setMeasureMode(measureMode === 'distance' ? 'idle' : 'distance');
});
measureAreaBtn.addEventListener('click', () => {
    setMeasureMode(measureMode === 'area' ? 'idle' : 'area');
});
measureClearBtn.addEventListener('click', clearAllMeasurements);

// ========================================================================
// 19. 鹰眼（MiniMap）—— 手写实现（不依赖第三方插件）
//     在右下角小地图上展示主地图的全貌 + 红色视野框
// ========================================================================
(function setupMiniMap() {
    const miniContainerEl = document.getElementById('minimap-container');
    const miniMapEl = document.getElementById('minimap');
    const miniToggleEl = document.getElementById('minimap-toggle');
    if (!miniContainerEl || !miniMapEl) return;

    // 鹰眼用单独的矢量瓦片（用一个新的 tileLayer 实例，否则会被主地图 moveend 干扰）
    const miniTile = L.tileLayer(
        'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
        { subdomains: ['1', '2', '3', '4'], maxZoom: 18, minZoom: 1 }
    );

    const miniMap = L.map(miniMapEl, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,           // 不允许交互（可改为 true 让用户在鹰眼里拖动主图中心）
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false,
        tap: false,
        layers: [miniTile]
    });

    // 视野框（一个 rectangle，填充 + 边框）
    const viewportRect = L.rectangle(map.getBounds(), {
        color: '#E53935',
        weight: 2,
        fillColor: '#E53935',
        fillOpacity: 0.1,
        interactive: false,
        className: 'minimap-viewport'
    }).addTo(miniMap);

    // 主图与鹰眼的缩放差：鹰眼始终比主图缩小 N 级
    const ZOOM_OFFSET = 5;

    function syncMiniMap() {
        const mainZoom = map.getZoom();
        const mainCenter = map.getCenter();
        const miniZoom = Math.max(1, mainZoom - ZOOM_OFFSET);
        miniMap.setView(mainCenter, miniZoom, { animate: false });
        viewportRect.setBounds(map.getBounds());
    }

    // 初始化 & 监听主图变化
    // 先给一个默认视图，避免 miniMap 没有 center 报错
    miniMap.setView(map.getCenter(), Math.max(1, map.getZoom() - ZOOM_OFFSET));
    // 首次容器尺寸可能为 0，延迟一下确保 tile 正确渲染
    setTimeout(() => miniMap.invalidateSize(), 100);

    map.on('move zoom', syncMiniMap);
    // 调用一次同步
    syncMiniMap();

    // 收起/展开
    let collapsed = false;
    miniToggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        collapsed = !collapsed;
        miniContainerEl.classList.toggle('collapsed', collapsed);
        miniToggleEl.textContent = collapsed ? '🗺' : '−';
        miniToggleEl.title = collapsed ? '展开鹰眼' : '收起鹰眼';
        if (!collapsed) {
            // 展开后需要触发 invalidateSize，否则 tile 不渲染
            setTimeout(() => {
                miniMap.invalidateSize();
                syncMiniMap();
            }, 250);
        }
    });

    // 全屏切换后也需要 invalidateSize
    map.on('fullscreenchange', () => {
        setTimeout(() => miniMap.invalidateSize(), 300);
    });
})();

// ========================================================================
// 20. 搜索历史 / 收藏 —— UI 部分
//     纯存储函数（loadHistory / addSearchHistory / toggleFavorite 等）
//     已迁出到 src/utils/storage.js，本文件顶部已 import。
// ========================================================================

// 包装 clearHistory：在纯存储操作后刷新 UI
function clearHistoryAndRefresh() {
    clearHistory();
    renderPoiHistory();
}

// —— 隐藏下拉 ——
function hidePoiHistory() {
    if (!poiHistoryEl) return;
    poiHistoryEl.classList.remove('active');
    poiHistoryEl.innerHTML = '';
}

// —— 渲染历史/收藏下拉 ——
function renderPoiHistory() {
    if (!poiHistoryEl) return;
    const history = loadHistory();
    const favs = loadFavorites();

    if (history.length === 0 && favs.length === 0) {
        poiHistoryEl.innerHTML = `<div class="empty-tip">暂无搜索历史，搜索一次试试吧 🔍</div>`;
        poiHistoryEl.classList.add('active');
        return;
    }

    let html = '';

    // ⭐ 收藏
    if (favs.length > 0) {
        html += `<div class="history-section" data-section="fav">`;
        html += `<div class="section-header"><span>⭐ 收藏（${favs.length}）</span></div>`;
        favs.forEach((item, i) => {
            html += renderHistoryItemHtml(item, true, i);
        });
        html += `</div>`;
    }

    // 🕑 历史
    if (history.length > 0) {
        html += `<div class="history-section" data-section="history">`;
        html += `<div class="section-header">
            <span>🕑 最近搜索（${history.length}）</span>
            <button class="clear-btn" data-action="clear-history">清空</button>
        </div>`;
        history.forEach((item, i) => {
            html += renderHistoryItemHtml(item, false, i);
        });
        html += `</div>`;
    }

    poiHistoryEl.innerHTML = html;
    poiHistoryEl.classList.add('active');

    // —— 事件绑定 ——
    // 点击条目：填入输入框并按原参数搜索
    poiHistoryEl.querySelectorAll('.history-item').forEach((el) => {
        el.addEventListener('mousedown', (e) => {
            // 点的是收藏按钮则不触发整行点击
            if (e.target.closest('.hi-fav')) return;
            e.preventDefault();
            const keyword = el.getAttribute('data-keyword');
            const mode = el.getAttribute('data-mode') || 'nearby';
            const city = el.getAttribute('data-city') || '';
            const types = el.getAttribute('data-types') || '';
            poiInput.value = keyword;
            // 同步下拉选中
            if (city && poiCityEl) {
                let exists = false;
                for (const opt of poiCityEl.options) {
                    if (opt.value === city) { exists = true; break; }
                }
                if (!exists) {
                    const newOpt = document.createElement('option');
                    newOpt.value = city;
                    newOpt.textContent = city;
                    const customOpt = poiCityEl.querySelector('option[value="__custom__"]');
                    poiCityEl.insertBefore(newOpt, customOpt);
                }
                poiCityEl.value = city;
            }
            if (types && poiCategoryEl) {
                poiCategoryEl.value = types;
            }
            hidePoiHistory();
            searchPOI(true, { mode });
        });
    });

    // 点击星标：切换收藏
    poiHistoryEl.querySelectorAll('.hi-fav').forEach((star) => {
        star.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const parent = star.closest('.history-item');
            if (!parent) return;
            const keyword = parent.getAttribute('data-keyword');
            toggleFavorite(keyword, {
                mode: parent.getAttribute('data-mode') || 'nearby',
                city: parent.getAttribute('data-city') || '',
                types: parent.getAttribute('data-types') || ''
            });
            renderPoiHistory(); // 重新渲染，保持下拉打开
        });
    });

    // 清空历史
    const clearBtn = poiHistoryEl.querySelector('[data-action="clear-history"]');
    if (clearBtn) {
        clearBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (confirm('确定要清空搜索历史吗？（收藏不会被清空）')) {
                clearHistoryAndRefresh();
            }
        });
    }
}

function renderHistoryItemHtml(item, isFav, idx) {
    const fav = isFav || isFavorite(item.keyword);
    const meta = [];
    if (item.city) meta.push(item.city);
    if (item.mode === 'bbox') meta.push('视野内');
    else if (item.mode === 'city') meta.push('按城市');
    const metaStr = meta.join(' · ');
    const icon = isFav ? '⭐' : '🕑';
    return `<div class="history-item"
        data-keyword="${escapeHtml(item.keyword)}"
        data-mode="${escapeHtml(item.mode || '')}"
        data-city="${escapeHtml(item.city || '')}"
        data-types="${escapeHtml(item.types || '')}">
        <span class="hi-icon">${icon}</span>
        <span class="hi-name">${escapeHtml(item.keyword)}</span>
        ${metaStr ? `<span class="hi-meta">${escapeHtml(metaStr)}</span>` : ''}
        <span class="hi-fav ${fav ? 'active' : ''}" title="${fav ? '取消收藏' : '收藏'}">${fav ? '★' : '☆'}</span>
    </div>`;
}


// ============================================================================
// 🎨 绘制分析模块（leaflet-geoman + turf.js）
// 功能：
//   1. 用户可以在地图上手绘多边形/矩形/圆/线/点
//   2. 画完后自动分析：
//      - 图形面积 / 周长 / 中心点 / 距离
//      - 落在图形内的 POI 数量（和 POI 搜索结果联动）
//   3. 支持"缓冲区"工具：围绕线/点生成 N 米缓冲区
//   4. 所有绘制图层保存在独立 FeatureGroup，可一键清空
// ============================================================================

// 绘制图层：所有用户画出来的图形都放这里，方便统一管理/清空
const drawnLayers = new L.FeatureGroup().addTo(map);

// 分析结果面板（固定在右上角，可折叠）
const analysisPanel = L.control({ position: 'topright' });
analysisPanel.onAdd = function () {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control analysis-panel');
    div.style.cssText = 'background:#fff;padding:8px 10px;font-size:12px;max-width:260px;min-width:200px;box-shadow:0 2px 8px rgba(0,0,0,0.15);border-radius:4px;display:none;';
    div.innerHTML = `
        <div style="font-weight:bold;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">
            <span>📐 绘制分析</span>
            <span id="analysis-close" style="cursor:pointer;color:#888;font-size:14px;">×</span>
        </div>
        <div id="analysis-content" style="color:#444;line-height:1.8;"></div>
        <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;">
            <button id="analysis-buffer-btn" style="padding:2px 6px;font-size:11px;border:1px solid #1E88E5;background:#fff;color:#1E88E5;border-radius:3px;cursor:pointer;">+ 缓冲区</button>
            <button id="analysis-clear-btn" style="padding:2px 6px;font-size:11px;border:1px solid #E53935;background:#fff;color:#E53935;border-radius:3px;cursor:pointer;">🗑 清空绘制</button>
        </div>
    `;
    // 阻止地图事件穿透
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    return div;
};
analysisPanel.addTo(map);

// 最近一次选中的绘制图层（用于后续操作，比如缓冲区/分析）
let lastDrawnLayer = null;

// 初始化 Geoman 工具栏（左侧工具条）
map.pm.addControls({
    position: 'topleft',
    drawMarker: true,
    drawCircleMarker: false,
    drawPolyline: true,
    drawRectangle: true,
    drawPolygon: true,
    drawCircle: true,
    drawText: false,
    editMode: true,
    dragMode: true,
    cutPolygon: false,
    removalMode: true,
    rotateMode: false,
});

// 中文化 tooltip
map.pm.setLang('zh');

// 所有新画出来的图形都放进 drawnLayers，并触发分析
map.on('pm:create', (e) => {
    drawnLayers.addLayer(e.layer);
    lastDrawnLayer = e.layer;
    bindDrawnLayerPopup(e.layer);
    analyzeDrawnLayer(e.layer);
    saveDrawnLayersToStorage();
});

// 编辑后（拖动/拉伸）重新分析
map.on('pm:edit', (e) => {
    if (lastDrawnLayer) analyzeDrawnLayer(lastDrawnLayer);
    saveDrawnLayersToStorage();
});
drawnLayers.on('pm:edit', (e) => {
    analyzeDrawnLayer(e.layer);
    bindDrawnLayerPopup(e.layer);
    saveDrawnLayersToStorage();
});

// 删除图形时同步到本地存储
map.on('pm:remove', (e) => {
    try { drawnLayers.removeLayer(e.layer); } catch (_) {}
    if (lastDrawnLayer === e.layer) lastDrawnLayer = null;
    saveDrawnLayersToStorage();
});

// 把 leaflet 图层转成 turf Feature（兼容 Polygon/Circle/Line/Point/Rectangle）
function leafletLayerToTurf(layer) {
    if (layer instanceof L.Circle) {
        const c = layer.getLatLng();
        const radiusMeters = layer.getRadius();
        // 用 turf.circle 近似成多边形（64 段）
        return turf.circle([c.lng, c.lat], radiusMeters / 1000, { steps: 64, units: 'kilometers' });
    }
    if (layer instanceof L.Polygon) {
        // L.Rectangle 也继承自 L.Polygon
        const latlngs = layer.getLatLngs()[0]; // 外环
        const coords = latlngs.map(ll => [ll.lng, ll.lat]);
        // 闭合环
        if (coords.length && (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1])) {
            coords.push(coords[0]);
        }
        return turf.polygon([coords]);
    }
    if (layer instanceof L.Polyline) {
        const latlngs = layer.getLatLngs();
        const coords = latlngs.map(ll => [ll.lng, ll.lat]);
        return turf.lineString(coords);
    }
    if (layer instanceof L.Marker) {
        const ll = layer.getLatLng();
        return turf.point([ll.lng, ll.lat]);
    }
    return null;
}

// 格式化面积（m² / km²）
function fmtArea(m2) {
    if (m2 < 1e6) return m2.toFixed(1) + ' m²';
    return (m2 / 1e6).toFixed(3) + ' km²';
}
// 格式化长度（m / km）
function fmtLength(m) {
    if (m < 1000) return m.toFixed(1) + ' m';
    return (m / 1000).toFixed(3) + ' km';
}

// 对绘制图层做分析，并更新右上角面板
function analyzeDrawnLayer(layer) {
    const contentEl = document.getElementById('analysis-content');
    const panelEl = document.querySelector('.analysis-panel');
    if (!contentEl || !panelEl) return;
    panelEl.style.display = 'block';

    const feat = leafletLayerToTurf(layer);
    if (!feat) {
        contentEl.innerHTML = '<span style="color:#888;">暂不支持的图形类型</span>';
        return;
    }

    const type = feat.geometry.type;
    const lines = [];

    if (type === 'Polygon') {
        const area = turf.area(feat);                          // m²
        const perim = turf.length(turf.polygonToLine(feat), { units: 'meters' });
        const centroid = turf.centroid(feat).geometry.coordinates;
        lines.push(`<div><b>类型：</b>多边形</div>`);
        lines.push(`<div><b>面积：</b>${fmtArea(area)}</div>`);
        lines.push(`<div><b>周长：</b>${fmtLength(perim)}</div>`);
        lines.push(`<div><b>中心：</b>${centroid[1].toFixed(5)}, ${centroid[0].toFixed(5)}</div>`);

        // POI 计数：统计 poiLastPois 中落入多边形内的点数
        const inside = countPoisInPolygon(feat);
        if (inside.total > 0) {
            const topCat = Object.entries(inside.byCategory)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([k, v]) => `${escapeHtml(k)} ${v}`)
                .join(' / ');
            lines.push(`<div style="margin-top:4px;padding-top:4px;border-top:1px dashed #ddd;"><b>📍 圈内 POI：</b>${inside.count}/${inside.sampleSize}</div>`);
            if (topCat) lines.push(`<div style="color:#666;font-size:11px;">${topCat}</div>`);
        } else if (inside.sampleSize === 0) {
            lines.push(`<div style="margin-top:4px;color:#999;font-size:11px;">（先搜索一次 POI，再画范围即可统计）</div>`);
        } else {
            lines.push(`<div style="margin-top:4px;color:#999;font-size:11px;">圈内暂无 POI（共扫描 ${inside.sampleSize} 条）</div>`);
        }
    } else if (type === 'LineString') {
        const len = turf.length(feat, { units: 'meters' });
        lines.push(`<div><b>类型：</b>折线</div>`);
        lines.push(`<div><b>总长：</b>${fmtLength(len)}</div>`);
        lines.push(`<div><b>端点数：</b>${feat.geometry.coordinates.length}</div>`);
    } else if (type === 'Point') {
        const [lng, lat] = feat.geometry.coordinates;
        lines.push(`<div><b>类型：</b>标记点</div>`);
        lines.push(`<div><b>坐标：</b>${lat.toFixed(5)}, ${lng.toFixed(5)}</div>`);
    }

    contentEl.innerHTML = lines.join('');
}

// 统计落入多边形内的 POI（基于 poiLastPois）
function countPoisInPolygon(polyFeat) {
    const result = { count: 0, sampleSize: 0, byCategory: {}, total: 0 };
    if (typeof poiLastPois === 'undefined' || !Array.isArray(poiLastPois)) return result;
    result.sampleSize = poiLastPois.length;

    poiLastPois.forEach(poi => {
        // 高德 POI 的 location 为 "lng,lat" 字符串（GCJ-02，本项目瓦片就是 GCJ-02）
        if (!poi || !poi.location) return;
        const [lng, lat] = String(poi.location).split(',').map(Number);
        if (isNaN(lng) || isNaN(lat)) return;
        const pt = turf.point([lng, lat]);
        if (turf.booleanPointInPolygon(pt, polyFeat)) {
            result.count++;
            result.total++;
            const cat = (poi.type || '其他').split(';')[0] || '其他';
            result.byCategory[cat] = (result.byCategory[cat] || 0) + 1;
        }
    });
    return result;
}

// 关闭面板
document.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'analysis-close') {
        const p = document.querySelector('.analysis-panel');
        if (p) p.style.display = 'none';
    }
    if (e.target && e.target.id === 'analysis-clear-btn') {
        drawnLayers.clearLayers();
        lastDrawnLayer = null;
        const p = document.querySelector('.analysis-panel');
        if (p) p.style.display = 'none';
        saveDrawnLayersToStorage();
    }
    if (e.target && e.target.id === 'analysis-buffer-btn') {
        addBufferForLastLayer();
    }
});

// 给最近一个图形加 N 米缓冲区（弹窗输入半径）
function addBufferForLastLayer() {
    if (!lastDrawnLayer) { alert('请先画一个图形'); return; }
    const input = prompt('请输入缓冲区半径（米）', '500');
    if (input === null) return;
    const meters = parseFloat(input);
    if (!meters || meters <= 0) { alert('请输入正确的数字'); return; }

    const feat = leafletLayerToTurf(lastDrawnLayer);
    if (!feat) return;
    try {
        const buf = turf.buffer(feat, meters / 1000, { units: 'kilometers' });
        // 把 GeoJSON 转回 Leaflet 图层
        const bufLayer = L.geoJSON(buf, {
            style: {
                color: '#8E24AA',
                fillColor: '#8E24AA',
                fillOpacity: 0.12,
                weight: 2,
                dashArray: '6 4'
            }
        });
        bufLayer.eachLayer(l => drawnLayers.addLayer(l));
        // 缓冲区就是一个多边形，刷新面板
        const polyLayer = bufLayer.getLayers()[0];
        if (polyLayer) {
            lastDrawnLayer = polyLayer;
            bindDrawnLayerPopup(polyLayer);
            analyzeDrawnLayer(polyLayer);
        }
        saveDrawnLayersToStorage();
    } catch (err) {
        console.error('[buffer] 失败:', err);
        alert('缓冲区生成失败：' + err.message);
    }
}


// ============================================================================
// 🗺️ Choropleth 分级着色模块
// 功能：加载 GeoJSON 面要素（省/市/区） + 数值字段，按值分级填充颜色
// 默认提供一份"中国省级 demo 数据 + 随机模拟值"作为示例
// 用户也可以通过面板输入自定义 GeoJSON URL
// ============================================================================

let choroplethLayer = null;        // 当前 choropleth 图层
let choroplethLegend = null;       // 右下角图例
let choroplethData = null;         // 原始 GeoJSON
let choroplethValueField = 'value';// 数值字段名

// 默认颜色分级（YlOrRd 系列）
const CHOROPLETH_COLORS = ['#ffffb2', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#b10026'];

// 根据数值和 breaks 取颜色
function getChoroplethColor(value, breaks) {
    for (let i = breaks.length - 1; i >= 0; i--) {
        if (value >= breaks[i]) return CHOROPLETH_COLORS[Math.min(i, CHOROPLETH_COLORS.length - 1)];
    }
    return CHOROPLETH_COLORS[0];
}

// 计算分级阈值（等分位数，7 级）
function computeBreaks(values, n = 7) {
    const sorted = values.slice().sort((a, b) => a - b);
    const breaks = [];
    for (let i = 0; i < n; i++) {
        const idx = Math.floor((i / n) * sorted.length);
        breaks.push(sorted[idx]);
    }
    return breaks;
}

// 渲染 Choropleth 图层
function renderChoropleth(geojson, field) {
    // 清理旧图层
    if (choroplethLayer) {
        try { map.removeLayer(choroplethLayer); } catch (e) {}
        choroplethLayer = null;
    }
    if (choroplethLegend) {
        try { map.removeControl(choroplethLegend); } catch (e) {}
        choroplethLegend = null;
    }

    if (!geojson || !geojson.features || !geojson.features.length) {
        alert('GeoJSON 数据为空');
        return;
    }

    // 收集所有要素的数值
    const values = geojson.features
        .map(f => Number(f.properties && f.properties[field]))
        .filter(v => !isNaN(v));
    if (!values.length) {
        alert(`GeoJSON 中未找到字段 "${field}" 的有效数值`);
        return;
    }
    const breaks = computeBreaks(values, CHOROPLETH_COLORS.length);

    // 渲染图层
    choroplethLayer = L.geoJSON(geojson, {
        style: (f) => {
            const v = Number(f.properties && f.properties[field]);
            return {
                fillColor: getChoroplethColor(v, breaks),
                weight: 1,
                color: '#fff',
                fillOpacity: 0.75
            };
        },
        onEachFeature: (f, layer) => {
            const name = f.properties.name || f.properties.NAME || f.properties.adname || '未命名';
            const v = f.properties[field];
            layer.bindTooltip(`<b>${escapeHtml(String(name))}</b><br/>${escapeHtml(field)}：${v}`, { sticky: true });
            layer.on({
                mouseover: (e) => {
                    const l = e.target;
                    l.setStyle({ weight: 3, color: '#333', fillOpacity: 0.9 });
                    l.bringToFront();
                },
                mouseout: (e) => {
                    choroplethLayer.resetStyle(e.target);
                },
                click: (e) => {
                    try { map.fitBounds(e.target.getBounds(), { padding: [30, 30] }); } catch (_) {}
                }
            });
        }
    }).addTo(map);

    // 图例
    choroplethLegend = L.control({ position: 'bottomright' });
    choroplethLegend.onAdd = function () {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control choropleth-legend');
        div.style.cssText = 'background:#fff;padding:8px 10px;font-size:12px;line-height:18px;box-shadow:0 2px 6px rgba(0,0,0,0.15);border-radius:4px;';
        let html = `<div style="font-weight:bold;margin-bottom:4px;">${escapeHtml(field)}</div>`;
        for (let i = CHOROPLETH_COLORS.length - 1; i >= 0; i--) {
            const from = breaks[i];
            const to = i === CHOROPLETH_COLORS.length - 1 ? '+' : breaks[i + 1];
            html += `<div style="display:flex;align-items:center;">
                <span style="display:inline-block;width:16px;height:12px;background:${CHOROPLETH_COLORS[i]};margin-right:6px;border:1px solid #ddd;"></span>
                ${from.toFixed ? from.toFixed(0) : from} ${to === '+' ? '+' : ' – ' + (to.toFixed ? to.toFixed(0) : to)}
            </div>`;
        }
        return div;
    };
    choroplethLegend.addTo(map);

    // 自动适配到图层范围
    try { map.fitBounds(choroplethLayer.getBounds(), { padding: [30, 30] }); } catch (_) {}
}

// 生成一份"中国省级简化 demo 数据 + 随机值"（近似中心点形成的菱形多边形，纯演示用）
function buildDemoProvinceGeoJSON() {
    // 34 个省会/直辖市近似中心（GCJ-02 近似，够用来演示即可）
    const provinces = [
        { name: '北京', lng: 116.405, lat: 39.905 },
        { name: '天津', lng: 117.200, lat: 39.134 },
        { name: '上海', lng: 121.473, lat: 31.230 },
        { name: '重庆', lng: 106.551, lat: 29.563 },
        { name: '河北', lng: 114.502, lat: 38.045 },
        { name: '山西', lng: 112.549, lat: 37.857 },
        { name: '辽宁', lng: 123.429, lat: 41.796 },
        { name: '吉林', lng: 125.325, lat: 43.897 },
        { name: '黑龙江', lng: 126.642, lat: 45.756 },
        { name: '江苏', lng: 118.763, lat: 32.061 },
        { name: '浙江', lng: 120.153, lat: 30.287 },
        { name: '安徽', lng: 117.283, lat: 31.861 },
        { name: '福建', lng: 119.306, lat: 26.075 },
        { name: '江西', lng: 115.892, lat: 28.676 },
        { name: '山东', lng: 117.000, lat: 36.675 },
        { name: '河南', lng: 113.665, lat: 34.758 },
        { name: '湖北', lng: 114.298, lat: 30.584 },
        { name: '湖南', lng: 112.983, lat: 28.113 },
        { name: '广东', lng: 113.281, lat: 23.125 },
        { name: '广西', lng: 108.366, lat: 22.817 },
        { name: '海南', lng: 110.199, lat: 20.044 },
        { name: '四川', lng: 104.066, lat: 30.572 },
        { name: '贵州', lng: 106.713, lat: 26.578 },
        { name: '云南', lng: 102.712, lat: 25.040 },
        { name: '西藏', lng: 91.132, lat: 29.660 },
        { name: '陕西', lng: 108.948, lat: 34.263 },
        { name: '甘肃', lng: 103.823, lat: 36.058 },
        { name: '青海', lng: 101.778, lat: 36.623 },
        { name: '宁夏', lng: 106.278, lat: 38.467 },
        { name: '新疆', lng: 87.617, lat: 43.793 },
        { name: '内蒙古', lng: 111.670, lat: 40.818 },
        { name: '香港', lng: 114.173, lat: 22.320 },
        { name: '澳门', lng: 113.549, lat: 22.198 },
        { name: '台湾', lng: 121.509, lat: 25.044 },
    ];
    const features = provinces.map(p => {
        const r = 1.2; // 近似半径（度）
        const coords = [[
            [p.lng - r, p.lat],
            [p.lng, p.lat + r],
            [p.lng + r, p.lat],
            [p.lng, p.lat - r],
            [p.lng - r, p.lat],
        ]];
        return {
            type: 'Feature',
            properties: {
                name: p.name,
                // 随机生成 0~1000 之间的"模拟指标值"
                value: Math.round(Math.random() * 1000),
                // 另一个维度：人均指标
                per_capita: Math.round(Math.random() * 100)
            },
            geometry: { type: 'Polygon', coordinates: coords }
        };
    });
    return { type: 'FeatureCollection', features };
}

// Choropleth 面板控件（右下角）
const ChoroplethControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control choropleth-control');
        div.style.cssText = 'background:#fff;padding:6px 8px;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,0.15);border-radius:4px;min-width:180px;';
        div.innerHTML = `
            <div style="font-weight:bold;margin-bottom:4px;">🎨 分级着色</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                <button id="choro-demo-btn" style="padding:3px 8px;font-size:11px;border:1px solid #8E24AA;background:#fff;color:#8E24AA;border-radius:3px;cursor:pointer;">演示数据</button>
                <select id="choro-field-select" style="font-size:11px;flex:1;">
                    <option value="value">value</option>
                    <option value="per_capita">per_capita</option>
                </select>
                <button id="choro-clear-btn" style="padding:3px 8px;font-size:11px;border:1px solid #E53935;background:#fff;color:#E53935;border-radius:3px;cursor:pointer;">清除</button>
            </div>
            <div style="margin-top:4px;color:#888;font-size:10px;line-height:1.4;">
                点击「演示数据」加载 34 省菱形示例<br/>切换字段自动重绘
            </div>
        `;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);

        setTimeout(() => {
            const demoBtn = div.querySelector('#choro-demo-btn');
            const fieldSel = div.querySelector('#choro-field-select');
            const clearBtn = div.querySelector('#choro-clear-btn');
            if (demoBtn) demoBtn.addEventListener('click', () => {
                choroplethData = buildDemoProvinceGeoJSON();
                choroplethValueField = fieldSel ? fieldSel.value : 'value';
                renderChoropleth(choroplethData, choroplethValueField);
            });
            if (fieldSel) fieldSel.addEventListener('change', (e) => {
                choroplethValueField = e.target.value;
                if (choroplethData) renderChoropleth(choroplethData, choroplethValueField);
            });
            if (clearBtn) clearBtn.addEventListener('click', () => {
                if (choroplethLayer) { try { map.removeLayer(choroplethLayer); } catch (e) {} choroplethLayer = null; }
                if (choroplethLegend) { try { map.removeControl(choroplethLegend); } catch (e) {} choroplethLegend = null; }
            });
        }, 0);

        return div;
    }
});
map.addControl(new ChoroplethControl());


// ============================================================================
// 🇨🇳 模块 A：真·中国省级边界 GeoJSON 加载（DataV 开源数据）
// - 来源：https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json（约 2MB）
// - 策略：首次 fetch 后写入 localStorage，之后直接走缓存（24h 过期）
// - 字段：properties.name（省名）、properties.adcode（行政区划编码）
// ============================================================================

const REAL_PROVINCE_GEOJSON_URL = 'https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json';
const REAL_PROVINCE_CACHE_KEY = '__leaflet_demo_china_provinces__';
const REAL_PROVINCE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 小时

async function loadRealProvinceGeoJSON(onProgress) {
    onProgress && onProgress('检查本地缓存...');
    // 1. 尝试命中本地缓存
    try {
        const cached = localStorage.getItem(REAL_PROVINCE_CACHE_KEY);
        if (cached) {
            const obj = JSON.parse(cached);
            if (obj && obj.ts && (Date.now() - obj.ts) < REAL_PROVINCE_CACHE_TTL && obj.data) {
                onProgress && onProgress('✅ 命中本地缓存，瞬间加载');
                return obj.data;
            }
        }
    } catch (_) { /* 忽略缓存错误 */ }

    onProgress && onProgress('🌐 正在下载约 2MB 的边界数据...');
    const res = await fetch(REAL_PROVINCE_GEOJSON_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.features)) throw new Error('数据格式异常');

    // 2. 写入缓存
    try {
        localStorage.setItem(REAL_PROVINCE_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
    } catch (_) {
        console.warn('[choropleth] 边界数据缓存写入失败（可能超出 localStorage 配额）');
    }
    onProgress && onProgress('✅ 下载完成，已缓存到本地');
    return data;
}

// 为每个 Feature 加上模拟数值（如果已存在则跳过）
function attachMockValuesToGeoJSON(geo) {
    if (!geo || !geo.features) return;
    geo.features.forEach(f => {
        f.properties = f.properties || {};
        if (f.properties.value === undefined) {
            f.properties.value = Math.round(Math.random() * 1000);
        }
        if (f.properties.per_capita === undefined) {
            f.properties.per_capita = Math.round(Math.random() * 100);
        }
    });
}


// ============================================================================
// 🧠 模块 B：Turf 高级几何玩法（最近邻 / 凸包 / 泰森多边形）
// - 输入：最近一次 POI 搜索结果（poiLastPois）
// - 输出：在地图上绘制一层分析可视化（layerGroup，可一键清除）
// ============================================================================

let advancedAnalysisLayer = null; // 当前分析结果图层（LayerGroup）

// 从 poiLastPois 构造 turf.FeatureCollection（Points）
function poisToTurfFC() {
    if (typeof poiLastPois === 'undefined' || !Array.isArray(poiLastPois)) return null;
    const pts = [];
    poiLastPois.forEach(poi => {
        if (!poi || !poi.location) return;
        const [lng, lat] = String(poi.location).split(',').map(Number);
        if (isNaN(lng) || isNaN(lat)) return;
        pts.push(turf.point([lng, lat], {
            name: poi.name || '',
            type: poi.type || '',
            id: poi.id || ''
        }));
    });
    return pts.length ? turf.featureCollection(pts) : null;
}

// 清除高级分析图层
function clearAdvancedAnalysis() {
    if (advancedAnalysisLayer) {
        try { map.removeLayer(advancedAnalysisLayer); } catch (_) {}
        advancedAnalysisLayer = null;
    }
}

// —— 玩法 1：最近邻分析（每个 POI 连接到其最近的另一个 POI）
function runNearestNeighbor() {
    const fc = poisToTurfFC();
    if (!fc || fc.features.length < 2) {
        alert('请先至少搜索到 2 个 POI');
        return;
    }
    clearAdvancedAnalysis();
    advancedAnalysisLayer = L.layerGroup().addTo(map);

    const pts = fc.features;
    pts.forEach((p, i) => {
        let minDist = Infinity;
        let nearest = null;
        pts.forEach((q, j) => {
            if (i === j) return;
            const d = turf.distance(p, q, { units: 'meters' });
            if (d < minDist) { minDist = d; nearest = q; }
        });
        if (nearest) {
            const [lng1, lat1] = p.geometry.coordinates;
            const [lng2, lat2] = nearest.geometry.coordinates;
            L.polyline([[lat1, lng1], [lat2, lng2]], {
                color: '#00897B',
                weight: 2,
                opacity: 0.6,
                dashArray: '4 3'
            }).addTo(advancedAnalysisLayer);
        }
    });
    alert('✅ 最近邻分析完成\n- 参与点：' + pts.length + ' 个\n- 连线：每点连向最近的另一个点');
}

// —— 玩法 2：凸包（Convex Hull）
function runConvexHull() {
    const fc = poisToTurfFC();
    if (!fc || fc.features.length < 3) {
        alert('请先至少搜索到 3 个 POI');
        return;
    }
    clearAdvancedAnalysis();
    advancedAnalysisLayer = L.layerGroup().addTo(map);

    const hull = turf.convex(fc);
    if (!hull) { alert('凸包计算失败'); return; }

    L.geoJSON(hull, {
        style: {
            color: '#FB8C00',
            fillColor: '#FFB74D',
            weight: 3,
            fillOpacity: 0.2,
            dashArray: '6 3'
        }
    }).addTo(advancedAnalysisLayer);

    const area = turf.area(hull);
    const areaStr = area < 1e6 ? area.toFixed(1) + ' m²' : (area / 1e6).toFixed(3) + ' km²';
    alert('✅ 凸包生成完成\n- 包含点：' + fc.features.length + ' 个\n- 凸包面积：' + areaStr);
}

// —— 玩法 3：泰森多边形（Voronoi / Thiessen）
function runVoronoi() {
    const fc = poisToTurfFC();
    if (!fc || fc.features.length < 3) {
        alert('请先至少搜索到 3 个 POI');
        return;
    }
    clearAdvancedAnalysis();
    advancedAnalysisLayer = L.layerGroup().addTo(map);

    // turf.voronoi 需要一个 bbox，按点集扩展 10%
    const bbox = turf.bbox(fc);
    const dx = (bbox[2] - bbox[0]) * 0.1;
    const dy = (bbox[3] - bbox[1]) * 0.1;
    const expandedBbox = [bbox[0] - dx, bbox[1] - dy, bbox[2] + dx, bbox[3] + dy];

    let vor;
    try {
        vor = turf.voronoi(fc, { bbox: expandedBbox });
    } catch (err) {
        alert('泰森多边形计算失败：' + err.message);
        return;
    }
    if (!vor || !vor.features) { alert('泰森多边形生成失败'); return; }

    const palette = ['#EF5350', '#AB47BC', '#5C6BC0', '#29B6F6', '#26A69A', '#66BB6A', '#FFA726', '#8D6E63'];
    vor.features.forEach((f, i) => {
        if (!f) return; // 有些点在 bbox 外会返回 null
        L.geoJSON(f, {
            style: {
                color: '#fff',
                weight: 1,
                fillColor: palette[i % palette.length],
                fillOpacity: 0.35
            }
        }).addTo(advancedAnalysisLayer);
    });

    // 叠加原始点
    fc.features.forEach(p => {
        const [lng, lat] = p.geometry.coordinates;
        L.circleMarker([lat, lng], {
            radius: 4,
            color: '#333',
            fillColor: '#fff',
            fillOpacity: 1,
            weight: 1.5
        }).addTo(advancedAnalysisLayer);
    });

    alert('✅ 泰森多边形完成\n- 参与点：' + fc.features.length + ' 个\n- 每块区域 = 离对应点最近的地理范围\n（常用于：服务覆盖分析、最近门店归属）');
}

// 高级分析控制面板（左下）
const AdvancedAnalysisControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control adv-analysis-control');
        div.style.cssText = 'background:#fff;padding:6px 8px;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,0.15);border-radius:4px;min-width:180px;margin-bottom:6px;';
        div.innerHTML = `
            <div style="font-weight:bold;margin-bottom:4px;">🧠 Turf 高级分析</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                <button id="adv-nn-btn" style="padding:3px 8px;font-size:11px;border:1px solid #00897B;background:#fff;color:#00897B;border-radius:3px;cursor:pointer;" title="每个 POI 连向其最近的另一个 POI">🔗 最近邻</button>
                <button id="adv-hull-btn" style="padding:3px 8px;font-size:11px;border:1px solid #FB8C00;background:#fff;color:#FB8C00;border-radius:3px;cursor:pointer;" title="把所有 POI 用最外层凸多边形包起来">📐 凸包</button>
                <button id="adv-voronoi-btn" style="padding:3px 8px;font-size:11px;border:1px solid #5C6BC0;background:#fff;color:#5C6BC0;border-radius:3px;cursor:pointer;" title="按"离哪个 POI 最近"切分彩色区域">🧩 泰森</button>
                <button id="adv-clear-btn" style="padding:3px 8px;font-size:11px;border:1px solid #888;background:#fff;color:#555;border-radius:3px;cursor:pointer;">清除</button>
            </div>
            <div style="margin-top:4px;color:#888;font-size:10px;line-height:1.4;">
                基于最近一次 POI 搜索结果
            </div>
        `;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);

        setTimeout(() => {
            const nnBtn = div.querySelector('#adv-nn-btn');
            const hullBtn = div.querySelector('#adv-hull-btn');
            const vorBtn = div.querySelector('#adv-voronoi-btn');
            const clrBtn = div.querySelector('#adv-clear-btn');
            if (nnBtn) nnBtn.addEventListener('click', runNearestNeighbor);
            if (hullBtn) hullBtn.addEventListener('click', runConvexHull);
            if (vorBtn) vorBtn.addEventListener('click', runVoronoi);
            if (clrBtn) clrBtn.addEventListener('click', clearAdvancedAnalysis);
        }, 0);

        return div;
    }
});
map.addControl(new AdvancedAnalysisControl());


// ============================================================================
// 💾 模块 C：绘制图形持久化（drawnLayers ↔ localStorage）
// - 保存：pm:create / pm:edit / pm:remove 时自动写入
// - 恢复：页面加载时读取并重建
// - 支持：Polygon / Rectangle / Polyline / Point / Circle
// ============================================================================

const DRAWN_LAYERS_STORAGE_KEY = '__leaflet_demo_drawn_layers__';

// 把所有 drawnLayers 序列化为结构化 JSON
function serializeDrawnLayers() {
    const items = [];
    drawnLayers.eachLayer(layer => {
        const name = (layer && layer._customName) || '';
        if (layer instanceof L.Circle) {
            const c = layer.getLatLng();
            items.push({
                type: 'Circle',
                center: [c.lat, c.lng],
                radius: layer.getRadius(),
                name
            });
        } else if (layer instanceof L.Rectangle) {
            const latlngs = layer.getLatLngs()[0].map(ll => [ll.lat, ll.lng]);
            items.push({ type: 'Rectangle', latlngs, name });
        } else if (layer instanceof L.Polygon) {
            const outer = layer.getLatLngs()[0];
            const latlngs = (Array.isArray(outer[0]) ? outer[0] : outer).map(ll => [ll.lat, ll.lng]);
            items.push({ type: 'Polygon', latlngs, name });
        } else if (layer instanceof L.Polyline) {
            const latlngs = layer.getLatLngs().map(ll => [ll.lat, ll.lng]);
            items.push({ type: 'Polyline', latlngs, name });
        } else if (layer instanceof L.Marker) {
            const ll = layer.getLatLng();
            items.push({ type: 'Marker', latlng: [ll.lat, ll.lng], name });
        }
    });
    return items;
}

function saveDrawnLayersToStorage() {
    try {
        const items = serializeDrawnLayers();
        if (items.length === 0) {
            localStorage.removeItem(DRAWN_LAYERS_STORAGE_KEY);
        } else {
            localStorage.setItem(DRAWN_LAYERS_STORAGE_KEY, JSON.stringify(items));
        }
    } catch (err) {
        console.warn('[drawn-layers] 持久化失败:', err);
    }
}

function restoreDrawnLayersFromStorage() {
    try {
        const raw = localStorage.getItem(DRAWN_LAYERS_STORAGE_KEY);
        if (!raw) return;
        const items = JSON.parse(raw);
        if (!Array.isArray(items)) return;

        items.forEach(item => {
            let layer = null;
            if (item.type === 'Circle') {
                layer = L.circle(item.center, { radius: item.radius });
            } else if (item.type === 'Rectangle') {
                layer = L.rectangle(item.latlngs);
            } else if (item.type === 'Polygon') {
                layer = L.polygon(item.latlngs);
            } else if (item.type === 'Polyline') {
                layer = L.polyline(item.latlngs);
            } else if (item.type === 'Marker') {
                layer = L.marker(item.latlng);
            }
            if (layer) {
                if (item.name) layer._customName = item.name;
                drawnLayers.addLayer(layer);
                bindDrawnLayerPopup(layer);
                lastDrawnLayer = layer;
            }
        });

        if (items.length > 0) {
            console.log('[drawn-layers] 已恢复 ' + items.length + ' 个图形');
            showDrawnRestoreTip(items.length);
        }
    } catch (err) {
        console.warn('[drawn-layers] 恢复失败:', err);
    }
}

function showDrawnRestoreTip(count) {
    const tip = L.DomUtil.create('div', '', document.body);
    tip.style.cssText = 'position:fixed;top:80px;right:20px;z-index:9999;' +
        'background:rgba(76,175,80,0.92);color:#fff;padding:8px 14px;' +
        'border-radius:4px;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,0.2);' +
        'transition:opacity 0.3s;';
    tip.textContent = '💾 已恢复 ' + count + ' 个绘制图形';
    setTimeout(() => { tip.style.opacity = '0'; }, 2500);
    setTimeout(() => { try { document.body.removeChild(tip); } catch (_) {} }, 3000);
}


// ============================================================================
// 🏷️ 模块 1：绘制图形 Popup（点击显示信息 + 重命名 + 颜色调整）
// - 给每个图层挂 popup：显示自定义名称 + 类型 + 面积/距离 + 中心点
// - 重命名按钮：prompt 输入新名称，写入 layer._customName 并保存到 localStorage
// - 颜色按钮：从预设里选一个颜色应用
// ============================================================================

const DRAWN_COLOR_PALETTE = [
    { color: '#1E88E5', name: '蓝' },
    { color: '#43A047', name: '绿' },
    { color: '#E53935', name: '红' },
    { color: '#FB8C00', name: '橙' },
    { color: '#8E24AA', name: '紫' },
    { color: '#00897B', name: '青' },
    { color: '#FDD835', name: '黄' }
];

function getDrawnLayerInfo(layer) {
    // 返回 { typeText, metricsHTML }
    if (layer instanceof L.Circle) {
        const c = layer.getLatLng();
        const r = layer.getRadius();
        return {
            typeText: '⭕ 圆',
            metricsHTML: `半径：${r < 1000 ? r.toFixed(1) + ' m' : (r / 1000).toFixed(2) + ' km'}<br/>` +
                         `中心：${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}<br/>` +
                         `面积：${fmtArea(Math.PI * r * r)}`
        };
    }
    if (layer instanceof L.Rectangle) {
        const feat = leafletLayerToTurf(layer);
        const area = feat ? turf.area(feat) : 0;
        const center = layer.getBounds().getCenter();
        return {
            typeText: '▭ 矩形',
            metricsHTML: `面积：${fmtArea(area)}<br/>中心：${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`
        };
    }
    if (layer instanceof L.Polygon) {
        const feat = leafletLayerToTurf(layer);
        const area = feat ? turf.area(feat) : 0;
        const perim = feat ? turf.length(turf.polygonToLine(feat), { units: 'meters' }) : 0;
        return {
            typeText: '⬢ 多边形',
            metricsHTML: `面积：${fmtArea(area)}<br/>周长：${fmtLength(perim)}`
        };
    }
    if (layer instanceof L.Polyline) {
        const feat = leafletLayerToTurf(layer);
        const len = feat ? turf.length(feat, { units: 'meters' }) : 0;
        return {
            typeText: '— 折线',
            metricsHTML: `长度：${fmtLength(len)}<br/>顶点数：${layer.getLatLngs().length}`
        };
    }
    if (layer instanceof L.Marker) {
        const ll = layer.getLatLng();
        return {
            typeText: '📍 标记点',
            metricsHTML: `坐标：${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`
        };
    }
    return { typeText: '?', metricsHTML: '' };
}

function buildDrawnLayerPopupHTML(layer) {
    const name = layer._customName || '未命名';
    const info = getDrawnLayerInfo(layer);
    const colorBtns = DRAWN_COLOR_PALETTE.map(p =>
        `<span class="dl-color-btn" data-color="${p.color}" title="${p.name}" ` +
        `style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${p.color};` +
        `margin-right:3px;cursor:pointer;border:1px solid #ddd;"></span>`
    ).join('');
    return `
        <div style="min-width:180px;font-size:12px;line-height:1.6;">
            <div style="font-weight:bold;color:#1E88E5;margin-bottom:4px;">
                ${escapeHtml(name)} <span style="color:#888;font-weight:normal;">${info.typeText}</span>
            </div>
            <div style="color:#444;">${info.metricsHTML}</div>
            <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #ddd;">
                <div style="color:#888;font-size:11px;margin-bottom:3px;">颜色：</div>
                <div class="dl-color-row">${colorBtns}</div>
            </div>
            <div style="margin-top:6px;display:flex;gap:4px;">
                <button class="dl-rename-btn" style="padding:2px 8px;font-size:11px;border:1px solid #1E88E5;background:#fff;color:#1E88E5;border-radius:3px;cursor:pointer;">✏️ 重命名</button>
                <button class="dl-zoom-btn" style="padding:2px 8px;font-size:11px;border:1px solid #43A047;background:#fff;color:#43A047;border-radius:3px;cursor:pointer;">🔍 定位</button>
            </div>
        </div>
    `;
}

function bindDrawnLayerPopup(layer) {
    if (!layer || layer._popupBound) return; // 防止重复绑定
    layer._popupBound = true;

    layer.bindPopup(() => buildDrawnLayerPopupHTML(layer), { maxWidth: 260 });

    layer.on('popupopen', (e) => {
        const root = e.popup._contentNode;
        if (!root) return;

        // 重命名
        const renameBtn = root.querySelector('.dl-rename-btn');
        if (renameBtn) {
            renameBtn.addEventListener('click', () => {
                const cur = layer._customName || '';
                const next = prompt('请输入图形名称：', cur);
                if (next === null) return;
                layer._customName = next.trim();
                saveDrawnLayersToStorage();
                // 重新构建 popup
                e.popup.setContent(buildDrawnLayerPopupHTML(layer));
            });
        }

        // 定位（fitBounds 或 panTo）
        const zoomBtn = root.querySelector('.dl-zoom-btn');
        if (zoomBtn) {
            zoomBtn.addEventListener('click', () => {
                if (typeof layer.getBounds === 'function') {
                    try { map.fitBounds(layer.getBounds(), { padding: [40, 40] }); } catch (_) {}
                } else if (typeof layer.getLatLng === 'function') {
                    map.panTo(layer.getLatLng());
                }
            });
        }

        // 颜色按钮
        root.querySelectorAll('.dl-color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const color = btn.getAttribute('data-color');
                if (!color) return;
                if (typeof layer.setStyle === 'function') {
                    layer.setStyle({ color, fillColor: color });
                }
            });
        });
    });
}


// ============================================================================
// ✈️ 模块 2：OD 飞线图（城市 A → B 的弧形动画）
// - 内置一组示例 OD（Origin-Destination）数据：北京/上海/广州/成都 等之间的连线
// - 用贝塞尔曲线生成弧形 polyline + 蚂蚁线流动 + 起点终点 emoji 标记
// - 支持 一键添加 / 一键清除 / 添加自定义 OD
// ============================================================================

let odLayer = null; // OD 总图层组

// 城市坐标（GCJ-02，与高德瓦片匹配）
const OD_CITY_COORDS = {
    '北京': [39.905, 116.405],
    '上海': [31.230, 121.473],
    '广州': [23.125, 113.281],
    '深圳': [22.547, 114.085],
    '成都': [30.572, 104.066],
    '杭州': [30.287, 120.153],
    '武汉': [30.584, 114.298],
    '西安': [34.263, 108.948],
    '重庆': [29.563, 106.551],
    '南京': [32.061, 118.763],
    '昆明': [25.040, 102.712],
    '哈尔滨': [45.756, 126.642],
    '乌鲁木齐': [43.793, 87.617],
    '拉萨': [29.660, 91.132]
};

// 示例 OD 数据（春运迁徙风格）
const OD_DEMO_DATA = [
    { from: '北京', to: '上海', volume: 90 },
    { from: '北京', to: '广州', volume: 80 },
    { from: '北京', to: '成都', volume: 65 },
    { from: '上海', to: '成都', volume: 55 },
    { from: '上海', to: '武汉', volume: 70 },
    { from: '广州', to: '武汉', volume: 60 },
    { from: '深圳', to: '哈尔滨', volume: 50 },
    { from: '成都', to: '杭州', volume: 45 },
    { from: '西安', to: '上海', volume: 55 },
    { from: '昆明', to: '北京', volume: 40 },
    { from: '乌鲁木齐', to: '北京', volume: 35 },
    { from: '拉萨', to: '成都', volume: 30 }
];

// 给两个点生成一条弧线（贝塞尔曲线插值）
//  - 起点 A、终点 B
//  - 控制点 C：取 AB 中点向 AB 法线方向偏移 d（曲率 = AB长度 * curveFactor）
function buildArcLatLngs(a, b, curveFactor = 0.25, segments = 64) {
    const [latA, lngA] = a;
    const [latB, lngB] = b;
    const midLat = (latA + latB) / 2;
    const midLng = (lngA + lngB) / 2;
    const dx = lngB - lngA;
    const dy = latB - latA;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // 法向量（顺时针旋转 90°）
    const nx = -dy / dist;
    const ny = dx / dist;
    const offset = dist * curveFactor;
    const cLat = midLat + ny * offset;
    const cLng = midLng + nx * offset;

    const points = [];
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        // 二次贝塞尔
        const lat = (1 - t) * (1 - t) * latA + 2 * (1 - t) * t * cLat + t * t * latB;
        const lng = (1 - t) * (1 - t) * lngA + 2 * (1 - t) * t * cLng + t * t * lngB;
        points.push([lat, lng]);
    }
    return points;
}

// 城市 emoji 圆点图标（带名字标签）
function createODCityIcon(name, color) {
    return L.divIcon({
        className: 'od-city-icon',
        html: `<div style="position:relative;">
            <div style="width:12px;height:12px;background:${color};border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>
            <div style="position:absolute;left:16px;top:-3px;font-size:11px;font-weight:bold;color:#fff;background:${color};padding:1px 6px;border-radius:3px;white-space:nowrap;">${escapeHtml(name)}</div>
        </div>`,
        iconSize: [12, 12],
        iconAnchor: [6, 6]
    });
}

function clearODLayer() {
    if (odLayer) {
        try { map.removeLayer(odLayer); } catch (_) {}
        odLayer = null;
    }
}

// 渲染一组 OD 飞线
function renderODFlights(odList) {
    clearODLayer();
    odLayer = L.layerGroup().addTo(map);

    // volume → 颜色 / 粗细 映射
    const maxV = Math.max(...odList.map(o => o.volume || 1));
    const colorByVolume = (v) => {
        const ratio = v / maxV;
        if (ratio > 0.75) return '#E53935';
        if (ratio > 0.5)  return '#FB8C00';
        if (ratio > 0.25) return '#FDD835';
        return '#43A047';
    };

    const cityShown = new Set();
    const allPoints = [];

    odList.forEach(od => {
        const a = OD_CITY_COORDS[od.from];
        const b = OD_CITY_COORDS[od.to];
        if (!a || !b) return;
        const color = colorByVolume(od.volume || 1);
        const weight = 1.5 + (od.volume / maxV) * 4;

        // 弧线
        const arc = buildArcLatLngs(a, b, 0.22);
        const ant = antPath(arc, {
            color,
            pulseColor: '#ffffff',
            weight,
            opacity: 0.85,
            delay: 1400,
            dashArray: [10, 20],
            hardwareAccelerated: true
        });
        ant.bindTooltip(`${od.from} → ${od.to}<br/>流量：${od.volume}`, { sticky: true });
        ant.addTo(odLayer);

        allPoints.push(a, b);

        // 起点终点（去重，避免叠在一起重复绘制）
        [['from', a], ['to', b]].forEach(([key, latlng]) => {
            const cityName = od[key];
            if (cityShown.has(cityName)) return;
            cityShown.add(cityName);
            L.marker(latlng, { icon: createODCityIcon(cityName, '#1E88E5') }).addTo(odLayer);
        });
    });

    if (allPoints.length) {
        try { map.fitBounds(L.latLngBounds(allPoints), { padding: [60, 60] }); } catch (_) {}
    }
}

// OD 控制面板
const ODControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control od-control');
        div.style.cssText = 'background:#fff;padding:6px 8px;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,0.15);border-radius:4px;min-width:180px;margin-bottom:6px;';
        div.innerHTML = `
            <div style="font-weight:bold;margin-bottom:4px;">✈️ OD 飞线图</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                <button id="od-demo-btn" style="padding:3px 8px;font-size:11px;border:1px solid #1E88E5;background:#fff;color:#1E88E5;border-radius:3px;cursor:pointer;" title="渲染 12 条城市间的迁徙连线">🇨🇳 春运演示</button>
                <button id="od-add-btn" style="padding:3px 8px;font-size:11px;border:1px solid #43A047;background:#fff;color:#43A047;border-radius:3px;cursor:pointer;" title="手动添加一条 OD">➕ 添加</button>
                <button id="od-clear-btn" style="padding:3px 8px;font-size:11px;border:1px solid #E53935;background:#fff;color:#E53935;border-radius:3px;cursor:pointer;">清除</button>
            </div>
            <div style="margin-top:4px;color:#888;font-size:10px;line-height:1.4;">
                颜色 / 粗细 = 流量大小
            </div>
        `;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);

        setTimeout(() => {
            const demoBtn = div.querySelector('#od-demo-btn');
            const addBtn = div.querySelector('#od-add-btn');
            const clearBtn = div.querySelector('#od-clear-btn');
            if (demoBtn) demoBtn.addEventListener('click', () => renderODFlights(OD_DEMO_DATA));
            if (clearBtn) clearBtn.addEventListener('click', clearODLayer);
            if (addBtn) addBtn.addEventListener('click', () => {
                const cities = Object.keys(OD_CITY_COORDS).join(' / ');
                const from = prompt(`起点城市（可选：${cities}）`, '北京');
                if (!from || !OD_CITY_COORDS[from]) { alert('未识别的起点'); return; }
                const to = prompt(`终点城市`, '上海');
                if (!to || !OD_CITY_COORDS[to]) { alert('未识别的终点'); return; }
                const v = parseFloat(prompt('流量（数值）', '50')) || 50;
                // 累加在现有 OD 数据上
                renderODFlights([...OD_DEMO_DATA, { from, to, volume: v }]);
            });
        }, 0);

        return div;
    }
});
map.addControl(new ODControl());


// ============================================================================
// 📅 模块 3：时间轴播放（leaflet-timedimension）
// - 演示数据：模拟某个指标在 2020 年 12 个月的"传播"过程
// - 每月一个 GeoJSON 圆，半径随月份递增（仿疫情扩散）
// - 用 L.timeDimension.layer.geoJson 自动按当前时间过滤显示
// ============================================================================

let timeDimensionMap = null; // 单独的 TimeDimension 图层
let timeDimensionControl = null;

function buildTimeDimensionDemo() {
    // 12 个月的示例数据，每月一个圆心 + 半径
    const features = [];
    const baseCenter = [31.230, 121.473]; // 上海
    for (let m = 0; m < 12; m++) {
        const time = `2020-${String(m + 1).padStart(2, '0')}-15T12:00:00Z`;
        // 每月圆心略微偏移，半径递增（仿扩散）
        const lat = baseCenter[0] + (m - 6) * 0.5;
        const lng = baseCenter[1] + Math.cos(m / 6 * Math.PI) * 1.5;
        const radius = 0.3 + m * 0.15; // 度
        // 圆近似为多边形
        const coords = [];
        for (let i = 0; i <= 32; i++) {
            const a = (i / 32) * Math.PI * 2;
            coords.push([lng + Math.cos(a) * radius, lat + Math.sin(a) * radius]);
        }
        features.push({
            type: 'Feature',
            properties: {
                time,
                month: m + 1,
                value: Math.round(20 + m * 15 + Math.random() * 10)
            },
            geometry: { type: 'Polygon', coordinates: [coords] }
        });
    }
    return { type: 'FeatureCollection', features };
}

function startTimeDimensionDemo() {
    stopTimeDimensionDemo();

    // 启用 map 的 TimeDimension（如果还没启用）
    if (!map.timeDimension) {
        map.timeDimension = new L.TimeDimension({
            timeInterval: '2020-01-01/2020-12-31',
            period: 'P1M'
        });
    }

    const geoJsonData = buildTimeDimensionDemo();
    const baseGeoJson = L.geoJSON(geoJsonData, {
        style: (feature) => {
            const v = feature.properties.value || 0;
            return {
                color: '#fff',
                weight: 1,
                fillColor: v > 130 ? '#b10026' : v > 90 ? '#fc4e2a' : v > 50 ? '#feb24c' : '#ffffb2',
                fillOpacity: 0.55
            };
        },
        onEachFeature: (f, layer) => {
            layer.bindPopup(`<b>2020-${String(f.properties.month).padStart(2, '0')}</b><br/>指标值：${f.properties.value}`);
        }
    });

    // 用 timeDimension geoJson 包装层
    timeDimensionMap = L.timeDimension.layer.geoJson(baseGeoJson, {
        updateTimeDimension: true,
        addlastPoint: false,
        waitForReady: true,
        duration: 'P1M' // 每个 feature 持续 1 个月
    });
    timeDimensionMap.addTo(map);

    // 添加播放控件
    if (!timeDimensionControl) {
        timeDimensionControl = new L.Control.TimeDimension({
            position: 'bottomright',
            autoPlay: false,
            playerOptions: {
                buffer: 1,
                transitionTime: 250,
                loop: true,
                startOver: true
            },
            timeSliderDragUpdate: true,
            speedSlider: true
        });
        map.addControl(timeDimensionControl);
    }

    // 自适应到第一帧
    try {
        const allBounds = baseGeoJson.getBounds();
        if (allBounds.isValid()) map.fitBounds(allBounds, { padding: [60, 60] });
    } catch (_) {}
}

function stopTimeDimensionDemo() {
    if (timeDimensionMap) {
        try { map.removeLayer(timeDimensionMap); } catch (_) {}
        timeDimensionMap = null;
    }
    if (timeDimensionControl) {
        try { map.removeControl(timeDimensionControl); } catch (_) {}
        timeDimensionControl = null;
    }
}

const TimeDimensionControlBtn = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control td-control');
        div.style.cssText = 'background:#fff;padding:6px 8px;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,0.15);border-radius:4px;min-width:180px;margin-bottom:6px;';
        div.innerHTML = `
            <div style="font-weight:bold;margin-bottom:4px;">📅 时间轴播放</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                <button id="td-start-btn" style="padding:3px 8px;font-size:11px;border:1px solid #5C6BC0;background:#fff;color:#5C6BC0;border-radius:3px;cursor:pointer;" title="演示：2020 年 12 个月的扩散过程">▶️ 开始演示</button>
                <button id="td-stop-btn" style="padding:3px 8px;font-size:11px;border:1px solid #E53935;background:#fff;color:#E53935;border-radius:3px;cursor:pointer;">停止</button>
            </div>
            <div style="margin-top:4px;color:#888;font-size:10px;line-height:1.4;">
                右下角时间滑块控制播放
            </div>
        `;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);

        setTimeout(() => {
            const startBtn = div.querySelector('#td-start-btn');
            const stopBtn = div.querySelector('#td-stop-btn');
            if (startBtn) startBtn.addEventListener('click', startTimeDimensionDemo);
            if (stopBtn) stopBtn.addEventListener('click', stopTimeDimensionDemo);
        }, 0);

        return div;
    }
});
map.addControl(new TimeDimensionControlBtn());


// ============================================================================
// 📊 模块 4：真实 GDP 数据替换 mock 值（中国 31 省 2023 年 GDP 万亿元）
// - 数据源：国家统计局 / 各省统计公报（公开数据）
// - 单位：亿元（int）；人均：元（int）
// - 注入到加载好的真实省界 GeoJSON 上，按 properties.name 匹配
// ============================================================================

const CHINA_PROVINCE_GDP_2023 = {
    '广东省':     { gdp: 135673, per_capita: 106986 },
    '江苏省':     { gdp: 128222, per_capita: 150487 },
    '山东省':     { gdp: 92069,  per_capita: 90942  },
    '浙江省':     { gdp: 82553,  per_capita: 125043 },
    '四川省':     { gdp: 60133,  per_capita: 71835  },
    '河南省':     { gdp: 59132,  per_capita: 60073  },
    '湖北省':     { gdp: 55804,  per_capita: 95443  },
    '福建省':     { gdp: 54355,  per_capita: 129829 },
    '湖南省':     { gdp: 50012,  per_capita: 75435  },
    '安徽省':     { gdp: 47050,  per_capita: 76798  },
    '上海市':     { gdp: 47218,  per_capita: 190271 },
    '河北省':     { gdp: 43944,  per_capita: 59433  },
    '北京市':     { gdp: 43760,  per_capita: 200273 },
    '陕西省':     { gdp: 33786,  per_capita: 85628  },
    '江西省':     { gdp: 32200,  per_capita: 71283  },
    '重庆市':     { gdp: 30145,  per_capita: 94133  },
    '辽宁省':     { gdp: 30209,  per_capita: 72066  },
    '云南省':     { gdp: 30021,  per_capita: 64050  },
    '广西壮族自治区': { gdp: 26803, per_capita: 53449 },
    '内蒙古自治区': { gdp: 24627, per_capita: 102677 },
    '山西省':     { gdp: 25698,  per_capita: 73789  },
    '贵州省':     { gdp: 20913,  per_capita: 54172  },
    '新疆维吾尔自治区': { gdp: 19125, per_capita: 73914 },
    '天津市':     { gdp: 16737,  per_capita: 122254 },
    '黑龙江省':   { gdp: 15883,  per_capita: 51096  },
    '吉林省':     { gdp: 13531,  per_capita: 57652  },
    '甘肃省':     { gdp: 11863,  per_capita: 47867  },
    '海南省':     { gdp: 7551,   per_capita: 71875  },
    '宁夏回族自治区': { gdp: 5315, per_capita: 72421 },
    '青海省':     { gdp: 3799,   per_capita: 64014  },
    '西藏自治区': { gdp: 2393,   per_capita: 65642  },
    '香港特别行政区': { gdp: 26456, per_capita: 354000 },
    '澳门特别行政区': { gdp: 3795,  per_capita: 564000 },
    '台湾省':     { gdp: 53345,  per_capita: 226000 }
};

// 把真实 GDP 数据注入到 GeoJSON 中（覆盖随机 mock 值）
function attachRealGDPToGeoJSON(geo) {
    if (!geo || !geo.features) return 0;
    let matched = 0;
    geo.features.forEach(f => {
        f.properties = f.properties || {};
        const name = f.properties.name;
        // 多策略匹配（容错"省/市/自治区"前后缀差异）
        let key = null;
        if (CHINA_PROVINCE_GDP_2023[name]) {
            key = name;
        } else {
            // 尝试加常见后缀
            const candidates = [name + '省', name + '市', name + '自治区'];
            for (const c of candidates) {
                if (CHINA_PROVINCE_GDP_2023[c]) { key = c; break; }
            }
            // 尝试去掉后缀
            if (!key) {
                const stripped = String(name).replace(/(省|市|自治区|特别行政区)$/, '');
                for (const k of Object.keys(CHINA_PROVINCE_GDP_2023)) {
                    if (k.startsWith(stripped)) { key = k; break; }
                }
            }
        }
        if (key) {
            const data = CHINA_PROVINCE_GDP_2023[key];
            f.properties.gdp = data.gdp;
            f.properties.per_capita = data.per_capita;
            // 也覆盖 value（向后兼容现有 ChoroplethControl 的 value 字段）
            f.properties.value = data.gdp;
            matched++;
        }
    });
    return matched;
}

// 注入 ChoroplethControl 一个新按钮"📊 真实 GDP"
// 通过 DOM 操作给已渲染的面板加按钮
function injectGDPButton() {
    const tryInject = () => {
        const choroPanel = document.querySelector('.choropleth-control');
        if (!choroPanel) { setTimeout(tryInject, 200); return; }
        if (choroPanel.querySelector('#choro-gdp-btn')) return; // 已注入

        const fieldSel = choroPanel.querySelector('#choro-field-select');
        if (fieldSel) {
            // 在字段下拉里加 gdp 选项
            const hasGdp = Array.from(fieldSel.options).some(o => o.value === 'gdp');
            if (!hasGdp) {
                const opt = document.createElement('option');
                opt.value = 'gdp';
                opt.textContent = 'gdp';
                fieldSel.appendChild(opt);
            }
        }

        // 在第一行按钮组后面追加 GDP 按钮
        const btnRows = choroPanel.querySelectorAll('div[style*="flex-wrap"]');
        const targetRow = btnRows[0];
        if (targetRow) {
            const gdpBtn = document.createElement('button');
            gdpBtn.id = 'choro-gdp-btn';
            gdpBtn.textContent = '📊 真实 GDP';
            gdpBtn.title = '加载真实省界 + 2023 年 GDP 数据';
            gdpBtn.style.cssText = 'padding:3px 8px;font-size:11px;border:1px solid #00897B;background:#00897B;color:#fff;border-radius:3px;cursor:pointer;';
            targetRow.appendChild(gdpBtn);

            gdpBtn.addEventListener('click', async () => {
                const statusEl = choroPanel.querySelector('#choro-status');
                const orig = gdpBtn.textContent;
                gdpBtn.disabled = true;
                gdpBtn.textContent = '加载中...';
                try {
                    const geo = await loadRealProvinceGeoJSON((m) => { if (statusEl) statusEl.textContent = m; });
                    const matched = attachRealGDPToGeoJSON(geo);
                    choroplethData = geo;
                    // 自动切到 gdp 字段
                    if (fieldSel) fieldSel.value = 'gdp';
                    choroplethValueField = 'gdp';
                    renderChoropleth(choroplethData, 'gdp');
                    if (statusEl) statusEl.textContent = `✅ 已匹配 ${matched}/${geo.features.length} 个省级单元的 2023 年 GDP`;
                } catch (err) {
                    if (statusEl) statusEl.textContent = '❌ 加载失败：' + err.message;
                    alert('加载失败：' + err.message);
                } finally {
                    gdpBtn.disabled = false;
                    gdpBtn.textContent = orig;
                }
            });
        }
    };
    tryInject();
}
injectGDPButton();


// ============================================================================
// 📥 模块 1：CSV 拖入（拖一个 province,gdp,population CSV 自动 join 到边界）
// - 全局监听 dragover / drop
// - 简易 CSV 解析（支持逗号/分号、带引号）
// - 第一列必须是省名（与 CHINA_PROVINCE_GDP_2023 的 key 容错匹配规则相同）
// - 其余列作为字段写入 GeoJSON.properties，并自动注入到 ChoroplethControl 字段下拉框
// ============================================================================

// 简易 CSV 解析：支持双引号、转义、逗号或分号
function parseCSV(text) {
    const rows = [];
    let row = [];
    let cur = '';
    let inQuote = false;
    let sep = ',';
    // 自动嗅探分隔符
    const firstLine = text.split(/\r?\n/)[0] || '';
    if ((firstLine.split(';').length - 1) > (firstLine.split(',').length - 1)) sep = ';';

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuote) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cur += '"'; i++; }
                else { inQuote = false; }
            } else cur += ch;
        } else {
            if (ch === '"') inQuote = true;
            else if (ch === sep) { row.push(cur); cur = ''; }
            else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
            else if (ch === '\r') { /* skip */ }
            else cur += ch;
        }
    }
    if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

// 把 CSV 数据 join 到 GeoJSON 上（按省名容错匹配）
function joinCSVToGeoJSON(geo, headers, dataRows) {
    if (!geo || !geo.features) return { matched: 0, fields: [] };
    const provinceCol = 0; // 第一列固定为省名
    const valueCols = headers.slice(1);

    // 构建 csv map：省名 → {字段: 值}
    const csvMap = {};
    dataRows.forEach(r => {
        const name = String(r[provinceCol] || '').trim();
        if (!name) return;
        const obj = {};
        valueCols.forEach((h, i) => {
            const raw = r[i + 1];
            const num = parseFloat(raw);
            obj[h] = isNaN(num) ? raw : num;
        });
        csvMap[name] = obj;
    });

    let matched = 0;
    geo.features.forEach(f => {
        f.properties = f.properties || {};
        const fname = f.properties.name;
        // 省名容错匹配
        let key = null;
        if (csvMap[fname]) key = fname;
        else {
            const stripped = String(fname || '').replace(/(省|市|自治区|特别行政区)$/, '');
            for (const k of Object.keys(csvMap)) {
                const kStripped = k.replace(/(省|市|自治区|特别行政区)$/, '');
                if (k === stripped || kStripped === stripped || k === fname || kStripped === fname) {
                    key = k; break;
                }
            }
        }
        if (key) {
            const data = csvMap[key];
            Object.keys(data).forEach(h => { f.properties[h] = data[h]; });
            // 默认 value 字段绑定到 CSV 的第一个数值列
            if (valueCols.length > 0 && typeof data[valueCols[0]] === 'number') {
                f.properties.value = data[valueCols[0]];
            }
            matched++;
        }
    });
    return { matched, fields: valueCols };
}

// 把字段名同步到 ChoroplethControl 的下拉框中
function syncChoroFieldOptions(fields) {
    const sel = document.querySelector('#choro-field-select');
    if (!sel) return;
    fields.forEach(f => {
        if (!Array.from(sel.options).some(o => o.value === f)) {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f;
            sel.appendChild(opt);
        }
    });
}

// 显示一个浮层提示（中央大卡片，3 秒消失）
function showCSVDropTip(message, type = 'success') {
    const tip = L.DomUtil.create('div', '', document.body);
    const bg = type === 'error' ? 'rgba(229,57,53,0.95)' :
               type === 'info' ? 'rgba(33,150,243,0.95)' :
               'rgba(76,175,80,0.95)';
    tip.style.cssText = `position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10000;
        background:${bg};color:#fff;padding:14px 22px;border-radius:6px;
        font-size:14px;line-height:1.6;box-shadow:0 4px 16px rgba(0,0,0,0.25);
        max-width:380px;text-align:center;transition:opacity 0.3s;`;
    tip.innerHTML = message;
    setTimeout(() => { tip.style.opacity = '0'; }, 2700);
    setTimeout(() => { try { document.body.removeChild(tip); } catch (_) {} }, 3100);
}

// 拖入提示遮罩
let csvDragOverlay = null;
function showCSVDragOverlay(visible) {
    if (visible) {
        if (csvDragOverlay) return;
        csvDragOverlay = L.DomUtil.create('div', '', document.body);
        csvDragOverlay.style.cssText = `position:fixed;inset:0;z-index:9998;
            background:rgba(33,150,243,0.15);border:4px dashed #1E88E5;
            display:flex;align-items:center;justify-content:center;
            font-size:24px;color:#1565C0;font-weight:bold;
            pointer-events:none;`;
        csvDragOverlay.innerHTML = '📥 松开鼠标以载入 CSV<br/><span style="font-size:14px;color:#555;font-weight:normal;">第一列为省名，其余列将作为可视化字段</span>';
    } else {
        if (csvDragOverlay) {
            try { document.body.removeChild(csvDragOverlay); } catch (_) {}
            csvDragOverlay = null;
        }
    }
}

// 处理 CSV 文件
async function handleCSVFile(file) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type && !file.type.includes('text') && !file.type.includes('csv')) {
        showCSVDropTip('❌ 仅支持 .csv 文件', 'error');
        return;
    }
    try {
        const text = await file.text();
        const rows = parseCSV(text);
        if (rows.length < 2) {
            showCSVDropTip('❌ CSV 内容为空或格式错误', 'error');
            return;
        }
        const headers = rows[0].map(h => String(h).trim());
        const dataRows = rows.slice(1);
        if (headers.length < 2) {
            showCSVDropTip('❌ CSV 至少需要 2 列：第一列省名 + 至少 1 个数值列', 'error');
            return;
        }

        showCSVDropTip('🌐 正在加载真实省界...', 'info');
        const geo = await loadRealProvinceGeoJSON();
        const { matched, fields } = joinCSVToGeoJSON(geo, headers, dataRows);

        choroplethData = geo;
        // 默认渲染第一个数值字段
        const firstField = fields[0] || 'value';
        choroplethValueField = firstField;
        renderChoropleth(choroplethData, firstField);
        syncChoroFieldOptions(fields);

        // 同步下拉选中
        const sel = document.querySelector('#choro-field-select');
        if (sel) sel.value = firstField;

        showCSVDropTip(`✅ CSV 载入成功<br/>匹配到 <b>${matched}</b> 个省级单元<br/>字段：${fields.join(' / ')}`, 'success');
    } catch (err) {
        console.error('[csv] 解析失败:', err);
        showCSVDropTip('❌ CSV 处理失败：' + err.message, 'error');
    }
}

// 全局拖拽监听
window.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
        showCSVDragOverlay(true);
    }
});
window.addEventListener('dragleave', (e) => {
    // 只有真正离开 window 才隐藏
    if (e.relatedTarget == null && e.clientX === 0 && e.clientY === 0) {
        showCSVDragOverlay(false);
    }
});
window.addEventListener('drop', (e) => {
    showCSVDragOverlay(false);
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    handleCSVFile(file);
});

// 在 ChoroplethControl 面板里加一个"📥 拖入 CSV"提示文案
(function attachCSVHint() {
    const tryAttach = () => {
        const statusEl = document.querySelector('.choropleth-control #choro-status');
        if (!statusEl) { setTimeout(tryAttach, 300); return; }
        if (statusEl.dataset.csvHinted) return;
        statusEl.dataset.csvHinted = '1';
        statusEl.innerHTML += '<br/>📥 <b>支持拖入 CSV</b>（第一列省名+数值列）';
    };
    tryAttach();
})();


// ============================================================================
// 📈 模块 2：多年份 GDP 时间轴（2018-2023 各省 GDP 演变）
// - 数据：内嵌 6 年的真实 GDP（亿元，按国家统计局公开数据/概数）
// - 实现：动态 setStyle —— 每帧根据当前 timeDimension 时间，按年份重绘 choroplethLayer
// - UI：在 ChoroplethControl 之外另开一个独立面板，避免和静态 Choropleth 冲突
// ============================================================================

// 各省 6 年 GDP 数据（亿元；近似值，主要用于演示动画）
// 数据维度：[2018, 2019, 2020, 2021, 2022, 2023]
const CHINA_PROVINCE_GDP_BY_YEAR = {
    '广东省':         [99945, 107986, 110760, 124369, 129118, 135673],
    '江苏省':         [92595, 99632,  102719, 116364, 122876, 128222],
    '山东省':         [76469, 71067,  73129,  83095,  87435,  92069],
    '浙江省':         [56197, 62352,  64613,  73516,  77715,  82553],
    '四川省':         [40678, 46615,  48598,  53850,  56750,  60133],
    '河南省':         [49935, 54259,  54997,  58887,  61345,  59132],
    '湖北省':         [39366, 45828,  43443,  50012,  53734,  55804],
    '福建省':         [35804, 42395,  43903,  48810,  53109,  54355],
    '湖南省':         [36425, 39752,  41781,  45713,  48670,  50012],
    '安徽省':         [30006, 37113,  38680,  42959,  45045,  47050],
    '上海市':         [32679, 38155,  38700,  43215,  44652,  47218],
    '河北省':         [36010, 35104,  36206,  40391,  42370,  43944],
    '北京市':         [30320, 35371,  36102,  40269,  41610,  43760],
    '陕西省':         [24438, 25793,  26181,  29800,  32772,  33786],
    '江西省':         [21984, 24757,  25691,  29619,  32074,  32200],
    '重庆市':         [20363, 23605,  25002,  27894,  29129,  30145],
    '辽宁省':         [25315, 24909,  25115,  27584,  28975,  30209],
    '云南省':         [17881, 23223,  24521,  27146,  28954,  30021],
    '广西壮族自治区':  [19627, 21237,  22156,  24740,  26301,  26803],
    '内蒙古自治区':    [16140, 17213,  17360,  20514,  23158,  24627],
    '山西省':         [16818, 17027,  17651,  22590,  25642,  25698],
    '贵州省':         [14806, 16769,  17826,  19586,  20164,  20913],
    '新疆维吾尔自治区': [12200, 13597,  13797,  15983,  17750,  19125],
    '天津市':         [18809, 14104,  14083,  15695,  16311,  16737],
    '黑龙江省':       [16361, 13612,  13698,  14879,  15901,  15883],
    '吉林省':         [15074, 11726,  12311,  13235,  13070,  13531],
    '甘肃省':         [8246,  8718,   9016,   10243,  11202,  11863],
    '海南省':         [4832,  5308,   5532,   6475,   6818,   7551],
    '宁夏回族自治区':  [3705,  3748,   3920,   4522,   5070,   5315],
    '青海省':         [2865,  2965,   3005,   3346,   3610,   3799],
    '西藏自治区':     [1477,  1697,   1902,   2080,   2132,   2393],
    '香港特别行政区':  [28453, 28663,  27124,  28608,  28219,  26456],
    '澳门特别行政区':  [4467,  4346,   1944,   2393,   1929,   3795],
    '台湾省':         [40945, 41892,  44009,  49126,  50985,  53345]
};

const GDP_TIMELINE_YEARS = [2018, 2019, 2020, 2021, 2022, 2023];

let gdpTimelineLayer = null;
let gdpTimelineControl = null;
let gdpTimelineTitle = null;

function attachMultiYearGDPToGeoJSON(geo) {
    if (!geo || !geo.features) return 0;
    let matched = 0;
    geo.features.forEach(f => {
        f.properties = f.properties || {};
        const name = f.properties.name;
        let key = null;
        if (CHINA_PROVINCE_GDP_BY_YEAR[name]) key = name;
        else {
            const stripped = String(name || '').replace(/(省|市|自治区|特别行政区)$/, '');
            for (const k of Object.keys(CHINA_PROVINCE_GDP_BY_YEAR)) {
                if (k.startsWith(stripped) || stripped === k.replace(/(省|市|自治区|特别行政区)$/, '')) {
                    key = k; break;
                }
            }
        }
        if (key) {
            const arr = CHINA_PROVINCE_GDP_BY_YEAR[key];
            GDP_TIMELINE_YEARS.forEach((y, i) => {
                f.properties['gdp_' + y] = arr[i];
            });
            matched++;
        }
    });
    return matched;
}

// 计算所有年份所有省的全局分级阈值，保证年份切换时颜色可比
function computeGlobalGDPBreaks() {
    const allValues = [];
    Object.values(CHINA_PROVINCE_GDP_BY_YEAR).forEach(arr => {
        arr.forEach(v => allValues.push(v));
    });
    return computeBreaks(allValues, CHOROPLETH_COLORS.length);
}

async function startGDPTimeline() {
    stopGDPTimeline();

    const geo = await loadRealProvinceGeoJSON((m) => console.log('[gdp-timeline]', m));
    const matched = attachMultiYearGDPToGeoJSON(geo);
    console.log(`[gdp-timeline] 匹配 ${matched}/${geo.features.length} 省`);

    const breaks = computeGlobalGDPBreaks();

    // 创建图层
    gdpTimelineLayer = L.geoJSON(geo, {
        style: (f) => {
            const v = (f.properties && f.properties['gdp_' + GDP_TIMELINE_YEARS[0]]) || 0;
            return {
                fillColor: getChoroplethColor(v, breaks),
                weight: 1,
                color: '#fff',
                fillOpacity: 0.78
            };
        },
        onEachFeature: (f, layer) => {
            const name = f.properties.name || '?';
            layer.on('mouseover', () => layer.setStyle({ weight: 3, color: '#333' }));
            layer.on('mouseout', () => layer.setStyle({ weight: 1, color: '#fff' }));
            layer.bindTooltip(() => {
                const y = currentGDPYear || GDP_TIMELINE_YEARS[0];
                const v = f.properties['gdp_' + y];
                return `<b>${escapeHtml(String(name))}</b><br/>${y} GDP：${v ? v.toLocaleString() + ' 亿元' : '无数据'}`;
            }, { sticky: true });
        }
    }).addTo(map);

    try { map.fitBounds(gdpTimelineLayer.getBounds(), { padding: [30, 30] }); } catch (_) {}

    // 启用 timeDimension（用每年 P1Y）
    if (!map.timeDimension) {
        map.timeDimension = new L.TimeDimension({
            timeInterval: GDP_TIMELINE_YEARS[0] + '-01-01/' + GDP_TIMELINE_YEARS[GDP_TIMELINE_YEARS.length - 1] + '-12-31',
            period: 'P1Y'
        });
    } else {
        map.timeDimension.setAvailableTimes(
            GDP_TIMELINE_YEARS.map(y => new Date(y + '-01-01').getTime()).join(','),
            'replace'
        );
    }

    gdpTimelineControl = new L.Control.TimeDimension({
        position: 'bottomright',
        autoPlay: false,
        playerOptions: { buffer: 1, transitionTime: 600, loop: true, startOver: true },
        timeSliderDragUpdate: true,
        speedSlider: false
    });
    map.addControl(gdpTimelineControl);

    // 顶部年份大字
    gdpTimelineTitle = L.DomUtil.create('div', '', document.body);
    gdpTimelineTitle.style.cssText = `position:fixed;top:90px;left:50%;transform:translateX(-50%);z-index:9000;
        background:rgba(0,0,0,0.7);color:#fff;padding:8px 24px;border-radius:6px;
        font-size:28px;font-weight:bold;letter-spacing:2px;pointer-events:none;
        box-shadow:0 2px 12px rgba(0,0,0,0.3);font-family:'Helvetica Neue',Arial,sans-serif;`;
    gdpTimelineTitle.textContent = GDP_TIMELINE_YEARS[0] + ' 年';

    // 监听时间变化，重绘
    const onTimeChange = () => {
        if (!gdpTimelineLayer || !map.timeDimension) return;
        const t = map.timeDimension.getCurrentTime();
        const y = new Date(t).getUTCFullYear();
        // 取最接近且 ≤ y 的年份
        let pick = GDP_TIMELINE_YEARS[0];
        for (const yr of GDP_TIMELINE_YEARS) {
            if (yr <= y) pick = yr;
        }
        currentGDPYear = pick;
        gdpTimelineLayer.eachLayer(layer => {
            const v = (layer.feature.properties && layer.feature.properties['gdp_' + pick]) || 0;
            layer.setStyle({ fillColor: getChoroplethColor(v, breaks) });
        });
        if (gdpTimelineTitle) gdpTimelineTitle.textContent = pick + ' 年';
    };
    map.timeDimension.on('timeload', onTimeChange);
    gdpTimelineLayer._timeChangeHandler = onTimeChange;

    // 立刻渲染一次
    onTimeChange();
}

let currentGDPYear = GDP_TIMELINE_YEARS[0];

function stopGDPTimeline() {
    if (gdpTimelineLayer) {
        if (gdpTimelineLayer._timeChangeHandler && map.timeDimension) {
            try { map.timeDimension.off('timeload', gdpTimelineLayer._timeChangeHandler); } catch (_) {}
        }
        try { map.removeLayer(gdpTimelineLayer); } catch (_) {}
        gdpTimelineLayer = null;
    }
    if (gdpTimelineControl) {
        try { map.removeControl(gdpTimelineControl); } catch (_) {}
        gdpTimelineControl = null;
    }
    if (gdpTimelineTitle) {
        try { document.body.removeChild(gdpTimelineTitle); } catch (_) {}
        gdpTimelineTitle = null;
    }
}


// ============================================================================
// 🚄 模块 3：OD 数据时间轴（按月不同流量，看春运动态）
// - 12 个月的 OD 数据，volume 随月份变化（春运 1/2 月、暑运 7/8 月、国庆 10 月高峰）
// - 用动态 setStyle + 每月重绘的方式，结合 timeDimension 实现
// ============================================================================

let odTimelineLayer = null;       // LayerGroup（每月重建）
let odTimelineControl = null;
let odTimelineTitle = null;

// 月份 → 流量倍数（春运/暑运/国庆高峰）
const OD_MONTH_FACTORS = [1.6, 1.8, 0.7, 0.8, 0.9, 1.0, 1.4, 1.5, 1.0, 1.3, 0.8, 1.5];

function buildODForMonth(month) {
    // month: 1-12
    const factor = OD_MONTH_FACTORS[month - 1] || 1;
    return OD_DEMO_DATA.map(od => ({
        ...od,
        volume: Math.round(od.volume * factor)
    }));
}

function renderODTimelineMonth(month) {
    // 清掉旧的子图层
    if (odTimelineLayer) {
        odTimelineLayer.clearLayers();
    } else {
        odTimelineLayer = L.layerGroup().addTo(map);
    }

    const odList = buildODForMonth(month);
    const maxV = Math.max(...odList.map(o => o.volume || 1));

    const colorByVolume = (v) => {
        const r = v / maxV;
        if (r > 0.75) return '#E53935';
        if (r > 0.5)  return '#FB8C00';
        if (r > 0.25) return '#FDD835';
        return '#43A047';
    };

    const cityShown = new Set();
    odList.forEach(od => {
        const a = OD_CITY_COORDS[od.from];
        const b = OD_CITY_COORDS[od.to];
        if (!a || !b) return;
        const color = colorByVolume(od.volume);
        const weight = 1.5 + (od.volume / maxV) * 4;
        const arc = buildArcLatLngs(a, b, 0.22);
        const ant = antPath(arc, {
            color,
            pulseColor: '#ffffff',
            weight,
            opacity: 0.85,
            delay: 1400,
            dashArray: [10, 20],
            hardwareAccelerated: true
        });
        ant.bindTooltip(`${od.from} → ${od.to}<br/>${month}月 流量：${od.volume}`, { sticky: true });
        ant.addTo(odTimelineLayer);

        [['from', a], ['to', b]].forEach(([key, latlng]) => {
            const cityName = od[key];
            if (cityShown.has(cityName)) return;
            cityShown.add(cityName);
            L.marker(latlng, { icon: createODCityIcon(cityName, '#1E88E5') }).addTo(odTimelineLayer);
        });
    });
}

async function startODTimeline() {
    stopODTimeline();

    // 启用按月的 timeDimension（覆盖之前的全局 timeDimension）
    map.timeDimension = new L.TimeDimension({
        timeInterval: '2024-01-01/2024-12-31',
        period: 'P1M'
    });

    odTimelineControl = new L.Control.TimeDimension({
        position: 'bottomright',
        autoPlay: false,
        playerOptions: { buffer: 1, transitionTime: 800, loop: true, startOver: true },
        timeSliderDragUpdate: true,
        speedSlider: false
    });
    map.addControl(odTimelineControl);

    // 顶部月份大字
    odTimelineTitle = L.DomUtil.create('div', '', document.body);
    odTimelineTitle.style.cssText = `position:fixed;top:90px;left:50%;transform:translateX(-50%);z-index:9000;
        background:rgba(229,57,53,0.8);color:#fff;padding:8px 24px;border-radius:6px;
        font-size:24px;font-weight:bold;letter-spacing:2px;pointer-events:none;
        box-shadow:0 2px 12px rgba(0,0,0,0.3);`;
    odTimelineTitle.textContent = '🚄 1 月（春运高峰）';

    const monthLabels = {
        1: '🚄 1 月（春运高峰）', 2: '🚄 2 月（春运返程）',
        3: '3 月', 4: '4 月', 5: '5 月', 6: '6 月',
        7: '☀️ 7 月（暑运）', 8: '☀️ 8 月（暑运高峰）',
        9: '9 月', 10: '🎉 10 月（国庆）',
        11: '11 月', 12: '🎄 12 月（年终高峰）'
    };

    const onTimeChange = () => {
        const t = map.timeDimension.getCurrentTime();
        const m = new Date(t).getUTCMonth() + 1;
        renderODTimelineMonth(m);
        if (odTimelineTitle) odTimelineTitle.textContent = monthLabels[m] || (m + ' 月');
    };
    map.timeDimension.on('timeload', onTimeChange);

    if (!odTimelineLayer) odTimelineLayer = L.layerGroup().addTo(map);
    odTimelineLayer._timeChangeHandler = onTimeChange;

    // 立刻渲染 1 月
    renderODTimelineMonth(1);

    // 自适应到 OD 范围
    const allCoords = Object.values(OD_CITY_COORDS);
    if (allCoords.length) {
        try { map.fitBounds(L.latLngBounds(allCoords), { padding: [60, 60] }); } catch (_) {}
    }
}

function stopODTimeline() {
    if (odTimelineLayer) {
        if (odTimelineLayer._timeChangeHandler && map.timeDimension) {
            try { map.timeDimension.off('timeload', odTimelineLayer._timeChangeHandler); } catch (_) {}
        }
        try { map.removeLayer(odTimelineLayer); } catch (_) {}
        odTimelineLayer = null;
    }
    if (odTimelineControl) {
        try { map.removeControl(odTimelineControl); } catch (_) {}
        odTimelineControl = null;
    }
    if (odTimelineTitle) {
        try { document.body.removeChild(odTimelineTitle); } catch (_) {}
        odTimelineTitle = null;
    }
}


// ============================================================================
// 🎬 模块 2 + 3 共用控制面板
// ============================================================================

const TimelineExtControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd: function () {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control timeline-ext-control');
        div.style.cssText = 'background:#fff;padding:6px 8px;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,0.15);border-radius:4px;min-width:180px;margin-bottom:6px;';
        div.innerHTML = `
            <div style="font-weight:bold;margin-bottom:4px;">🎬 时间轴扩展</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">
                <button id="tlx-gdp-btn" style="padding:3px 8px;font-size:11px;border:1px solid #00897B;background:#00897B;color:#fff;border-radius:3px;cursor:pointer;" title="2018-2023 各省 GDP 演变">📈 GDP 6年</button>
                <button id="tlx-od-btn" style="padding:3px 8px;font-size:11px;border:1px solid #E53935;background:#E53935;color:#fff;border-radius:3px;cursor:pointer;" title="按月切换的 OD 飞线">🚄 OD 12月</button>
                <button id="tlx-stop-btn" style="padding:3px 8px;font-size:11px;border:1px solid #888;background:#fff;color:#555;border-radius:3px;cursor:pointer;">停止</button>
            </div>
            <div style="margin-top:4px;color:#888;font-size:10px;line-height:1.4;">
                右下角时间轴控制播放
            </div>
        `;
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.disableScrollPropagation(div);

        setTimeout(() => {
            const gdpBtn = div.querySelector('#tlx-gdp-btn');
            const odBtn = div.querySelector('#tlx-od-btn');
            const stopBtn = div.querySelector('#tlx-stop-btn');
            if (gdpBtn) gdpBtn.addEventListener('click', async () => {
                stopODTimeline();
                gdpBtn.disabled = true; const o = gdpBtn.textContent; gdpBtn.textContent = '加载中...';
                try { await startGDPTimeline(); } catch (err) { alert('加载失败：' + err.message); }
                finally { gdpBtn.disabled = false; gdpBtn.textContent = o; }
            });
            if (odBtn) odBtn.addEventListener('click', async () => {
                stopGDPTimeline();
                try { await startODTimeline(); } catch (err) { alert('启动失败：' + err.message); }
            });
            if (stopBtn) stopBtn.addEventListener('click', () => {
                stopGDPTimeline();
                stopODTimeline();
            });
        }, 0);

        return div;
    }
});
map.addControl(new TimelineExtControl());


// ============================================================================
// 🗂 模块 4：绘制图形分组管理（左侧抽屉）
// - 列出 drawnLayers 所有图形：序号 / 类型 / 名称 / 简要指标
// - 单选高亮 + 点击定位
// - 批量重命名（添加前缀/后缀）+ 批量删除 + 全选 + 导出 GeoJSON
// ============================================================================

let drawnDrawerVisible = false;
let drawnDrawerEl = null;

function openDrawnDrawer() {
    drawnDrawerVisible = true;
    if (!drawnDrawerEl) {
        drawnDrawerEl = L.DomUtil.create('div', '', document.body);
        drawnDrawerEl.id = 'drawn-drawer';
        drawnDrawerEl.style.cssText = `position:fixed;top:0;left:0;bottom:0;width:300px;z-index:9500;
            background:#fff;box-shadow:2px 0 12px rgba(0,0,0,0.15);
            display:flex;flex-direction:column;font-size:13px;
            transform:translateX(0);transition:transform 0.25s;`;
        L.DomEvent.disableClickPropagation(drawnDrawerEl);
        L.DomEvent.disableScrollPropagation(drawnDrawerEl);
    }
    drawnDrawerEl.style.display = 'flex';
    drawnDrawerEl.style.transform = 'translateX(0)';
    renderDrawnDrawer();
}

function closeDrawnDrawer() {
    drawnDrawerVisible = false;
    if (drawnDrawerEl) {
        drawnDrawerEl.style.transform = 'translateX(-100%)';
        setTimeout(() => { if (drawnDrawerEl) drawnDrawerEl.style.display = 'none'; }, 280);
    }
}

function getDrawnLayerSummary(layer) {
    const info = getDrawnLayerInfo(layer);
    return info.typeText + ' · ' + (info.metricsHTML.split('<br')[0] || '');
}

function renderDrawnDrawer() {
    if (!drawnDrawerEl) return;
    const layers = [];
    drawnLayers.eachLayer(l => layers.push(l));

    drawnDrawerEl.innerHTML = `
        <div style="padding:10px 14px;background:#1E88E5;color:#fff;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:bold;font-size:14px;">🗂 绘制图形 (${layers.length})</span>
            <span id="drawer-close" style="cursor:pointer;font-size:18px;line-height:1;">×</span>
        </div>
        <div style="padding:8px 12px;border-bottom:1px solid #eee;display:flex;flex-wrap:wrap;gap:4px;">
            <label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;">
                <input type="checkbox" id="drawer-select-all"> 全选
            </label>
            <button id="drawer-rename-batch" style="padding:3px 8px;font-size:11px;border:1px solid #1E88E5;background:#fff;color:#1E88E5;border-radius:3px;cursor:pointer;">批量重命名</button>
            <button id="drawer-delete-batch" style="padding:3px 8px;font-size:11px;border:1px solid #E53935;background:#fff;color:#E53935;border-radius:3px;cursor:pointer;">批量删除</button>
            <button id="drawer-export" style="padding:3px 8px;font-size:11px;border:1px solid #43A047;background:#fff;color:#43A047;border-radius:3px;cursor:pointer;">导出 GeoJSON</button>
        </div>
        <div id="drawer-list" style="flex:1;overflow-y:auto;padding:6px 0;"></div>
    `;

    const listEl = drawnDrawerEl.querySelector('#drawer-list');
    if (layers.length === 0) {
        listEl.innerHTML = '<div style="text-align:center;color:#999;padding:40px 16px;font-size:12px;line-height:1.6;">还没有绘制任何图形<br/>使用左侧 ✏️ 工具栏开始绘制</div>';
    } else {
        layers.forEach((layer, idx) => {
            const item = document.createElement('div');
            item.className = 'drawer-item';
            item.style.cssText = 'padding:8px 12px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;gap:8px;cursor:pointer;';
            const name = layer._customName || ('图形 ' + (idx + 1));
            item.innerHTML = `
                <input type="checkbox" class="drawer-cb" data-idx="${idx}" style="margin:0;">
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:bold;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(name)}</div>
                    <div style="font-size:11px;color:#888;margin-top:2px;">${getDrawnLayerSummary(layer)}</div>
                </div>
                <button class="drawer-zoom" data-idx="${idx}" title="定位" style="padding:2px 6px;font-size:11px;border:1px solid #ddd;background:#fff;color:#1E88E5;border-radius:3px;cursor:pointer;">🔍</button>
                <button class="drawer-rename" data-idx="${idx}" title="重命名" style="padding:2px 6px;font-size:11px;border:1px solid #ddd;background:#fff;color:#1E88E5;border-radius:3px;cursor:pointer;">✏️</button>
                <button class="drawer-delete" data-idx="${idx}" title="删除" style="padding:2px 6px;font-size:11px;border:1px solid #ddd;background:#fff;color:#E53935;border-radius:3px;cursor:pointer;">🗑</button>
            `;
            // hover 高亮
            item.addEventListener('mouseenter', () => {
                if (typeof layer.setStyle === 'function') {
                    layer._origStyle = layer._origStyle || { color: layer.options.color, weight: layer.options.weight };
                    layer.setStyle({ weight: 5, color: '#FF6F00' });
                }
            });
            item.addEventListener('mouseleave', () => {
                if (layer._origStyle && typeof layer.setStyle === 'function') {
                    layer.setStyle({ weight: layer._origStyle.weight || 3, color: layer._origStyle.color || '#3388ff' });
                }
            });
            listEl.appendChild(item);
        });
    }

    // 关闭按钮
    drawnDrawerEl.querySelector('#drawer-close').addEventListener('click', closeDrawnDrawer);

    // 全选
    const selectAll = drawnDrawerEl.querySelector('#drawer-select-all');
    selectAll.addEventListener('change', (e) => {
        drawnDrawerEl.querySelectorAll('.drawer-cb').forEach(cb => { cb.checked = e.target.checked; });
    });

    // 批量重命名（添加前缀）
    drawnDrawerEl.querySelector('#drawer-rename-batch').addEventListener('click', () => {
        const checked = Array.from(drawnDrawerEl.querySelectorAll('.drawer-cb:checked'));
        if (checked.length === 0) { alert('请先勾选要重命名的图形'); return; }
        const tpl = prompt(`批量重命名 (${checked.length} 个)\n\n模板说明：\n  使用 {n} 表示序号、{name} 表示原名称\n  例：区域_{n}  →  区域_1, 区域_2 ...\n  例：[已审核]{name}  →  [已审核]原名称`, '区域_{n}');
        if (tpl === null) return;
        checked.forEach((cb, i) => {
            const idx = parseInt(cb.dataset.idx, 10);
            const layer = layers[idx];
            const oldName = layer._customName || ('图形 ' + (idx + 1));
            layer._customName = tpl.replace(/\{n\}/g, String(i + 1)).replace(/\{name\}/g, oldName);
        });
        saveDrawnLayersToStorage();
        renderDrawnDrawer();
    });

    // 批量删除
    drawnDrawerEl.querySelector('#drawer-delete-batch').addEventListener('click', () => {
        const checked = Array.from(drawnDrawerEl.querySelectorAll('.drawer-cb:checked'));
        if (checked.length === 0) { alert('请先勾选要删除的图形'); return; }
        if (!confirm(`确定要删除 ${checked.length} 个图形吗？此操作无法撤销。`)) return;
        const toRemove = checked.map(cb => layers[parseInt(cb.dataset.idx, 10)]);
        toRemove.forEach(l => {
            try { drawnLayers.removeLayer(l); } catch (_) {}
        });
        if (lastDrawnLayer && toRemove.includes(lastDrawnLayer)) lastDrawnLayer = null;
        saveDrawnLayersToStorage();
        renderDrawnDrawer();
    });

    // 导出 GeoJSON
    drawnDrawerEl.querySelector('#drawer-export').addEventListener('click', () => {
        if (layers.length === 0) { alert('当前没有图形可导出'); return; }
        const fc = { type: 'FeatureCollection', features: [] };
        layers.forEach(layer => {
            const feat = leafletLayerToTurf(layer);
            if (feat) {
                feat.properties = feat.properties || {};
                feat.properties.name = layer._customName || '';
                fc.features.push(feat);
            }
        });
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'drawn-layers-' + Date.now() + '.geojson';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    // 单条按钮
    drawnDrawerEl.querySelectorAll('.drawer-zoom').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            const layer = layers[idx];
            if (typeof layer.getBounds === 'function') {
                try { map.fitBounds(layer.getBounds(), { padding: [40, 40] }); } catch (_) {}
            } else if (typeof layer.getLatLng === 'function') {
                map.panTo(layer.getLatLng());
            }
        });
    });
    drawnDrawerEl.querySelectorAll('.drawer-rename').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            const layer = layers[idx];
            const cur = layer._customName || '';
            const next = prompt('请输入新名称：', cur);
            if (next === null) return;
            layer._customName = next.trim();
            saveDrawnLayersToStorage();
            renderDrawnDrawer();
        });
    });
    drawnDrawerEl.querySelectorAll('.drawer-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            const layer = layers[idx];
            if (!confirm('确定要删除这个图形吗？')) return;
            try { drawnLayers.removeLayer(layer); } catch (_) {}
            if (lastDrawnLayer === layer) lastDrawnLayer = null;
            saveDrawnLayersToStorage();
            renderDrawnDrawer();
        });
    });
}

// 切换抽屉的左上角按钮
const DrawnDrawerToggle = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control drawn-drawer-toggle');
        div.style.cssText = 'background:#fff;cursor:pointer;';
        div.innerHTML = `<a href="#" title="绘制图形列表" style="display:block;width:30px;height:30px;line-height:30px;text-align:center;font-size:18px;color:#1E88E5;text-decoration:none;">🗂</a>`;
        L.DomEvent.disableClickPropagation(div);
        div.addEventListener('click', (e) => {
            e.preventDefault();
            if (drawnDrawerVisible) closeDrawnDrawer();
            else openDrawnDrawer();
        });
        return div;
    }
});
map.addControl(new DrawnDrawerToggle());

// 绘制图层变化时，如果抽屉打开就自动刷新
['pm:create', 'pm:edit', 'pm:remove'].forEach(evt => {
    map.on(evt, () => { if (drawnDrawerVisible) renderDrawnDrawer(); });
});


// ============================================================================
// 启动：恢复绘制图形 + 给已恢复图层绑 popup（bindDrawnLayerPopup 在恢复内部已调用）
// ============================================================================
restoreDrawnLayersFromStorage();


// ============================================================================
// ============================================================================
//
//                  🧭 实时骑行 / 驾车 / 步行 导航模块（拟真版 C）
//
//   特性：
//     1) 「开始导航」：启动 navigator.geolocation.watchPosition 真实位置流
//     2) 「模拟导航」：requestAnimationFrame 沿路径推进，速度可调（不需要真位置）
//     3) 当前位置投影到路径折线（点到折线最短距离），算出"已走 N 米"
//     4) 已走部分变灰、待行部分高亮，箭头 marker 沿路径前进
//     5) 顶部 HUD：剩余距离/剩余时间/速度/转向提示/进度条
//     6) 偏航检测（>50m）→ 自动重新规划
//     7) 到达检测：进入终点 30m 内 → 完成弹窗 + 写入历史记录（localStorage）
//     8) 转向提示：基于路径几何检测下一个转弯点，给出 ⬆️↗️↘️ 方向 + 距离
//     9) 第一视角（可选）：跟随用户位置 + 头部朝向行进方向
//
//   状态机：IDLE → RUNNING → (PAUSED) → FINISHED / STOPPED
// ============================================================================

// 兜底 toast：项目里如果已有 showToast 就复用；没有就在这里定义
if (typeof window.showToast !== 'function') {
    window.showToast = function (msg, type) {
        const div = document.createElement('div');
        div.style.cssText = `
            position:fixed;top:80px;left:50%;transform:translateX(-50%);
            background:${type === 'error' ? '#E53935' : type === 'warn' ? '#FB8C00' : type === 'success' ? '#43A047' : '#1E88E5'};
            color:#fff;padding:8px 18px;border-radius:6px;z-index:3000;
            font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.25);
            transition:opacity .3s;`;
        div.textContent = msg;
        document.body.appendChild(div);
        setTimeout(() => { div.style.opacity = '0'; }, 2000);
        setTimeout(() => { try { div.remove(); } catch(_) {} }, 2400);
    };
}
const showToast = window.showToast;

// -------------------- 模块级状态 --------------------
let navState = 'IDLE';                    // IDLE | RUNNING | PAUSED | FINISHED
let navMode  = 'real';                    // real | sim
let navCoords = null;                     // 当前路径 [[lat,lng],...]
let navTotalDist = 0;                     // 路径总长（米）
let navTotalDur  = 0;                     // 路径总时长（秒，接口给的）
let navOriginInfo = null;                 // { lat, lng, name }
let navDestInfo   = null;                 // { lat, lng, name }
let navTransport  = 'bicycling';          // 启动时记下 routeMode 快照
let navWatchId = null;                    // geolocation.watchPosition id
let navSimRafId = null;                   // requestAnimationFrame id
let navSimPrevTs = 0;                     // 模拟模式上一帧时间戳
let navSimSpeedKmh = 15;                  // 模拟速度（km/h），可由滑块调
let navWalkedDist = 0;                    // 已走累计距离（米）
let navCurLatLng = null;                  // 当前投影后的位置 [lat,lng]
let navMaxSpeed = 0;                      // 历史最高速度（m/s）
let navStartTime = 0;                     // 起始毫秒时间戳
let navPausedAccum = 0;                   // 暂停累计毫秒
let navPausedAt = 0;                      // 当前暂停起始时间戳
let navFollowCamera = true;               // 是否相机跟随
let navTraveledLine = null;               // 已走的灰色折线
let navAheadLine    = null;               // 待行的高亮折线
let navArrowMarker  = null;               // 行进箭头 marker
let navOffroutePoly = null;               // 偏航连接线（用户位置→最近路径点）
let navReplanCooldown = 0;                // 偏航重规划冷却（毫秒时间戳）
let navLastSpeed = 0;                     // 最近一次速度（m/s），用于估剩余时间
let navMaxHistory = 30;                   // localStorage 最多保留多少条记录
const NAV_HISTORY_KEY = 'leaflet_demo_nav_history_v1';

// -------------------- 工具函数 --------------------

// 米制 Haversine（Leaflet 自带 distance 走的是 Vincenty 形式，平面应用上等价；这里复用）
function navHaversine(a, b) {
    return map.distance(a, b);  // 返回米
}

/**
 * 把点 p 投影到由 [a, b] 组成的线段上，返回：
 *   { lat, lng } 投影点
 *   t          归一化参数 [0,1]
 *   dist       p 到投影点的距离（米）
 */
function navProjectOnSegment(p, a, b) {
    // 用本地切平面线性近似（数百米尺度足够），再用 map.distance 修正距离
    const ax = a[1], ay = a[0]; // lng, lat
    const bx = b[1], by = b[0];
    const px = p[1], py = p[0];
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t;
    if (lenSq < 1e-14) t = 0;
    else t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projLat = ay + dy * t;
    const projLng = ax + dx * t;
    const proj = [projLat, projLng];
    return { lat: projLat, lng: projLng, t, dist: navHaversine(p, proj), proj };
}

/**
 * 把点 p 投影到整条折线 coords 上，找到最近段。
 * 返回：{ segIdx, t, dist, traveled } —— traveled = 起点到投影点的累计米数
 */
function navProjectOnPolyline(p, coords) {
    let best = null;
    let cumulative = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        const segLen = navHaversine(a, b);
        const r = navProjectOnSegment(p, a, b);
        if (best === null || r.dist < best.dist) {
            best = {
                segIdx: i,
                t: r.t,
                dist: r.dist,
                proj: r.proj,
                traveled: cumulative + segLen * r.t
            };
        }
        cumulative += segLen;
    }
    return best;
}

// 计算整条折线总长度
function navPolylineLength(coords) {
    let s = 0;
    for (let i = 0; i < coords.length - 1; i++) s += navHaversine(coords[i], coords[i + 1]);
    return s;
}

// 把折线在 traveled 米处一切两半 -> { walked: [...], ahead: [...] }
function navSplitPolyline(coords, traveled) {
    const walked = [];
    const ahead  = [];
    let acc = 0;
    let split = false;
    for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        const segLen = navHaversine(a, b);
        if (!split && acc + segLen >= traveled) {
            const t = segLen > 1e-6 ? (traveled - acc) / segLen : 0;
            const lat = a[0] + (b[0] - a[0]) * t;
            const lng = a[1] + (b[1] - a[1]) * t;
            walked.push(a, [lat, lng]);
            ahead.push([lat, lng], b);
            split = true;
        } else if (!split) {
            walked.push(a);
            if (i === coords.length - 2) walked.push(b);
        } else {
            if (ahead.length === 0) ahead.push(a);
            ahead.push(b);
        }
        acc += segLen;
    }
    if (!split) {
        // 还没开始 / 全部已走
        if (traveled <= 0) return { walked: [], ahead: coords.slice() };
        else return { walked: coords.slice(), ahead: [] };
    }
    return { walked, ahead };
}

// 在 traveled 米处取得该位置的方向角（航向，单位：度，0=正北，90=正东）
function navBearingAt(coords, traveled) {
    let acc = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        const segLen = navHaversine(a, b);
        if (acc + segLen >= traveled || i === coords.length - 2) {
            return navBearing(a, b);
        }
        acc += segLen;
    }
    return 0;
}

// 两点航向角（度，0=北 顺时针）
function navBearing(a, b) {
    const φ1 = a[0] * Math.PI / 180;
    const φ2 = b[0] * Math.PI / 180;
    const Δλ = (b[1] - a[1]) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * 找到下一个"显著拐弯"点：从 traveled 米处往前扫，
 * 累计偏航 > 30° 的最近一处节点 -> 返回 { distAhead, turnAngle }
 * 没有则返回 null（说明前方近距离基本是直行）
 */
function navFindNextTurn(coords, traveled, lookahead = 800) {
    let acc = 0;
    let baseBearing = null;
    let scanned = 0;

    // 先定位到 traveled 所在 segIdx
    let startIdx = 0;
    let leftover = traveled;
    for (let i = 0; i < coords.length - 1; i++) {
        const segLen = navHaversine(coords[i], coords[i + 1]);
        if (leftover <= segLen) { startIdx = i; break; }
        leftover -= segLen;
    }
    baseBearing = navBearing(coords[startIdx], coords[startIdx + 1]);

    for (let i = startIdx + 1; i < coords.length - 1; i++) {
        const segLen = navHaversine(coords[i], coords[i + 1]);
        const newBearing = navBearing(coords[i], coords[i + 1]);
        let diff = ((newBearing - baseBearing + 540) % 360) - 180; // [-180,180]
        if (Math.abs(diff) > 30) {
            // 这个节点是个拐弯
            const distAhead = scanned + (navHaversine(coords[startIdx], coords[startIdx + 1]) - leftover);
            return {
                distAhead: Math.max(0, scanned),
                turnAngle: diff,
                turnLatLng: coords[i]
            };
        }
        scanned += segLen;
        if (scanned > lookahead) break;
        baseBearing = newBearing;
    }
    return null;
}

// 把转弯角度转成 emoji + 文字
function navTurnToEmoji(angle) {
    const a = angle;
    if (a > 135 || a < -135) return { icon: '⬇️', text: '请掉头' };
    if (a > 60)              return { icon: '↘️', text: '右转' };
    if (a > 20)              return { icon: '↗️', text: '右前方转向' };
    if (a < -135)            return { icon: '⬇️', text: '请掉头' };
    if (a < -60)             return { icon: '↙️', text: '左转' };
    if (a < -20)             return { icon: '↖️', text: '左前方转向' };
    return { icon: '⬆️', text: '直行' };
}

// 米 -> 易读字符串
function navFmtDist(m) {
    if (m == null || isNaN(m)) return '--';
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toFixed(2) + ' km';
}

// 秒 -> 易读字符串
function navFmtDur(s) {
    if (s == null || isNaN(s) || s < 0) return '--';
    s = Math.round(s);
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分';
    const h = Math.floor(m / 60);
    return h + ' 时 ' + (m % 60) + ' 分';
}

// m/s -> km/h 文字
function navFmtSpeed(mps) {
    if (mps == null || isNaN(mps)) return '--';
    return (mps * 3.6).toFixed(1) + ' km/h';
}


// -------------------- 启动入口 --------------------

/**
 * 在路径摘要里"开始导航 / 模拟导航 / 历史"按钮渲染后绑定事件
 * （由 renderMainRoute 末尾 setTimeout(bindNavLaunchControls, 0) 触发）
 */
function bindNavLaunchControls() {
    const realBtn = document.getElementById('nav-start-real-btn');
    const simBtn  = document.getElementById('nav-start-sim-btn');
    const hisBtn  = document.getElementById('nav-history-open-btn');
    if (realBtn) realBtn.addEventListener('click', () => startNavigation('real'));
    if (simBtn)  simBtn.addEventListener('click',  () => startNavigation('sim'));
    if (hisBtn)  hisBtn.addEventListener('click',  () => openNavHistoryDrawer());
}

/**
 * 启动导航
 *  mode: 'real' | 'sim'
 */
function startNavigation(mode) {
    // 公交模式不支持
    if (routeMode === 'transit') {
        alert('🚌 公交模式暂不支持实时导航\n请切换到 🚗 驾车 / 🚶 步行 / 🚴 骑行');
        return;
    }
    if (!alternativeData || !alternativeData.length) {
        alert('请先规划一条路线');
        return;
    }
    if (navState === 'RUNNING' || navState === 'PAUSED') {
        if (!confirm('当前正在导航，是否结束当前导航后重新开始？')) return;
        stopNavigation({ silent: true });
    }

    const main = alternativeData[selectedAlternativeIdx] || alternativeData[0];
    navCoords     = main.coords.slice();
    navTotalDist  = navPolylineLength(navCoords);
    navTotalDur   = main.duration || 0;
    navOriginInfo = routeOrigin ? { ...routeOrigin } : null;
    navDestInfo   = routeDestination ? { ...routeDestination } : null;
    navTransport  = routeMode;
    navMode       = mode;
    navWalkedDist = 0;
    navMaxSpeed   = 0;
    navLastSpeed  = 0;
    navStartTime  = Date.now();
    navPausedAccum = 0;
    navPausedAt    = 0;
    navFollowCamera = true;
    navState = 'RUNNING';

    // 初始化 HUD
    showNavHud(true);
    document.getElementById('nav-hud-pause').textContent = '⏸ 暂停';
    document.getElementById('nav-hud-sim-row').classList.toggle('active', mode === 'sim');
    syncSimSpeedSlider();

    // 替换为"已走/待行"双线 + 隐藏蚂蚁线
    setupNavLayers();

    // 中心定到起点
    if (navOriginInfo) {
        navCurLatLng = [navOriginInfo.lat, navOriginInfo.lng];
        map.setView(navCurLatLng, Math.max(map.getZoom(), 15));
    } else {
        navCurLatLng = navCoords[0].slice();
        map.setView(navCurLatLng, Math.max(map.getZoom(), 15));
    }
    updateArrowMarker(navCurLatLng, navBearingAt(navCoords, 0));

    // 启动数据流
    if (mode === 'sim') {
        startSimLoop();
    } else {
        startRealWatch();
    }

    // 通用事件绑定（首次）
    bindHudControlsOnce();

    showToast(mode === 'sim'
        ? '🎮 模拟导航已启动 — 调节速度滑块体验'
        : '🧭 实时导航已启动 — 请允许定位授权', 'info');
}

// 准备双线（已走灰 / 待行高亮）
function setupNavLayers() {
    // 隐藏原蚂蚁线（保留对象，结束导航后可恢复）
    if (routePolyline && map.hasLayer(routePolyline)) {
        try { map.removeLayer(routePolyline); } catch (_) {}
    }

    const aheadColor = ({
        driving:   '#1E88E5',
        walking:   '#43A047',
        bicycling: '#FB8C00'
    })[navTransport] || '#1E88E5';

    if (navTraveledLine) { try { map.removeLayer(navTraveledLine); } catch (_) {} }
    if (navAheadLine)    { try { map.removeLayer(navAheadLine);    } catch (_) {} }

    navTraveledLine = L.polyline([], {
        color: '#9e9e9e', weight: 5, opacity: 0.55,
        lineJoin: 'round', lineCap: 'round'
    }).addTo(map);

    navAheadLine = L.polyline(navCoords, {
        color: aheadColor, weight: 6, opacity: 0.95,
        lineJoin: 'round', lineCap: 'round'
    }).addTo(map);
}

// 行进箭头 marker（DivIcon）
function updateArrowMarker(latlng, bearing) {
    const html =
        `<div style="
            width:28px;height:28px;border-radius:50%;
            background:#1E88E5;border:3px solid #fff;
            box-shadow:0 2px 6px rgba(0,0,0,.35);
            display:flex;align-items:center;justify-content:center;
            transform:rotate(${bearing}deg);transition:transform 0.3s;">
            <div style="
                width:0;height:0;
                border-left:6px solid transparent;
                border-right:6px solid transparent;
                border-bottom:10px solid #fff;
                margin-bottom:2px;"></div>
        </div>`;
    const icon = L.divIcon({
        className: 'nav-arrow-icon',
        html, iconSize: [28, 28], iconAnchor: [14, 14]
    });
    if (!navArrowMarker) {
        navArrowMarker = L.marker(latlng, { icon, zIndexOffset: 2000 }).addTo(map);
    } else {
        navArrowMarker.setLatLng(latlng);
        navArrowMarker.setIcon(icon);
    }
}


// -------------------- 真实位置流 --------------------
function startRealWatch() {
    if (!navigator.geolocation) {
        alert('浏览器不支持定位');
        stopNavigation({ silent: true });
        return;
    }
    navWatchId = navigator.geolocation.watchPosition(
        (pos) => {
            if (navState !== 'RUNNING') return;
            const { latitude, longitude, speed } = pos.coords;
            // WGS84 -> GCJ02（与底图一致）
            const [gcjLng, gcjLat] = CoordTransform.wgs84ToGcj02(longitude, latitude);
            const userLatLng = [gcjLat, gcjLng];
            navLastSpeed = (speed != null && !isNaN(speed)) ? speed : 0;
            if (navLastSpeed > navMaxSpeed) navMaxSpeed = navLastSpeed;
            advanceNav(userLatLng);
        },
        (err) => {
            console.warn('[nav] watchPosition 错误', err);
            showToast('⚠️ 定位失败：' + (err.message || err.code), 'warn');
        },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
}


// -------------------- 模拟位置流 --------------------
function startSimLoop() {
    navSimPrevTs = 0;
    const tick = (ts) => {
        if (navState !== 'RUNNING') {
            navSimRafId = requestAnimationFrame(tick); // 暂停时空转，恢复继续
            return;
        }
        if (!navSimPrevTs) navSimPrevTs = ts;
        const dt = (ts - navSimPrevTs) / 1000;  // 秒
        navSimPrevTs = ts;
        const speedMps = navSimSpeedKmh / 3.6;
        navLastSpeed = speedMps;
        if (speedMps > navMaxSpeed) navMaxSpeed = speedMps;
        const advance = speedMps * dt;
        const newWalked = Math.min(navWalkedDist + advance, navTotalDist);
        const userLatLng = sampleLatLngAt(navCoords, newWalked);
        if (userLatLng) advanceNav(userLatLng, /*forceWalked*/ newWalked);
        navSimRafId = requestAnimationFrame(tick);
    };
    navSimRafId = requestAnimationFrame(tick);
}

// 在折线 d 米处采样坐标
function sampleLatLngAt(coords, d) {
    if (!coords || coords.length < 2) return null;
    if (d <= 0) return coords[0].slice();
    let acc = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        const seg = navHaversine(a, b);
        if (acc + seg >= d || i === coords.length - 2) {
            const t = seg > 1e-6 ? (d - acc) / seg : 1;
            return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        }
        acc += seg;
    }
    return coords[coords.length - 1].slice();
}


// -------------------- 推进 / 偏航 / 到达 --------------------
function advanceNav(userLatLng, forceWalked) {
    if (!navCoords) return;
    const proj = navProjectOnPolyline(userLatLng, navCoords);

    // 偏航检测（真实模式才做，模拟模式始终在路径上）
    if (navMode === 'real' && proj.dist > 50) {
        // 显示偏航连接线
        if (!navOffroutePoly) {
            navOffroutePoly = L.polyline([userLatLng, proj.proj], {
                color: '#E53935', weight: 3, dashArray: '6 6', opacity: 0.85
            }).addTo(map);
        } else {
            navOffroutePoly.setLatLngs([userLatLng, proj.proj]);
        }
        // 冷却 8 秒，避免连续重规划
        const now = Date.now();
        if (proj.dist > 80 && now > navReplanCooldown) {
            navReplanCooldown = now + 8000;
            triggerReplan(userLatLng);
            return;
        }
    } else {
        if (navOffroutePoly) { try { map.removeLayer(navOffroutePoly); } catch(_) {} navOffroutePoly = null; }
    }

    // 已走距离：不允许倒退
    const traveled = forceWalked != null
        ? forceWalked
        : Math.max(navWalkedDist, proj.traveled);
    navWalkedDist = traveled;
    navCurLatLng  = proj.proj;

    // 双线分割
    const split = navSplitPolyline(navCoords, traveled);
    if (navTraveledLine) navTraveledLine.setLatLngs(split.walked);
    if (navAheadLine)    navAheadLine.setLatLngs(split.ahead);

    // 箭头 marker
    const bearing = navBearingAt(navCoords, traveled);
    updateArrowMarker(navCurLatLng, bearing);

    // 相机跟随
    if (navFollowCamera) {
        map.panTo(navCurLatLng, { animate: true, duration: 0.4 });
    }

    // HUD 更新
    updateHud(traveled, bearing);

    // 到达检测
    const remain = navTotalDist - traveled;
    const distToDest = navDestInfo
        ? navHaversine(navCurLatLng, [navDestInfo.lat, navDestInfo.lng])
        : remain;
    if (remain <= 5 || distToDest <= 30) {
        finishNavigation();
    }
}

// 偏航 → 重新规划：把当前位置当作新起点，调一次 planRoute
async function triggerReplan(userLatLng) {
    showToast('⚠️ 检测到偏航，正在重新规划路径…', 'warn');
    try {
        // 临时改 routeOrigin 为当前位置（不替换 marker，避免视觉跳变）
        const oldOrigin = routeOrigin;
        routeOrigin = { lat: userLatLng[0], lng: userLatLng[1], name: '当前位置（偏航）' };
        await planRoute();
        // 用新方案重置导航参数（保持 RUNNING 状态）
        if (alternativeData && alternativeData.length) {
            const main = alternativeData[selectedAlternativeIdx] || alternativeData[0];
            navCoords = main.coords.slice();
            navTotalDist = navPolylineLength(navCoords);
            navTotalDur  = main.duration || 0;
            navWalkedDist = 0;
            setupNavLayers();
            updateArrowMarker(userLatLng, navBearingAt(navCoords, 0));
            showToast('✅ 已切换到新路径', 'success');
        }
        // 还原 origin（仅显示用，不影响导航）
        routeOrigin = oldOrigin;
    } catch (e) {
        console.error('[nav] 重新规划失败', e);
        showToast('❌ 重新规划失败：' + (e.message || e), 'error');
    }
}


// -------------------- HUD 更新 --------------------
function updateHud(traveled, bearing) {
    const remain = Math.max(0, navTotalDist - traveled);
    const ratio  = navTotalDist > 0 ? Math.min(1, traveled / navTotalDist) : 0;

    // 用接口给的总时长按比例剩余 + 当前速度兜底
    let remainSec;
    if (navLastSpeed > 0.3) {
        remainSec = remain / navLastSpeed;
    } else if (navTotalDur > 0) {
        remainSec = navTotalDur * (1 - ratio);
    } else {
        remainSec = NaN;
    }

    const turn = navFindNextTurn(navCoords, traveled, 1000);
    let turnIcon = '⬆️', turnText = '沿当前道路直行';
    if (turn) {
        const t = navTurnToEmoji(turn.turnAngle);
        turnIcon = t.icon;
        turnText = `${navFmtDist(turn.distAhead)} 后${t.text}`;
    } else if (remain < 80) {
        turnIcon = '🏁';
        turnText = `即将到达终点（${navFmtDist(remain)}）`;
    }

    const $ = (id) => document.getElementById(id);
    $('nav-hud-turn-icon').textContent  = turnIcon;
    $('nav-hud-turn-text').textContent  = turnText;
    $('nav-hud-remain-dist').textContent = navFmtDist(remain);
    $('nav-hud-remain-time').textContent = navFmtDur(remainSec);
    $('nav-hud-speed').textContent       = navFmtSpeed(navLastSpeed);
    $('nav-hud-progress-bar').style.width = (ratio * 100).toFixed(1) + '%';
}


// -------------------- HUD 控件 --------------------
let navHudControlsBound = false;
function bindHudControlsOnce() {
    if (navHudControlsBound) return;
    navHudControlsBound = true;

    document.getElementById('nav-hud-recenter').addEventListener('click', () => {
        navFollowCamera = !navFollowCamera;
        document.getElementById('nav-hud-recenter').textContent = navFollowCamera ? '📷 跟随' : '📷 自由';
        if (navFollowCamera && navCurLatLng) map.panTo(navCurLatLng);
    });

    document.getElementById('nav-hud-pause').addEventListener('click', () => {
        if (navState === 'RUNNING') {
            navState = 'PAUSED';
            navPausedAt = Date.now();
            document.getElementById('nav-hud-pause').textContent = '▶️ 继续';
            showToast('⏸ 导航已暂停', 'info');
        } else if (navState === 'PAUSED') {
            navState = 'RUNNING';
            navPausedAccum += Date.now() - navPausedAt;
            navPausedAt = 0;
            navSimPrevTs = 0; // 模拟模式重置 dt 基准
            document.getElementById('nav-hud-pause').textContent = '⏸ 暂停';
            showToast('▶️ 继续导航', 'info');
        }
    });

    document.getElementById('nav-hud-stop').addEventListener('click', () => {
        if (confirm('确定要结束当前导航吗？')) stopNavigation();
    });

    // 模拟速度滑块
    const slider = document.getElementById('nav-hud-sim-speed');
    const sliderText = document.getElementById('nav-hud-sim-speed-text');
    slider.addEventListener('input', () => {
        navSimSpeedKmh = parseInt(slider.value, 10) || 15;
        sliderText.textContent = navSimSpeedKmh + ' km/h';
    });
}

function syncSimSpeedSlider() {
    const slider = document.getElementById('nav-hud-sim-speed');
    const sliderText = document.getElementById('nav-hud-sim-speed-text');
    if (!slider) return;
    // 不同模式给不同默认速度
    const def = ({
        bicycling: 15, walking: 5, driving: 50
    })[navTransport] || 15;
    navSimSpeedKmh = def;
    slider.value = String(def);
    sliderText.textContent = def + ' km/h';
}

function showNavHud(show) {
    const hud = document.getElementById('nav-hud');
    if (hud) hud.classList.toggle('active', !!show);
}


// -------------------- 结束 / 完成 --------------------
function stopNavigation(opts = {}) {
    const wasRunning = (navState === 'RUNNING' || navState === 'PAUSED');
    navState = 'IDLE';

    if (navWatchId != null) {
        try { navigator.geolocation.clearWatch(navWatchId); } catch (_) {}
        navWatchId = null;
    }
    if (navSimRafId != null) {
        try { cancelAnimationFrame(navSimRafId); } catch (_) {}
        navSimRafId = null;
    }

    if (navTraveledLine) { try { map.removeLayer(navTraveledLine); } catch(_) {} navTraveledLine = null; }
    if (navAheadLine)    { try { map.removeLayer(navAheadLine);    } catch(_) {} navAheadLine    = null; }
    if (navOffroutePoly) { try { map.removeLayer(navOffroutePoly); } catch(_) {} navOffroutePoly = null; }
    if (navArrowMarker)  { try { map.removeLayer(navArrowMarker);  } catch(_) {} navArrowMarker  = null; }

    showNavHud(false);

    if (wasRunning && !opts.silent) {
        showToast('⏹ 已结束导航', 'info');
    }
}

function finishNavigation() {
    if (navState !== 'RUNNING' && navState !== 'PAUSED') return;
    const elapsedMs = Date.now() - navStartTime - navPausedAccum;
    const elapsedSec = elapsedMs / 1000;
    const dist = navTotalDist;
    const avgSpeed = elapsedSec > 0 ? dist / elapsedSec : 0;

    // 写入历史
    saveNavHistory({
        ts: Date.now(),
        mode: navMode,
        transport: navTransport,
        origin: navOriginInfo,
        dest: navDestInfo,
        distance: Math.round(dist),
        duration: Math.round(elapsedSec),
        avgSpeed: avgSpeed,
        maxSpeed: navMaxSpeed
    });

    // 弹窗
    const $ = (id) => document.getElementById(id);
    $('nav-finish-dist').textContent = navFmtDist(dist);
    $('nav-finish-time').textContent = navFmtDur(elapsedSec);
    $('nav-finish-avg').textContent  = navFmtSpeed(avgSpeed);
    $('nav-finish-max').textContent  = navFmtSpeed(navMaxSpeed);
    const transportLabel = ({
        bicycling: '骑行', walking: '步行', driving: '驾车'
    })[navTransport] || '导航';
    $('nav-finish-title').textContent =
        (navMode === 'sim' ? '🎮 模拟' : '🎉 实时') + transportLabel + '完成！';
    $('nav-finish-mask').classList.add('active');

    // 停掉
    stopNavigation({ silent: true });
    navState = 'FINISHED';
}

// 完成弹窗 OK
document.addEventListener('DOMContentLoaded', () => {});
{
    const finishOkBtn = document.getElementById('nav-finish-ok');
    if (finishOkBtn) {
        finishOkBtn.addEventListener('click', () => {
            document.getElementById('nav-finish-mask').classList.remove('active');
        });
    }
}


// -------------------- 历史记录 --------------------
function loadNavHistory() {
    try {
        const raw = localStorage.getItem(NAV_HISTORY_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
}
function saveNavHistory(item) {
    const arr = loadNavHistory();
    arr.unshift(item);
    while (arr.length > navMaxHistory) arr.pop();
    try { localStorage.setItem(NAV_HISTORY_KEY, JSON.stringify(arr)); } catch (_) {}
}
function clearNavHistory() {
    try { localStorage.removeItem(NAV_HISTORY_KEY); } catch (_) {}
}

function openNavHistoryDrawer() {
    renderNavHistoryDrawer();
    document.getElementById('nav-history-drawer').classList.add('active');
}
function closeNavHistoryDrawer() {
    document.getElementById('nav-history-drawer').classList.remove('active');
}

function renderNavHistoryDrawer() {
    const list = loadNavHistory();
    const body = document.getElementById('nav-history-list');
    if (!list.length) {
        body.innerHTML = `<div class="nh-empty">暂无导航记录<br><br>完成一次导航后会自动保存在这里</div>`;
        return;
    }
    const transportEmoji = { bicycling: '🚴', walking: '🚶', driving: '🚗' };
    const html = list.map((it, idx) => {
        const date = new Date(it.ts);
        const dateStr = `${date.getMonth()+1}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
        const tEmoji = transportEmoji[it.transport] || '📍';
        const modeTag = it.mode === 'sim' ? '🎮 模拟' : '🧭 实时';
        const fromName = (it.origin && it.origin.name) || '起点';
        const toName   = (it.dest   && it.dest.name)   || '终点';
        return `
            <div class="nh-item" data-idx="${idx}">
                <div class="nh-it-title">
                    <span>${tEmoji} ${escapeHtml(fromName)} → ${escapeHtml(toName)}</span>
                    <span class="nh-it-mode">${modeTag}</span>
                </div>
                <div class="nh-it-line">📅 ${dateStr}</div>
                <div class="nh-it-line">📏 ${navFmtDist(it.distance)} · ⏱ ${navFmtDur(it.duration)} · ⚡ 平均 ${navFmtSpeed(it.avgSpeed)}</div>
                <div class="nh-it-actions">
                    <button data-act="reuse"  data-idx="${idx}">↩️ 复用为路线</button>
                    <button data-act="delete" data-idx="${idx}" class="danger">🗑 删除</button>
                </div>
            </div>`;
    }).join('');
    body.innerHTML = html;

    body.querySelectorAll('button[data-act]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx, 10);
            const act = btn.dataset.act;
            const arr = loadNavHistory();
            const it = arr[idx];
            if (!it) return;
            if (act === 'delete') {
                arr.splice(idx, 1);
                try { localStorage.setItem(NAV_HISTORY_KEY, JSON.stringify(arr)); } catch (_) {}
                renderNavHistoryDrawer();
            } else if (act === 'reuse') {
                if (it.origin) setRouteOrigin(L.latLng(it.origin.lat, it.origin.lng), it.origin.name);
                if (it.dest)   setRouteDestination(L.latLng(it.dest.lat,   it.dest.lng),   it.dest.name);
                // 切回对应模式
                const btnEl = document.querySelector(`.route-mode-btn[data-mode="${it.transport}"]`);
                if (btnEl) btnEl.click();
                closeNavHistoryDrawer();
                showToast('↩️ 已恢复历史路线起终点', 'success');
            }
        });
    });
}

// 历史抽屉事件（一次性绑定）
{
    const closeBtn = document.getElementById('nav-history-close');
    const clearBtn = document.getElementById('nav-history-clear');
    if (closeBtn) closeBtn.addEventListener('click', closeNavHistoryDrawer);
    if (clearBtn) clearBtn.addEventListener('click', () => {
        if (!confirm('确定要清空所有导航历史记录吗？')) return;
        clearNavHistory();
        renderNavHistoryDrawer();
        showToast('🗑 已清空全部记录', 'info');
    });
}