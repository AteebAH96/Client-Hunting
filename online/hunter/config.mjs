import { env } from 'cloudflare:workers';
import { AsyncLocalStorage } from 'node:async_hooks';

const requestSettings = new AsyncLocalStorage();
export function withRuntimeSettings(settings, action) { return requestSettings.run(settings, action); }
export function runtimeValue(name) {
  const overrides = requestSettings.getStore();
  return overrides && Object.hasOwn(overrides, name) ? overrides[name] : typeof env[name] === 'string' ? env[name] : '';
}
export const TIMEZONE = 'Asia/Karachi';
export function dateToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function addDays(date, days) {
  const result = new Date(`${date}T12:00:00Z`); result.setUTCDate(result.getUTCDate() + days); return result.toISOString().slice(0, 10);
}
export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function requireKey(name) {
  const value = runtimeValue(name).trim();
  if (!value) throw new AppError(`Missing ${name}. Open API setup to configure it.`);
  return value;
}
