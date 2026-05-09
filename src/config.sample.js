/**
 * 本地配置示例文件（可提交到仓库，用作模板）
 *
 * 使用方法：
 *   1. 将本文件复制为 src/config.local.js
 *   2. 把下面的 AMAP_WEB_KEY 替换为你自己的高德 Web 服务 Key
 *   3. src/config.local.js 已在 .gitignore 中被忽略，不会被提交
 *
 * 申请地址：https://console.amap.com/dev/key/app
 * （服务平台请选择 "Web服务"）
 */
(function () {
    window.__APP_CONFIG__ = Object.assign({}, window.__APP_CONFIG__, {
        AMAP_WEB_KEY: 'YOUR_AMAP_WEB_KEY_HERE'
    });
})();
