import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
export const DATA_DIR = path.resolve(process.env.CLIENT_HUNTER_DATA_DIR || ROOT);
export const TIMEZONE = process.env.TIMEZONE || 'Asia/Karachi';

export function dateToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type) => parts.find((p) => p.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function addDays(date, days) {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function requireKey(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new AppError(`Missing ${name}. Add it to .env and restart the server.`);
  return value;
}
