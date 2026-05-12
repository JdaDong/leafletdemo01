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
        // 给本项目分配专属端口，避免与机器上其它 Vite 项目（默认也是 5173）抢端口
        port: 5180,
        // 端口被占用时直接报错，而不是悄悄换到 5181/5182…，防止打开浏览器看到的不是本项目
        strictPort: true,
        // 强制走 IPv4，规避 macOS 下 localhost 优先解析 IPv6 (::1)
        // 导致两个 Vite 同时监听 5173（一个 IPv6 一个 IPv4）的诡异问题
        host: '127.0.0.1',
        open: true,
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
