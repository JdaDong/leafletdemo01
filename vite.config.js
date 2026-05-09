/**
 * Vite 配置
 *
 * 环境变量说明：
 *   - 所有 VITE_ 开头的变量都会被自动暴露到 import.meta.env
 *   - 在项目根目录创建 .env.local 文件即可配置本地变量（已 gitignore）
 *
 * 示例 .env.local:
 *   VITE_AMAP_WEB_KEY=你的高德Key
 */
import { defineConfig } from 'vite';

export default defineConfig({
    // 根目录（默认当前目录即可）
    root: '.',
    // 静态资源目录
    publicDir: 'public',
    server: {
        port: 5173,
        open: true,
        host: true, // 允许局域网访问
    },
    build: {
        outDir: 'dist',
        sourcemap: true,
        target: 'es2018',
        // 对 leaflet 等大依赖做分包，减小主 chunk
        rollupOptions: {
            output: {
                manualChunks: {
                    leaflet: ['leaflet'],
                    'leaflet-plugins': ['leaflet.markercluster', 'leaflet-fullscreen', 'leaflet.heat', 'leaflet-ant-path', 'leaflet-timedimension'],
                    'leaflet-geoman': ['@geoman-io/leaflet-geoman-free'],
                    turf: ['@turf/turf'],
                },
            },
        },
    },
    // VITE_ 前缀的环境变量会被注入到 import.meta.env
    envPrefix: 'VITE_',
});
