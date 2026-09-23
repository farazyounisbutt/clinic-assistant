/** Normalize supported contact input to international +digits; never infer a patient identity. */
export function normalizeMobileNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(input)) return null;
  let digits = input.replace(/\D/g, '');
  if (!input.startsWith('+') && /^03\d{9}$/.test(digits))
    digits = `92${digits.slice(1)}`;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  // Pakistani mobile numbers contain 92 followed by a ten-digit 3... number.
  if (digits.startsWith('92') && !/^923\d{9}$/.test(digits)) return null;
  return `+${digits}`;
}
