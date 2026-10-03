// Civil dates use UTC solely for Gregorian arithmetic, never as event instants.
export const dayNumber = (date: string) => Date.parse(date + 'T12:00:00Z') / 86400000;
export const civilDay = (date: string, amount: number) =>
  new Date((dayNumber(date) + amount) * 86400000).toISOString().slice(0, 10);
export const dayDifference = (a: string, b: string) => Math.round(dayNumber(b) - dayNumber(a));
export const weekday = (date: string) => new Date(date + 'T12:00:00Z').getUTCDay();
export function monthDay(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month, day, 12));
  return value.getUTCMonth() === ((month % 12) + 12) % 12
    ? value.toISOString().slice(0, 10)
    : undefined;
}
