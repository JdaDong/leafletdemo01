/**
 * 搜索历史 / 收藏 —— localStorage 持久化
 *
 * 条目结构：{ keyword, mode, city, types, ts }
 */
import { POI_HISTORY_KEY, POI_FAV_KEY, POI_HISTORY_LIMIT } from '../config.js';

// ========== 历史 ==========
export function loadHistory() {
    try {
        const raw = localStorage.getItem(POI_HISTORY_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
}

export function saveHistory(list) {
    try {
        localStorage.setItem(POI_HISTORY_KEY, JSON.stringify(list.slice(0, POI_HISTORY_LIMIT)));
    } catch (e) {
        console.warn('保存搜索历史失败:', e);
    }
}

export function addSearchHistory(keyword, meta = {}) {
    if (!keyword) return;
    const list = loadHistory();
    // 去重：同名（忽略大小写）提到最前
    const lower = keyword.toLowerCase();
    const idx = list.findIndex(item => item && (item.keyword || '').toLowerCase() === lower);
    if (idx >= 0) list.splice(idx, 1);
    list.unshift({
        keyword,
        mode: meta.mode || 'nearby',
        city: meta.city || '',
        types: meta.types || '',
        ts: Date.now(),
    });
    saveHistory(list);
}

export function clearHistory() {
    saveHistory([]);
}

// ========== 收藏 ==========
export function loadFavorites() {
    try {
        const raw = localStorage.getItem(POI_FAV_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
}

export function saveFavorites(list) {
    try {
        localStorage.setItem(POI_FAV_KEY, JSON.stringify(list));
    } catch (e) {
        console.warn('保存收藏失败:', e);
    }
}

export function isFavorite(keyword) {
    const favs = loadFavorites();
    const lower = (keyword || '').toLowerCase();
    return favs.some(f => (f.keyword || '').toLowerCase() === lower);
}

export function toggleFavorite(keyword, meta = {}) {
    if (!keyword) return;
    const favs = loadFavorites();
    const lower = keyword.toLowerCase();
    const idx = favs.findIndex(f => (f.keyword || '').toLowerCase() === lower);
    if (idx >= 0) {
        favs.splice(idx, 1);
    } else {
        favs.unshift({
            keyword,
            mode: meta.mode || 'nearby',
            city: meta.city || '',
            types: meta.types || '',
            ts: Date.now(),
        });
    }
    saveFavorites(favs);
}
