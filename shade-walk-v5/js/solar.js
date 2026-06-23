/**
 * solar.js — approximate solar position, for the sun-arc gauge in the UI.
 *
 * This is a low-precision formula (good to roughly ±0.3°), accurate enough
 * for a visual "where is the sun right now" indicator. It is NOT used for
 * the actual shadow rendering — that's handled internally by the ShadeMap
 * library from the date/time + location you give it. This is a second,
 * independent estimate purely for the little sky gauge.
 */

const Solar = {
  /** Returns { elevation, azimuth } in degrees for a given Date + lat/lon. */
  getPosition(date, latDeg, lonDeg) {
    const rad = Math.PI / 180;
    const julianDay = date.getTime() / 86400000 + 2440587.5;
    const d = julianDay - 2451545.0; // days since J2000.0

    const g = (357.529 + 0.98560028 * d) % 360;
    const q = (280.459 + 0.98564736 * d) % 360;
    const L = (q + 1.915 * Math.sin(g * rad) + 0.02 * Math.sin(2 * g * rad)) % 360;
    const e = 23.439 - 0.00000036 * d;

    const sinL = Math.sin(L * rad);
    const cosL = Math.cos(L * rad);
    const sinE = Math.sin(e * rad);
    const cosE = Math.cos(e * rad);

    const RA = Math.atan2(cosE * sinL, cosL) / rad;
    const decl = Math.asin(sinE * sinL) / rad;

    let GMST = (280.46061837 + 360.98564736629 * d) % 360;
    if (GMST < 0) GMST += 360;

    let HA = ((GMST + lonDeg - RA + 180) % 360 + 360) % 360 - 180;

    const latRad = latDeg * rad;
    const declRad = decl * rad;
    const haRad = HA * rad;

    const sinElev =
      Math.sin(latRad) * Math.sin(declRad) +
      Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad);
    const elevation = Math.asin(clampUnit(sinElev)) / rad;

    const cosAz =
      (Math.sin(declRad) - Math.sin(latRad) * sinElev) /
      (Math.cos(latRad) * Math.cos(Math.asin(clampUnit(sinElev))) || 1e-9);
    let azimuth = Math.acos(clampUnit(cosAz)) / rad;
    if (Math.sin(haRad) > 0) azimuth = 360 - azimuth;

    return { elevation, azimuth, hourAngle: HA, declination: decl };
  },

  /** Half-day length in degrees of hour angle (sunrise at -h0, sunset at +h0). */
  getHalfDayHourAngle(date, latDeg, lonDeg) {
    const { declination } = this.getPosition(date, latDeg, lonDeg);
    const rad = Math.PI / 180;
    const latRad = latDeg * rad;
    const declRad = declination * rad;
    const cosH0 =
      (Math.sin(-0.833 * rad) - Math.sin(latRad) * Math.sin(declRad)) /
      (Math.cos(latRad) * Math.cos(declRad));
    if (cosH0 >= 1) return 0; // sun never rises
    if (cosH0 <= -1) return 180; // sun never sets
    return Math.acos(cosH0) / rad;
  },

  /** 0 = sunrise, 1 = sunset, clamped — useful for placing a marker on an arc. */
  getDayProgress(date, latDeg, lonDeg) {
    const { hourAngle } = this.getPosition(date, latDeg, lonDeg);
    const h0 = this.getHalfDayHourAngle(date, latDeg, lonDeg);
    if (h0 === 0) return hourAngle < 0 ? 0 : 1;
    return clampUnit01((hourAngle + h0) / (2 * h0));
  },
};

function clampUnit(v) {
  return Math.min(1, Math.max(-1, v));
}
function clampUnit01(v) {
  return Math.min(1, Math.max(0, v));
}
