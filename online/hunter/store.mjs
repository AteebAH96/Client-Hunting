import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { AppError } from './config.mjs';
import { COLUMNS, identityKeys } from './leads.mjs';

export function toCSV(leads) { return stringify(leads, { header: true, columns: COLUMNS, record_delimiter: '\r\n' }); }
export function fromCSV(csv) {
  if (!csv.trim()) return [];
  try {
    const rows = parse(csv, { bom: true, skip_empty_lines: true });
    const header = rows.shift();
    if (header.length !== COLUMNS.length || COLUMNS.some((name, index) => name !== header[index])) throw new Error();
    const leads = rows.map((row) => Object.fromEntries(COLUMNS.map((name, index) => [name, row[index]])));
    if (leads.some((lead) => !lead.id || !lead.name || !['web', 'video'].includes(lead.type) || !['new', 'sent', 'replied', 'won', 'lost'].includes(lead.status))) throw new Error();
    if (new Set(leads.map((lead) => lead.id)).size !== leads.length) throw new Error();
    return leads;
  } catch { throw new AppError('Invalid leads.csv. Use the original Client Hunter CSV columns and valid lead records.'); }
}

export class LeadStore {
  constructor(database) { this.db = database; }
  async state() {
    return await this.db.prepare("SELECT revision, csv FROM csv_state WHERE id = 'leads'").first() || { revision: -1, csv: toCSV([]) };
  }
  async read() { return fromCSV((await this.state()).csv); }
  async mutate(change) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.state();
      const leads = fromCSV(current.csv);
      const result = change(leads);
      if (result?.unchanged) return result.value;
      const csv = toCSV(leads);
      if (new TextEncoder().encode(csv).length > 1800000) throw new AppError('The notebook has reached its storage limit. Export a CSV and remove old leads before adding more.', 413);
      const revision = current.revision;
      const statements = revision < 0 ? [
        this.db.prepare("INSERT OR IGNORE INTO csv_state (id, revision, csv) VALUES ('leads', 0, ?)").bind(csv),
      ] : [
        this.db.prepare("INSERT OR IGNORE INTO csv_backups (revision, csv, created_at) SELECT revision, csv, ? FROM csv_state WHERE id = 'leads' AND revision = ?").bind(new Date().toISOString(), revision),
        this.db.prepare("UPDATE csv_state SET revision = revision + 1, csv = ? WHERE id = 'leads' AND revision = ?").bind(csv, revision),
        this.db.prepare('DELETE FROM csv_backups WHERE revision NOT IN (SELECT revision FROM csv_backups ORDER BY revision DESC LIMIT 20)'),
      ];
      const results = await this.db.batch(statements);
      if (results[revision < 0 ? 0 : 1].meta.changes === 1) return result?.value;
    }
    throw new AppError('Another device is saving changes. Please try again.', 409);
  }
  async addMany(candidates) {
    return this.mutate((leads) => {
      const keys = new Set(leads.flatMap(identityKeys)); const ids = new Set(leads.map((lead) => lead.id)); const added = [];
      for (const candidate of candidates) {
        const identities = identityKeys(candidate);
        if (ids.has(candidate.id) || identities.some((key) => keys.has(key))) continue;
        leads.push(candidate); added.push(candidate); ids.add(candidate.id); identities.forEach((key) => keys.add(key));
      }
      return { unchanged: !added.length, value: added };
    });
  }
  async update(id, change) {
    return this.mutate((leads) => {
      const index = leads.findIndex((lead) => lead.id === id);
      if (index < 0) throw new AppError('This lead no longer exists.', 404);
      const updated = change(leads[index]);
      const unchanged = COLUMNS.every((key) => updated[key] === leads[index][key]); leads[index] = updated;
      return { unchanged, value: updated };
    });
  }
  async remove(id) {
    return this.mutate((leads) => { const index = leads.findIndex((lead) => lead.id === id); if (index < 0) throw new AppError('This lead no longer exists.', 404); leads.splice(index, 1); return {}; });
  }
}
