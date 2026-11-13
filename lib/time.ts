// Display time zone for every human-readable time: US Eastern (EST/EDT, DST-aware).
// Internal logic stays on UTC epoch milliseconds; 15m windows are identical in both zones.
export const ET = "America/New_York";
const parts = (v: number, opts: Intl.DateTimeFormatOptions) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ET,
      hourCycle: "h23",
      ...opts,
    })
      .formatToParts(new Date(v))
      .map((p) => [p.type, p.value]),
  );
// "14:05:09"
export const etTime = (v: number, seconds = true) => {
  const p = parts(v, {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
  return seconds
    ? `${p.hour}:${p.minute}:${p.second}`
    : `${p.hour}:${p.minute}`;
};
// "2026-11-13" — the ET calendar day, used for daily P&L and loss limits.
export const etDay = (v: number) => {
  const p = parts(v, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
};
// "2026-11-13 14:05:09"
export const etDateTime = (v: number) => `${etDay(v)} ${etTime(v)}`;
// "EST" or "EDT"
export const etZone = (v: number) =>
  parts(v, { timeZoneName: "short" }).timeZoneName ?? "ET";
// Machine-readable ET with its offset, e.g. "2026-11-13T09:05:09-05:00" (exports).
export const etIso = (v: number) => {
  const local = Date.UTC(
      ...(() => {
        const p = parts(v, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        return [
          Number(p.year),
          Number(p.month) - 1,
          Number(p.day),
          Number(p.hour),
          Number(p.minute),
          Number(p.second),
        ] as const;
      })(),
    ),
    offset = Math.round((local - Math.floor(v / 1000) * 1000) / 60000),
    sign = offset < 0 ? "-" : "+",
    abs = Math.abs(offset);
  return `${etDay(v)}T${etTime(v)}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
};
