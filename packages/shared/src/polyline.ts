/**
 * Google Encoded Polyline Algorithm。
 * Valhalla は既定で precision 6 (polyline6)、OSRM は 5 を使う。
 */

export function decodePolyline(encoded: string, precision = 6): [number, number][] {
  const factor = 10 ** precision;
  const coordinates: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    // [lng, lat] の順（GeoJSON 準拠）
    coordinates.push([lng / factor, lat / factor]);
  }
  return coordinates;
}

export function encodePolyline(coordinates: [number, number][], precision = 6): string {
  const factor = 10 ** precision;
  let output = '';
  let prevLat = 0;
  let prevLng = 0;

  const encodeValue = (value: number): string => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let out = '';
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
    return out;
  };

  for (const [lng, lat] of coordinates) {
    const latE = Math.round(lat * factor);
    const lngE = Math.round(lng * factor);
    output += encodeValue(latE - prevLat);
    output += encodeValue(lngE - prevLng);
    prevLat = latE;
    prevLng = lngE;
  }
  return output;
}
