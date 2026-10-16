import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { COLUMNS, identityKeys } from './leads.mjs';
import { AppError, DATA_DIR, dateToday, TIMEZONE } from './config.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class LeadStore {
  constructor(directory = DATA_DIR) {
    this.directory = directory;
    this.file = path.join(directory, 'leads.csv');
    this.lockFile = `${this.file}.lock`;
    this.backupDirectory = path.join(directory, 'backups');
  }

  async lock() {
    await fs.mkdir(this.directory, { recursive: true });
    const start = Date.now();
    while (true) {
      try {
        const handle = await fs.open(this.lockFile, 'wx');
        await handle.writeFile(String(process.pid));
        return async () => { await handle.close(); await fs.unlink(this.lockFile); };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const owner = Number(await fs.readFile(this.lockFile, 'utf8'));
          if (Number.isInteger(owner) && owner > 0) {
            try { process.kill(owner, 0); }
            catch (cause) { if (cause.code === 'ESRCH') await fs.unlink(this.lockFile).catch(() => {}); }
          }
        } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        if (Date.now() - start > 15000) throw new AppError('The CSV is busy. Please try saving again.', 503);
        await delay(40);
      }
    }
  }

  async read() {
    let text;
    try { text = await fs.readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (!text.trim()) return [];
    try {
      const records = parse(text, { bom: true, skip_empty_lines: true });
      const header = records.shift();
      if (header.length !== COLUMNS.length || COLUMNS.some((key, index) => key !== header[index])) {
        throw new Error('unexpected columns');
      }
      return records.map((row) => Object.fromEntries(COLUMNS.map((key, index) => [key, row[index]])));
    } catch {
      throw new AppError('leads.csv is not valid CSV or its columns have changed. Restore a backup before saving.', 500);
    }
  }

  async backup() {
    await fs.mkdir(this.backupDirectory, { recursive: true });
    const now = new Date();
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).replace(':', '');
    const base = `leads-${dateToday(now)}-${time}`;
    for (let suffix = 0; ; suffix++) {
      const name = `${base}${suffix ? `-${String(suffix).padStart(3, '0')}` : ''}.csv`;
      try {
        await fs.copyFile(this.file, path.join(this.backupDirectory, name), 1);
        return;
      } catch (error) {
        if (error.code === 'ENOENT') return;
        if (error.code !== 'EEXIST') throw error;
      }
    }
  }

  async pruneBackups() {
    const names = (await fs.readdir(this.backupDirectory)).filter((name) => /^leads-\d{4}-\d{2}-\d{2}-\d{4}(?:-\d+)?\.csv$/.test(name));
    const files = await Promise.all(names.map(async (name) => ({ name, modified: (await fs.stat(path.join(this.backupDirectory, name))).mtimeMs })));
    files.sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name));
    await Promise.all(files.slice(20).map(({ name }) => fs.unlink(path.join(this.backupDirectory, name))));
  }

  async mutate(change) {
    const unlock = await this.lock();
    try {
      const leads = await this.read();
      const result = await change(leads);
      if (result?.unchanged) return result.value;
      const csv = stringify(leads, { header: true, columns: COLUMNS, record_delimiter: '\r\n' });
      await this.backup();
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, csv, { flag: 'wx' });
        await fs.rename(temporary, this.file);
      } finally { await fs.unlink(temporary).catch(() => {}); }
      await this.pruneBackups();
      return result?.value;
    } finally { await unlock(); }
  }

  async initialize() {
    await this.mutate(async () => {
      try { await fs.access(this.file); return { unchanged: true }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
    });
  }

  async addMany(candidates) {
    return this.mutate((leads) => {
      const keys = new Set(leads.flatMap(identityKeys));
      const added = [];
      for (const candidate of candidates) {
        const identities = identityKeys(candidate);
        if (identities.some((key) => keys.has(key))) continue;
        added.push(candidate);
        leads.push(candidate);
        identities.forEach((key) => keys.add(key));
      }
      return { unchanged: !added.length, value: added };
    });
  }

  async update(id, change) {
    return this.mutate((leads) => {
      const index = leads.findIndex((lead) => lead.id === id);
      if (index < 0) throw new AppError('This lead no longer exists.', 404);
      const updated = change(leads[index]);
      const unchanged = COLUMNS.every((key) => updated[key] === leads[index][key]);
      leads[index] = updated;
      return { unchanged, value: updated };
    });
  }

  async remove(id) {
    return this.mutate((leads) => {
      const index = leads.findIndex((lead) => lead.id === id);
      if (index < 0) throw new AppError('This lead no longer exists.', 404);
      leads.splice(index, 1);
      return {};
    });
  }
}
