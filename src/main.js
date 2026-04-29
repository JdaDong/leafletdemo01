/**
 * Leaflet + 高德地图 示例
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
 *      如果定位数据来自 WGS-84（GPS），需要做坐标系纠偏。
 */

// 1. 初始化地图（中心点：北京天安门，坐标为 GCJ-02）
const map = L.map('map', {
    center: [39.909187, 116.397451],
    zoom: 12,
    zoomControl: true,
    attributionControl: true
});

// 2. 高德-矢量地图图层
const gaodeNormal = L.tileLayer(
    'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        minZoom: 3,
        attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>'
    }
);

// 3. 高德-卫星影像图层
const gaodeSatellite = L.tileLayer(
    'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        minZoom: 3,
        attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>'
    }
);

// 4. 高德-路网标注图层（可叠加在卫星图上）
const gaodeRoadNet = L.tileLayer(
    'https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}',
    {
        subdomains: ['1', '2', '3', '4'],
        maxZoom: 18,
        minZoom: 3,
        attribution: '&copy; <a href="https://www.amap.com/">高德地图</a>'
    }
);

// 5. 默认加载矢量地图
gaodeNormal.addTo(map);

// 6. 图层控制（右上角切换按钮）
const baseLayers = {
    '高德-矢量': gaodeNormal,
    '高德-卫星': gaodeSatellite
};
const overlayLayers = {
    '路网标注': gaodeRoadNet
};
L.control.layers(baseLayers, overlayLayers, { position: 'topright' }).addTo(map);

// 7. 添加一个示例标记点
const marker = L.marker([39.909187, 116.397451]).addTo(map);
marker.bindPopup('<b>天安门</b><br/>北京市东城区').openPopup();

// 8. 添加比例尺
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

// 9. 点击地图获取坐标（方便调试）
map.on('click', (e) => {
    console.log('点击位置 (GCJ-02):', e.latlng);
    L.popup()
        .setLatLng(e.latlng)
        .setContent(`经度: ${e.latlng.lng.toFixed(6)}<br/>纬度: ${e.latlng.lat.toFixed(6)}`)
        .openOn(map);
});

// ========================================================================
// 10. WGS-84 -> GCJ-02 坐标转换（用于把 GPS 坐标纠偏到高德地图上）
// ========================================================================
const CoordTransform = (() => {
    const PI = 3.1415926535897932384626;
    const a = 6378245.0;            // 克拉索夫斯基椭球长半轴
    const ee = 0.00669342162296594323; // 第一偏心率平方

    // 判断是否在中国境外（境外不需要偏移）
    function outOfChina(lng, lat) {
        return (lng < 72.004 || lng > 137.8347) ||
               (lat < 0.8293 || lat > 55.8271);
    }

    function transformLat(x, y) {
        let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y +
                  0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
        ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
        return ret;
    }

    function transformLng(x, y) {
        let ret = 300.0 + x + 2.0 * y + 0.1 * x * x +
                  0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
        ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
        ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
        ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
        return ret;
    }

    // WGS-84 -> GCJ-02
    function wgs84ToGcj02(lng, lat) {
        if (outOfChina(lng, lat)) return [lng, lat];
        let dLat = transformLat(lng - 105.0, lat - 35.0);
        let dLng = transformLng(lng - 105.0, lat - 35.0);
        const radLat = lat / 180.0 * PI;
        let magic = Math.sin(radLat);
        magic = 1 - ee * magic * magic;
        const sqrtMagic = Math.sqrt(magic);
        dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * PI);
        dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * PI);
        return [lng + dLng, lat + dLat];
    }

    return { wgs84ToGcj02 };
})();

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
// ⚠️ 使用前请申请高德 Web 服务 Key：https://console.amap.com/dev/key/app
//    申请时服务平台选择 "Web服务"，把 Key 填到下方即可。
const AMAP_WEB_KEY = 'YOUR_AMAP_WEB_KEY_HERE';

const poiInput = document.getElementById('poi-input');
const poiBtn = document.getElementById('poi-btn');
const poiListEl = document.getElementById('poi-list');
const poiCategoryEl = document.getElementById('poi-category');
const poiTipsEl = document.getElementById('poi-tips');

// 用于管理 POI 搜索结果的图层组（方便一键清除）
const poiLayerGroup = L.layerGroup().addTo(map);

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

// 执行 POI 搜索
async function searchPOI() {
    const keyword = poiInput.value.trim();
    if (!keyword) {
        alert('请输入搜索关键字');
        return;
    }
    if (!checkKey()) return;

    hidePoiTips(); // 搜索时隐藏联想框
    poiBtn.disabled = true;
    poiBtn.textContent = '搜索中...';
    poiListEl.innerHTML = '<div class="poi-tip">正在搜索...</div>';

    try {
        // 以地图当前中心为搜索中心（GCJ-02）
        const center = map.getCenter();
        // 分类筛选：types 参数（多个用 | 分隔，这里只支持单选）
        const types = poiCategoryEl.value || '';
        const url = `https://restapi.amap.com/v3/place/text` +
                    `?key=${AMAP_WEB_KEY}` +
                    `&keywords=${encodeURIComponent(keyword)}` +
                    (types ? `&types=${types}` : '') +
                    `&city=` +
                    `&offset=20` +
                    `&page=1` +
                    `&extensions=base` +
                    `&location=${center.lng.toFixed(6)},${center.lat.toFixed(6)}`;

        const resp = await fetch(url);
        const data = await resp.json();

        if (data.status !== '1') {
            throw new Error(data.info || '搜索失败');
        }

        renderPOIResults(data.pois || []);
    } catch (err) {
        console.error('POI 搜索失败:', err);
        poiListEl.innerHTML = `<div class="poi-tip" style="color:#E53935;">搜索失败：${err.message}</div>`;
    } finally {
        poiBtn.disabled = false;
        poiBtn.textContent = '搜索';
    }
}

// 渲染 POI 结果（列表 + 地图标记）
function renderPOIResults(pois) {
    // 清除上一次的 POI 标记
    poiLayerGroup.clearLayers();
    poiListEl.innerHTML = '';

    if (pois.length === 0) {
        poiListEl.innerHTML = '<div class="poi-tip">未找到相关地点</div>';
        return;
    }

    const bounds = [];

    pois.forEach((poi, idx) => {
        // 高德返回的 location 格式："lng,lat"（已是 GCJ-02，可直接使用）
        const [lngStr, latStr] = (poi.location || '').split(',');
        const lng = parseFloat(lngStr);
        const lat = parseFloat(latStr);
        if (isNaN(lng) || isNaN(lat)) return;

        const latlng = L.latLng(lat, lng);
        const index = idx + 1;

        // 地图标记
        const marker = L.marker(latlng, { icon: createPoiIcon(index) })
            .bindPopup(
                `<b>${poi.name}</b><br/>` +
                `<span style="color:#888;font-size:12px;">${poi.address || ''}</span><br/>` +
                `<span style="color:#888;font-size:12px;">${poi.tel || ''}</span>`
            );
        poiLayerGroup.addLayer(marker);
        bounds.push(latlng);

        // 列表项
        const item = document.createElement('div');
        item.className = 'poi-item';
        item.innerHTML =
            `<div class="poi-name"><span class="poi-index">${index}</span>${escapeHtml(poi.name)}</div>` +
            `<div class="poi-addr">${escapeHtml(poi.address || poi.pname + poi.cityname + poi.adname || '')}</div>`;

        item.addEventListener('click', () => {
            map.setView(latlng, 17);
            marker.openPopup();
        });

        poiListEl.appendChild(item);
    });

    // 自动缩放到所有结果范围
    if (bounds.length > 0) {
        map.fitBounds(L.latLngBounds(bounds), { padding: [60, 60], maxZoom: 16 });
    }
}

// 简单的 HTML 转义，防止 POI 字段中出现特殊字符导致布局异常
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

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
        return `<div class="poi-tip-item" data-index="${i}">
            <span class="tip-name">${escapeHtml(t.name || '')}</span>
            ${district ? `<span class="tip-district">${escapeHtml(district)}</span>` : ''}
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
        const url = `https://restapi.amap.com/v3/assistant/inputtips` +
                    `?key=${AMAP_WEB_KEY}` +
                    `&keywords=${encodeURIComponent(keyword)}` +
                    (types ? `&type=${types}` : '') +
                    `&location=${center.lng.toFixed(6)},${center.lat.toFixed(6)}` +
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
        return;
    }
    tipsDebounceTimer = setTimeout(() => fetchInputtips(kw), 300);
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
    if (!poiInput.contains(e.target) && !poiTipsEl.contains(e.target)) {
        hidePoiTips();
    }
});

// 分类切换时，如果输入框有内容，立即重新搜索
poiCategoryEl.addEventListener('change', () => {
    if (poiInput.value.trim()) {
        searchPOI();
    }
});