const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30.4375 * DAY;
const YEAR = 365.25 * DAY;

function es(value: number, digits: number): string {
  return value.toFixed(digits).replace('.', ',');
}

/**
 * Compact interval label for grade buttons: "1 min", "10 min", "3 d", "2,5 mes".
 * Kept short so four buttons fit across a 360px screen.
 */
export function formatInterval(ms: number): string {
  if (ms < MINUTE) return '<1 min';
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  if (ms < MONTH) return `${Math.round(ms / DAY)} d`;
  if (ms < YEAR) return `${es(ms / MONTH, 1)} mes`;
  return `${es(ms / YEAR, 1)} a`;
}

/** Longer form for card details: "3 días", "2,5 meses". */
export function formatIntervalLong(ms: number): string {
  if (ms < MINUTE) return 'menos de un minuto';
  if (ms < HOUR) {
    const n = Math.round(ms / MINUTE);
    return `${n} ${n === 1 ? 'minuto' : 'minutos'}`;
  }
  if (ms < DAY) {
    const n = Math.round(ms / HOUR);
    return `${n} ${n === 1 ? 'hora' : 'horas'}`;
  }
  if (ms < MONTH) {
    const n = Math.round(ms / DAY);
    return `${n} ${n === 1 ? 'día' : 'días'}`;
  }
  if (ms < YEAR) return `${es(ms / MONTH, 1)} meses`;
  return `${es(ms / YEAR, 1)} años`;
}
