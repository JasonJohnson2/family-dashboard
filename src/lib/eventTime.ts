import { timeZoneFormatter } from './timeZones';
export function wallInstant(date: string, time: string, zone: string): string | undefined {
  const guessed = Date.parse(date + 'T' + time + ':00Z'),
    formatter = timeZoneFormatter(zone);
  const local = (value: number) => {
    const p = Object.fromEntries(
      formatter.formatToParts(new Date(value)).map((p) => [p.type, p.value]),
    );
    return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
  };
  const offsets = new Set(
    [-2, 2].map((n) => {
      const probe = guessed + n * 86400000;
      return Date.parse(local(probe) + ':00Z') - probe;
    }),
  );
  const matches = [...offsets]
    .map((offset) => guessed - offset)
    .filter((v) => local(v) === date + 'T' + time)
    .sort((a, b) => a - b);
  return matches.length ? new Date(matches[0]).toISOString() : undefined; // First instant in an autumn fold.
}
