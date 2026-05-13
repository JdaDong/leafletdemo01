/**
 * deckgl3d.js —— Leaflet + deck.gl 真 3D 立柱图模块
 *
 * 思路：
 *   1) deck.gl 是一个独立的 WebGL 渲染器，不依赖任何地图库
 *   2) 通过监听 Leaflet 的 move/zoom 事件，把视图参数（中心、zoom、bearing、pitch）
 *      同步给 deck.gl 的 viewState，让两层画面"对齐"
 *   3) deck.gl 的 ColumnLayer / HexagonLayer / GeoJsonLayer({extruded:true})
 *      会渲染真正的 3D 几何体（立柱、六边形、挤出多边形）
 *
 * 与现有 init3DPack（CSS 伪 3D）的区别：
 *   - 那个：CSS transform: rotateX(45deg) → 整张地图倾斜，文字/POI 都会斜
 *   - 这个：另起一层 WebGL canvas → 立柱真 3D，但底图保持正常 2D
 *
 * 使用：
 *   import { initDeckGL3D } from './deckgl3d.js';
 *   initDeckGL3D(map, { coordTransform });   // map 是 Leaflet map 实例
 */

import { Deck, MapView } from '@deck.gl/core';
import { ColumnLayer, GeoJsonLayer } from '@deck.gl/layers';

// ============== 模拟数据：上海各热门商圈的"POI 密度"统计 ==============
// 每条数据: [lng_wgs84, lat_wgs84, 数值（POI数量/客流/营业额等）]
// 经纬度是 WGS-84，渲染前会用 coordTransform 转成 GCJ-02 以对齐高德瓦片
const SHANGHAI_HOTSPOTS = [
    { name: '陆家嘴',     lng: 121.4998, lat: 31.2397, value: 980 },
    { name: '人民广场',   lng: 121.4737, lat: 31.2304, value: 920 },
    { name: '南京东路',   lng: 121.4810, lat: 31.2350, value: 870 },
    { name: '徐家汇',     lng: 121.4378, lat: 31.1944, value: 760 },
    { name: '静安寺',     lng: 121.4458, lat: 31.2238, value: 720 },
    { name: '中山公园',   lng: 121.4197, lat: 31.2204, value: 480 },
    { name: '五角场',     lng: 121.5147, lat: 31.2980, value: 660 },
    { name: '世纪大道',   lng: 121.5210, lat: 31.2310, value: 690 },
    { name: '虹桥',       lng: 121.3640, lat: 31.1976, value: 540 },
    { name: '七宝',       lng: 121.3540, lat: 31.1640, value: 380 },
    { name: '莘庄',       lng: 121.3801, lat: 31.1124, value: 420 },
    { name: '新天地',     lng: 121.4760, lat: 31.2200, value: 750 },
    { name: '田子坊',     lng: 121.4670, lat: 31.2110, value: 560 },
    { name: '外滩',       lng: 121.4900, lat: 31.2400, value: 880 },
    { name: '豫园',       lng: 121.4920, lat: 31.2270, value: 700 },
    { name: '世博园',     lng: 121.4870, lat: 31.1880, value: 510 },
    { name: '迪士尼',     lng: 121.6700, lat: 31.1450, value: 830 },
    { name: '虹桥火车站', lng: 121.3210, lat: 31.1940, value: 640 },
    { name: '上海火车站', lng: 121.4540, lat: 31.2510, value: 580 },
    { name: '长寿路',     lng: 121.4380, lat: 31.2470, value: 410 },
    { name: '大宁',       lng: 121.4500, lat: 31.2780, value: 460 },
    { name: '中山公园北', lng: 121.4150, lat: 31.2280, value: 350 },
    { name: '虹口足球场', lng: 121.4790, lat: 31.2730, value: 390 },
    { name: '杨浦大桥',   lng: 121.5350, lat: 31.2730, value: 310 },
    { name: '金桥',       lng: 121.5910, lat: 31.2540, value: 460 },
    { name: '张江',       lng: 121.5950, lat: 31.2050, value: 540 },
];

/**
 * 初始化 deck.gl 3D 立柱图模块
 * @param {L.Map} map  Leaflet map 实例
 * @param {Object} opts
 * @param {Object} [opts.coordTransform] 含 wgs84ToGcj02(lng, lat) -> [lng, lat]
 * @param {Array}  [opts.data] 自定义数据，结构同 SHANGHAI_HOTSPOTS
 */
export function initDeckGL3D(map, opts = {}) {
    if (!map) {
        console.warn('[DeckGL3D] map 实例不存在，跳过');
        return;
    }
    const L = window.L;
    if (!L) {
        console.warn('[DeckGL3D] 未检测到 window.L，跳过');
        return;
    }

    const coordTransform = opts.coordTransform || null;
    const rawData = Array.isArray(opts.data) && opts.data.length ? opts.data : SHANGHAI_HOTSPOTS;

    // 把 WGS-84 数据转成 GCJ-02（与高德瓦片对齐）
    const data = rawData.map(d => {
        let lng = d.lng, lat = d.lat;
        if (coordTransform && typeof coordTransform.wgs84ToGcj02 === 'function') {
            try {
                const arr = coordTransform.wgs84ToGcj02(d.lng, d.lat);
                if (Array.isArray(arr) && arr.length >= 2) {
                    lng = arr[0]; lat = arr[1];
                }
            } catch (_) {}
        }
        return { ...d, lng, lat };
    });

    // ============== 状态 ==============
    const state = {
        enabled: false,
        deck: null,
        canvas: null,
        // 视角参数（pitch 让画面倏斜，bearing 让画面旋转）
        pitch: 50,    // 0=仰视，60=很斜
        bearing: 0,   // 旋转角度
        elevationScale: 30, // 立柱高度缩放
        // Phase B 新增：图层开关
        showColumns: true,        // 立柱图（默认开）
        showBuildings: false,     // OSM 真 3D 建筑挤出
        // OSM 建筑数据状态
        buildings: null,          // GeoJSON FeatureCollection
        buildingsLoading: false,
        buildingsLastBBox: '',
        floorHeight: 3.5,         // 单层层高（米）—— 总高 = 层数 × floorHeight
    };

    // ============== 注入样式 ==============
    const style = document.createElement('style');
    style.textContent = `
.deckgl-overlay {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    pointer-events: none; /* 不抢 Leaflet 的鼠标事件 */
    z-index: 400; /* 在 tile 层之上、popup 之下 */
}
.deckgl-toggle {
    background: #fff; width: 36px; height: 36px; border-radius: 4px;
    box-shadow: 0 1px 5px rgba(0,0,0,0.4); cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; user-select: none;
}
.deckgl-toggle.active { background: #fff3e0; color: #e65100; }
.deckgl-toggle:hover { background: #f4f4f4; }
.deckgl-panel {
    display: none;
    position: absolute; top: 50px; right: 12px;
    background: #fff; border-radius: 6px; padding: 10px 12px;
    box-shadow: 0 4px 18px rgba(0,0,0,0.18);
    font-size: 12px; min-width: 200px; z-index: 1000;
}
.deckgl-panel.active { display: block; }
.deckgl-panel h4 {
    margin: 0 0 8px 0; font-size: 13px;
    color: #e65100; padding-bottom: 6px;
    border-bottom: 1px solid #eee;
    display: flex; align-items: center; justify-content: space-between;
}
.deckgl-panel .close-btn {
    width: 20px; height: 20px; line-height: 18px; text-align: center;
    border-radius: 50%; cursor: pointer; color: #999;
    font-size: 16px; user-select: none; font-weight: normal;
    transition: all 0.15s;
}
.deckgl-panel .close-btn:hover { background: #ffe0d0; color: #e65100; }
.deckgl-panel .row { padding: 4px 0; display: flex; align-items: center; gap: 6px; }
.deckgl-panel .row label { color: #666; min-width: 56px; font-size: 12px; }
.deckgl-panel .row input[type=range] { flex: 1; }
.deckgl-panel .row .val { color: #333; min-width: 32px; text-align: right; font-size: 12px; }
.deckgl-panel .checkbox-row {
    padding: 4px 0; display: flex; align-items: center; gap: 6px;
    border-top: 1px dashed #eee; margin-top: 6px; padding-top: 8px;
}
.deckgl-panel .checkbox-row label {
    flex: 1; cursor: pointer; color: #333; font-size: 12px;
    display: flex; align-items: center; gap: 4px;
}
.deckgl-panel .checkbox-row input[type=checkbox] { cursor: pointer; }
.deckgl-panel .mini-btn {
    background: #1976d2; color: #fff; border: 0; border-radius: 3px;
    padding: 3px 8px; cursor: pointer; font-size: 11px;
}
.deckgl-panel .mini-btn:hover { background: #1565c0; }
.deckgl-panel .mini-btn:disabled { background: #bbb; cursor: not-allowed; }
.deckgl-panel .status {
    font-size: 11px; color: #888; padding: 2px 0;
}
.deckgl-tooltip {
    position: absolute; pointer-events: none;
    background: rgba(0,0,0,0.78); color: #fff;
    padding: 6px 10px; border-radius: 4px;
    font-size: 12px; line-height: 1.5; z-index: 2000;
    transform: translate(8px, 8px);
}
`;
    document.head.appendChild(style);

    // ============== 创建 deck.gl 用的 canvas ==============
    const mapContainer = map.getContainer();
    const canvas = document.createElement('canvas');
    canvas.className = 'deckgl-overlay';
    canvas.style.display = 'none';
    mapContainer.appendChild(canvas);
    state.canvas = canvas;

    // tooltip
    const tooltipEl = document.createElement('div');
    tooltipEl.className = 'deckgl-tooltip';
    tooltipEl.style.display = 'none';
    mapContainer.appendChild(tooltipEl);

    // ============== Leaflet ↔ deck.gl 视图同步 ==============
    function getViewState() {
        const center = map.getCenter();
        return {
            longitude: center.lng,
            latitude: center.lat,
            zoom: map.getZoom() - 1,  // deck.gl 与 Leaflet 的 zoom 差 1（投影约定）
            pitch: state.pitch,
            bearing: state.bearing,
        };
    }

    function resizeCanvas() {
        const size = map.getSize();
        canvas.width = size.x;
        canvas.height = size.y;
        canvas.style.width = size.x + 'px';
        canvas.style.height = size.y + 'px';
    }

    // ============== Phase B：OSM 真 3D 建筑挤出 ==============

    // 当前视野 bbox 字符串，Overpass 需要 south,west,north,east
    function getBBoxStr() {
        const b = map.getBounds();
        return `${b.getSouth().toFixed(5)},${b.getWest().toFixed(5)},${b.getNorth().toFixed(5)},${b.getEast().toFixed(5)}`;
    }

    // 从 OSM Overpass API 拉取当前视野内的建筑轮廓，转成 GeoJSON
    async function fetchOSMBuildings() {
        const zoom = map.getZoom();
        if (zoom < 15) {
            updateStatus(`🏙 缩放至 ≥15 级才会加载建筑（当前 ${zoom}）`);
            return;
        }
        const bbox = getBBoxStr();
        if (state.buildingsLoading || bbox === state.buildingsLastBBox) return;
        state.buildingsLoading = true;
        updateStatus('🔄 从 OpenStreetMap 加载建筑中...');

        const query = `[out:json][timeout:25];(way["building"](${bbox}););out body geom;`;
        const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query);

        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('Overpass HTTP ' + resp.status);
            const json = await resp.json();
            // 转成 GeoJSON FeatureCollection
            const features = (json.elements || [])
                .filter(el => el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 3)
                .map(el => {
                    // OSM 坐标是 WGS-84 [lat, lon]，需转 GCJ-02 并输出 GeoJSON 顺序 [lng, lat]
                    const ring = el.geometry.map(p => {
                        let lng = p.lon, lat = p.lat;
                        if (coordTransform && typeof coordTransform.wgs84ToGcj02 === 'function') {
                            try {
                                const arr = coordTransform.wgs84ToGcj02(p.lon, p.lat);
                                if (Array.isArray(arr) && arr.length >= 2) {
                                    lng = arr[0]; lat = arr[1];
                                }
                            } catch (_) {}
                        }
                        return [lng, lat];
                    });
                    // 闭合环
                    const first = ring[0], last = ring[ring.length - 1];
                    if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);

                    // 高度推断：building:levels 优先，其次 height 标签，否则随机 3~7 层
                    const tags = el.tags || {};
                    let levels = parseInt(tags['building:levels'] || tags.levels, 10);
                    if (!levels || levels < 1) levels = 3 + Math.floor(Math.random() * 5);
                    const heightTag = parseFloat(tags.height);
                    const height = (!isNaN(heightTag) && heightTag > 0) ? heightTag : (levels * state.floorHeight);

                    return {
                        type: 'Feature',
                        geometry: { type: 'Polygon', coordinates: [ring] },
                        properties: {
                            id: el.id,
                            name: tags.name || tags['name:zh'] || '',
                            levels,
                            height,
                            type: tags.building || 'yes',
                        },
                    };
                });
            state.buildings = { type: 'FeatureCollection', features };
            state.buildingsLastBBox = bbox;
            updateStatus(`✅ 已加载 ${features.length} 栋建筑`);
        } catch (err) {
            console.warn('[DeckGL3D] Overpass 加载失败:', err);
            updateStatus('⚠️ 加载失败：' + (err.message || 'unknown'));
        } finally {
            state.buildingsLoading = false;
            if (state.enabled) updateDeck();
        }
    }

    function updateStatus(msg) {
        const el = panel && panel.querySelector('[data-status]');
        if (el) el.textContent = msg;
    }

    function buildBuildingsLayer() {
        if (!state.buildings) return null;
        return new GeoJsonLayer({
            id: 'osm-buildings',
            data: state.buildings,
            extruded: true,
            wireframe: false,
            pickable: true,
            getElevation: f => f.properties.height || 12,
            getFillColor: f => {
                // 高度 -> 颜色：低=深青，中=荷果绿，高=黄金
                const h = f.properties.height || 12;
                const t = Math.min(1, h / 80);
                const r = Math.round(60 + 195 * t);
                const g = Math.round(110 + 90 * t);
                const b = Math.round(180 - 130 * t);
                return [r, g, b, 230];
            },
            getLineColor: [40, 60, 90, 160],
            lineWidthMinPixels: 0.5,
            material: {
                ambient: 0.3,
                diffuse: 0.7,
                shininess: 16,
                specularColor: [50, 50, 50],
            },
            onHover: ({ object, x, y }) => {
                if (object && object.properties) {
                    const p = object.properties;
                    tooltipEl.style.display = 'block';
                    tooltipEl.style.left = x + 'px';
                    tooltipEl.style.top = y + 'px';
                    const nm = p.name ? `<b>${p.name}</b><br>` : '';
                    tooltipEl.innerHTML = `${nm}层数：${p.levels}<br>高度：${Number(p.height).toFixed(1)} m<br>类型：${p.type}`;
                } else if (!state.deck || !state.deck.pickObject) {
                    tooltipEl.style.display = 'none';
                }
            },
        });
    }

    function buildColumnLayer() {
        return new ColumnLayer({
            id: 'shanghai-hotspots',
            data,
            diskResolution: 24,         // 立柱细分（越大越圆）
            radius: 220,                // 单位：米
            extruded: true,
            pickable: true,
            elevationScale: state.elevationScale,
            getPosition: d => [d.lng, d.lat],
            getFillColor: d => {
                // 颜色按值由黄→红渐变
                const t = Math.min(1, d.value / 1000);
                const r = 255;
                const g = Math.round(220 * (1 - t));
                const b = Math.round(60 * (1 - t));
                return [r, g, b, 220];
            },
            getElevation: d => d.value,
            material: {
                ambient: 0.4,
                diffuse: 0.6,
                shininess: 32,
                specularColor: [60, 60, 60],
            },
            onHover: ({ object, x, y }) => {
                if (object) {
                    tooltipEl.style.display = 'block';
                    tooltipEl.style.left = x + 'px';
                    tooltipEl.style.top = y + 'px';
                    tooltipEl.innerHTML = `<b>${object.name}</b><br>POI 数：${object.value}`;
                } else {
                    tooltipEl.style.display = 'none';
                }
            },
        });
    }

    // 收集当前启用的所有图层
    function buildLayers() {
        const layers = [];
        if (state.showColumns) layers.push(buildColumnLayer());
        if (state.showBuildings) {
            const blayer = buildBuildingsLayer();
            if (blayer) layers.push(blayer);
        }
        return layers;
    }

    function createDeck() {
        if (state.deck) return;
        resizeCanvas();
        state.deck = new Deck({
            canvas,
            views: [new MapView({ repeat: true })],
            initialViewState: getViewState(),
            controller: false, // 由 Leaflet 控制平移缩放
            useDevicePixels: true,
            layers: buildLayers(),
        });
    }

    function updateDeck() {
        if (!state.deck) return;
        state.deck.setProps({
            viewState: getViewState(),
            layers: buildLayers(),
        });
    }

    function destroyDeck() {
        if (state.deck) {
            try { state.deck.finalize(); } catch (_) {}
            state.deck = null;
        }
        tooltipEl.style.display = 'none';
    }

    // 监听 Leaflet 视图变化
    map.on('move zoom viewreset moveend zoomend', () => {
        if (state.enabled) updateDeck();
    });
    // 缩放停止 / 平移停止后如果开了建筑层且缩放足够，重新拉取该区域建筑
    map.on('moveend zoomend', () => {
        if (state.enabled && state.showBuildings) {
            fetchOSMBuildings();
        }
    });
    map.on('resize', () => {
        if (state.enabled) {
            resizeCanvas();
            updateDeck();
        }
    });

    // ============== 控件：右上角开关按钮 + 设置面板 ==============
    const DeckToggle = L.Control.extend({
        options: { position: 'topright' },
        onAdd() {
            const wrap = L.DomUtil.create('div', 'leaflet-bar');
            const btn = L.DomUtil.create('a', 'deckgl-toggle', wrap);
            btn.href = '#';
            btn.title = '3D 立柱图（deck.gl）';
            btn.innerHTML = '🏗';
            L.DomEvent.disableClickPropagation(wrap);
            L.DomEvent.disableScrollPropagation(wrap);
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                toggle();
                btn.classList.toggle('active', state.enabled);
                panel.classList.toggle('active', state.enabled);
            });
            return wrap;
        },
    });
    new DeckToggle().addTo(map);

    // 设置面板（pitch / bearing / 高度）
    const panel = L.DomUtil.create('div', 'deckgl-panel', mapContainer);
    panel.innerHTML = `
        <h4>
            <span>🏗 3D 可视化</span>
            <span class="close-btn" title="收起面板">×</span>
        </h4>
        <div class="row">
            <label>倏斜</label>
            <input type="range" data-k="pitch" min="0" max="60" value="${state.pitch}">
            <span class="val" data-v="pitch">${state.pitch}°</span>
        </div>
        <div class="row">
            <label>旋转</label>
            <input type="range" data-k="bearing" min="-180" max="180" value="${state.bearing}">
            <span class="val" data-v="bearing">${state.bearing}°</span>
        </div>
        <div class="row">
            <label>柱高</label>
            <input type="range" data-k="elevationScale" min="1" max="100" value="${state.elevationScale}">
            <span class="val" data-v="elevationScale">${state.elevationScale}×</span>
        </div>

        <div class="checkbox-row">
            <label><input type="checkbox" data-toggle="showColumns" ${state.showColumns ? 'checked' : ''}> 📊 商圈立柱图</label>
        </div>
        <div class="checkbox-row" style="border-top:none; margin-top:0; padding-top:4px;">
            <label><input type="checkbox" data-toggle="showBuildings" ${state.showBuildings ? 'checked' : ''}> 🏙 OSM 真 3D 建筑</label>
            <button class="mini-btn" data-act="refresh-buildings" title="重新拉取当前视野建筑">↻</button>
        </div>
        <div class="row" style="padding-left: 18px;">
            <label style="min-width: 48px;">层高</label>
            <input type="range" data-k="floorHeight" min="2" max="6" step="0.5" value="${state.floorHeight}">
            <span class="val" data-v="floorHeight">${state.floorHeight}m</span>
        </div>
        <div class="status" data-status>提示：缩放至 ≥15 级后勾选"OSM 真 3D 建筑"</div>

        <div style="margin-top:6px; color:#999; font-size:11px;">
            数据：商圈 26 个热点 + OSM 实时建筑轮廓<br>
            Tip：拖动地图后点 ↻ 刷新建筑
        </div>
    `;
    L.DomEvent.disableClickPropagation(panel);
    L.DomEvent.disableScrollPropagation(panel);

    // 关闭按钮：只收起面板，不关闭 3D 立柱（需要关闭立柱请点右上角🏗按钮）
    const closeBtn = panel.querySelector('.close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.remove('active');
        });
    }
    panel.querySelectorAll('input[type=range]').forEach(input => {
        input.addEventListener('input', () => {
            const k = input.getAttribute('data-k');
            const v = Number(input.value);
            state[k] = v;
            const valEl = panel.querySelector(`[data-v="${k}"]`);
            if (valEl) {
                if (k === 'elevationScale') valEl.textContent = v + '×';
                else if (k === 'floorHeight') valEl.textContent = v + 'm';
                else valEl.textContent = v + '°';
            }
            if (state.enabled) updateDeck();
        });
    });

    // checkbox 切换图层
    panel.querySelectorAll('input[type=checkbox][data-toggle]').forEach(input => {
        input.addEventListener('change', () => {
            const k = input.getAttribute('data-toggle');
            state[k] = input.checked;
            // 如果是刚勾选建筑且还没拉过数据，立即请求一次
            if (k === 'showBuildings' && input.checked && !state.buildings && state.enabled) {
                fetchOSMBuildings();
            }
            if (state.enabled) updateDeck();
        });
    });

    // “刷新建筑”按钮
    const refreshBtn = panel.querySelector('[data-act="refresh-buildings"]');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.buildingsLastBBox = ''; // 强制刷新
            fetchOSMBuildings();
        });
    }

    // ============== 切换 ==============
    function toggle(force) {
        const next = (typeof force === 'boolean') ? force : !state.enabled;
        state.enabled = next;
        if (next) {
            canvas.style.display = 'block';
            createDeck();
            updateDeck();
            // 开启后如果建筑开关是勾上的且没数据，拉一次
            if (state.showBuildings && !state.buildings) {
                fetchOSMBuildings();
            }
            console.log('%c[DeckGL3D] 🏗 3D 可视化已开启',
                'color:#fff;background:#e65100;padding:2px 6px;border-radius:3px;font-weight:bold');
        } else {
            canvas.style.display = 'none';
            destroyDeck();
        }
    }

    // 暴露调试入口
    window.__deckgl3d = { state, toggle, updateDeck, data, fetchOSMBuildings };
    console.log('%c[DeckGL3D] 模块已加载（点击右上角 🏗 开启）',
        'color:#fff;background:#e65100;padding:2px 6px;border-radius:3px');
}
