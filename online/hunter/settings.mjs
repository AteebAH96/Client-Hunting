import { env } from 'cloudflare:workers';
import { AppError } from './config.mjs';

export const SETTING_KEYS = ['GOOGLE_PLACES_API_KEY', 'YOUTUBE_API_KEY', 'GEMINI_API_KEY', 'SENDER_NAME', 'PORTFOLIO_URL', 'MODEL'];
async function encryptionKey() {
  if (!env.SETTINGS_ENCRYPTION_KEY) throw new AppError('Hosted settings are not configured. Contact the site owner.', 503);
  const bytes = Uint8Array.from(atob(env.SETTINGS_ENCRYPTION_KEY), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encrypt(value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(), new TextEncoder().encode(value)));
  return JSON.stringify({ iv: Array.from(iv), data: Array.from(encrypted) });
}
async function decrypt(value) {
  const parsed = JSON.parse(value);
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(parsed.iv) }, await encryptionKey(), new Uint8Array(parsed.data));
  return new TextDecoder().decode(bytes);
}
export async function readSettings(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(await Promise.all(rows.results.map(async ({ key, value }) => [key, await decrypt(value)])));
}
export async function saveSettings(db, input) {
  const statements = [];
  for (const key of SETTING_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (typeof value !== 'string' || value.length > 2000) throw new AppError(`Enter a valid ${key}.`);
    if (key.endsWith('_API_KEY') && !value.trim()) continue;
    if (key === 'PORTFOLIO_URL' && value && !/^https?:\/\//i.test(value)) throw new AppError('Use a full http:// or https:// portfolio URL.');
    if (key === 'MODEL' && value && !/^gemini-[a-zA-Z0-9._-]{1,140}$/.test(value)) throw new AppError('Enter a Gemini model ID, such as gemini-3.5-flash-lite.');
    statements.push(db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, await encrypt(value.trim())));
  }
  if (statements.length) await db.batch(statements);
}
