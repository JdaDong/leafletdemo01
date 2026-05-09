/**
 * 应用配置 / 常量
 *
 * AMAP_WEB_KEY 读取优先级（从高到低）：
 *   1) import.meta.env.VITE_AMAP_WEB_KEY      —— Vite 环境变量（推荐，写在 .env.local，已 gitignore）
 *   2) window.__APP_CONFIG__.AMAP_WEB_KEY     —— 运行时脚本注入（旧方案，兼容用）
 *   3) localStorage.getItem('AMAP_WEB_KEY')   —— 浏览器临时配置（DevTools 一条命令）
 *   4) 占位符 'YOUR_AMAP_WEB_KEY_HERE'        —— 未配置时走友好提示
 *
 * DevTools 一条命令临时配置：
 *   localStorage.setItem('AMAP_WEB_KEY', '你的Key'); location.reload();
 */

const PLACEHOLDER = 'YOUR_AMAP_WEB_KEY_HERE';

function pick(val) {
    if (!val) return '';
    const s = String(val).trim();
    if (!s || s === PLACEHOLDER) return '';
    return s;
}

function resolveAmapWebKey() {
    // 1) Vite 环境变量
    try {
        // import.meta.env 在 Vite 下一定存在
        const envVal = pick(import.meta.env?.VITE_AMAP_WEB_KEY);
        if (envVal) return envVal;
    } catch (_) { /* ignore */ }

    // 2) window.__APP_CONFIG__（旧 config.local.js 方案，兼容）
    try {
        const fromWindow = (typeof window !== 'undefined')
            && window.__APP_CONFIG__
            && window.__APP_CONFIG__.AMAP_WEB_KEY;
        const val = pick(fromWindow);
        if (val) return val;
    } catch (_) { /* ignore */ }

    // 3) localStorage 临时配置
    try {
        const fromLocal = (typeof localStorage !== 'undefined')
            && localStorage.getItem('AMAP_WEB_KEY');
        const val = pick(fromLocal);
        if (val) return val;
    } catch (_) { /* ignore */ }

    return PLACEHOLDER;
}

export const AMAP_WEB_KEY = resolveAmapWebKey();
export const IS_KEY_CONFIGURED = AMAP_WEB_KEY && AMAP_WEB_KEY !== PLACEHOLDER;

// ======= 地图初始化常量 =======
// 初始中心点（上海 · 人民广场，GCJ-02 坐标）
export const INITIAL_CENTER = [31.230416, 121.473701];
export const INITIAL_ZOOM = 12;

// ======= POI 搜索常量 =======
export const POI_PAGE_SIZE = 20;                // 每页条数（高德 offset 参数，最大 25）
export const POI_HISTORY_LIMIT = 20;            // 本地搜索历史最多保留条数
export const POI_HISTORY_KEY = 'leafletdemo:poi:history';
export const POI_FAV_KEY = 'leafletdemo:poi:favorites';

// ======= 高德瓦片 URL =======
export const AMAP_TILE_URLS = {
    vector:    'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    satellite: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    roadNet:   'https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}',
    traffic:   'https://tm.amap.com/trafficengine/mapabc/traffictile?v=1.0&t=1&x={x}&y={y}&z={z}&t={time}',
};
