/**
 * 坐标系转换：WGS-84 <-> GCJ-02（高德/腾讯火星坐标系）
 *
 * 使用场景：
 *   - navigator.geolocation 返回的是 WGS-84 坐标
 *   - 高德瓦片使用 GCJ-02 坐标
 *   - 所以地图显示定位点前需要先做 wgs84ToGcj02 纠偏
 */

const PI = 3.1415926535897932384626;
const a = 6378245.0;                       // 克拉索夫斯基椭球长半轴
const ee = 0.00669342162296594323;         // 第一偏心率平方

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

/**
 * WGS-84 -> GCJ-02
 * @param {number} lng 经度
 * @param {number} lat 纬度
 * @returns {[number, number]} [lng, lat]
 */
export function wgs84ToGcj02(lng, lat) {
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

// 兼容旧的命名空间式调用：CoordTransform.wgs84ToGcj02(...)
export const CoordTransform = { wgs84ToGcj02 };

export default CoordTransform;
