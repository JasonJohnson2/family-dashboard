// Repeated Intl construction is costly during imports and household validation.
// Retain only a few successful formatters per browser/Worker isolate, never events.
const formatters = new Map<string, Intl.DateTimeFormat>();
const MAX_FORMATTERS = 8;
export function timeZoneFormatter(timeZone: string) {
  const saved = formatters.get(timeZone);
  if (saved) return saved;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  if (formatters.size >= MAX_FORMATTERS) formatters.delete(formatters.keys().next().value!);
  formatters.set(timeZone, formatter);
  return formatter;
}
export function isValidTimeZone(timeZone: string) {
  try {
    timeZoneFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}
