import { minutes } from '../scheduling/time.js';

/** Format an HH:mm wall time already expressed in the clinic's configured timezone.
 * Do not convert it via the host timezone or treat it as a UTC timestamp.
 */
export function formatClinicTime(time: string): string {
  const value = minutes(time);
  const hour = Math.floor(value / 60);
  return `${hour % 12 || 12}:${String(value % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export function formatClinicTimeRange(start: string, end: string): string {
  return `${formatClinicTime(start)}–${formatClinicTime(end)}`;
}
