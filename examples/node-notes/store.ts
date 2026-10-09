import { DatabaseSync } from 'node:sqlite';
import type { CustomerScope } from '../../src/backend/index.js';

export interface Note {
  id: number;
  text: string;
  createdAt: string;
  updatedAt: string;
}

interface NoteRow {
  id: number;
  text: string;
  created_at: string;
  updated_at: string;
}

function noteFromRow(row: NoteRow): Note {
  return { id: row.id, text: row.text, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function validateNoteText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000) {
    throw new Error('Note text must contain 1–2,000 characters.');
  }
  return value;
}

/** Every operation checks origin, customer, and user ownership in the SQL predicate. */
export class NotesStore {
  private readonly db: DatabaseSync;

  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_url TEXT NOT NULL,
        customer_id INTEGER NOT NULL,
        user_email TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notes_owner ON notes(server_url, customer_id, user_email, id);
    `);
  }

  list(scope: CustomerScope): Note[] {
    const rows = this.db.prepare(`
      SELECT id, text, created_at, updated_at FROM notes
      WHERE server_url = ? AND customer_id = ? AND user_email = ?
      ORDER BY id DESC LIMIT 100
    `).all(scope.serverUrl, scope.customerId, scope.userEmail) as unknown as NoteRow[];
    return rows.map(noteFromRow);
  }

  create(scope: CustomerScope, text: string): Note {
    const validatedText = validateNoteText(text);
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO notes(server_url, customer_id, user_email, text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(scope.serverUrl, scope.customerId, scope.userEmail, validatedText, now, now);
    return { id: Number(result.lastInsertRowid), text: validatedText, createdAt: now, updatedAt: now };
  }

  update(scope: CustomerScope, id: number, text: string): Note | null {
    const validatedText = validateNoteText(text);
    const row = this.db.prepare(`
      UPDATE notes SET text = ?, updated_at = ?
      WHERE id = ? AND server_url = ? AND customer_id = ? AND user_email = ?
      RETURNING id, text, created_at, updated_at
    `).get(validatedText, new Date().toISOString(), id, scope.serverUrl, scope.customerId, scope.userEmail) as NoteRow | undefined;
    return row ? noteFromRow(row) : null;
  }

  delete(scope: CustomerScope, id: number): boolean {
    const result = this.db.prepare(`
      DELETE FROM notes WHERE id = ? AND server_url = ? AND customer_id = ? AND user_email = ?
    `).run(id, scope.serverUrl, scope.customerId, scope.userEmail);
    return Number(result.changes) === 1;
  }

  close(): void {
    this.db.close();
  }
}
