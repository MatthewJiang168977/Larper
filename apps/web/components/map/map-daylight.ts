const MINUTE_MS = 60_000;
const RADIANS = Math.PI / 180;
const NYC_LATITUDE = 40.7128 * RADIANS;
const NYC_LONGITUDE = -74.006;
// The sun's apparent upper edge at the horizon, accounting for refraction.
const SUNRISE_ZENITH = 90.833 * RADIANS;
const nycCalendar = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

// NOAA's solar calculator equations, based on Jean Meeus's Astronomical Algorithms.
// https://gml.noaa.gov/grad/solcalc/calcdetails.html
function solarPosition(utcMs: number) {
  const daysSinceJ2000 = utcMs / 86_400_000 - 10_957.5;
  const centuries = daysSinceJ2000 / 36_525;
  const meanLongitude = (280.46646 + centuries * (36_000.76983 + centuries * 0.0003032)) % 360;
  const meanAnomaly = (357.52911 + centuries * (35_999.05029 - 0.0001537 * centuries)) * RADIANS;
  const eccentricity = 0.016708634 - centuries * (0.000042037 + 0.0000001267 * centuries);
  const center = Math.sin(meanAnomaly) * (1.914602 - centuries * (0.004817 + 0.000014 * centuries))
    + Math.sin(2 * meanAnomaly) * (0.019993 - 0.000101 * centuries)
    + Math.sin(3 * meanAnomaly) * 0.000289;
  const omega = (125.04 - 1934.136 * centuries) * RADIANS;
  const apparentLongitude = (meanLongitude + center - 0.00569 - 0.00478 * Math.sin(omega)) * RADIANS;
  const meanObliquity = 23 + (26 + (21.448 - centuries * (46.815 + centuries * (0.00059 - 0.001813 * centuries))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * RADIANS;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));

  const y = Math.tan(obliquity / 2) ** 2;
  const longitude = meanLongitude * RADIANS;
  const equationOfTime = 4 / RADIANS * (
    y * Math.sin(2 * longitude) - 2 * eccentricity * Math.sin(meanAnomaly)
    + 4 * eccentricity * y * Math.sin(meanAnomaly) * Math.cos(2 * longitude)
    - 0.5 * y ** 2 * Math.sin(4 * longitude) - 1.25 * eccentricity ** 2 * Math.sin(2 * meanAnomaly)
  );
  return { declination, equationOfTime };
}

function horizonMinute(utcMs: number, event: "sunrise" | "sunset") {
  const { declination, equationOfTime } = solarPosition(utcMs);
  const hourAngle = Math.acos(
    (Math.cos(SUNRISE_ZENITH) - Math.sin(NYC_LATITUDE) * Math.sin(declination))
    / (Math.cos(NYC_LATITUDE) * Math.cos(declination)),
  ) / RADIANS;
  const longitude = NYC_LONGITUDE + (event === "sunrise" ? hourAngle : -hourAngle);
  return 720 - 4 * longitude - equationOfTime;
}

export function mapStyleAtTime(now: Date): "day" | "night" {
  const parts = nycCalendar.formatToParts(now);
  const calendarNumber = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value);
  // Use the NYC calendar date but calculate the event instants in UTC. No offset
  // arithmetic is needed, even on DST days or when sunset falls after UTC midnight.
  const utcMidnight = Date.UTC(calendarNumber("year"), calendarNumber("month") - 1, calendarNumber("day"));
  const boundary = (event: "sunrise" | "sunset") => {
    const estimate = horizonMinute(utcMidnight + 720 * MINUTE_MS, event);
    return utcMidnight + Math.round(horizonMinute(utcMidnight + estimate * MINUTE_MS, event)) * MINUTE_MS;
  };
  const instant = now.getTime();
  return instant >= boundary("sunrise") && instant < boundary("sunset") ? "day" : "night";
}
