/**
 * DOM / 文本小工具
 */

/**
 * HTML 特殊字符转义，防止 POI 字段/用户输入导致布局异常或 XSS
 */
export function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
