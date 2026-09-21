/**
 * What a reading session is, and where it is kept between reloads.
 *
 * The document itself, its extraction, its translation, its notes and its
 * overview all survive a reload already — they are on disk and in SQLite. What
 * did not survive is *which paper was open*: the workspace holds a `File` the
 * browser handed over, and a reload cannot re-open a local file without either
 * another gesture or the backend's copy. So this module persists the one thing
 * the browser genuinely cannot recover on its own: the reader's place.
 *
 * ## Why `localStorage` and not the URL
 *
 * A route (`#/doc/<id>`) would be the other way to say "which paper", and it was
 * rejected: it needs a router in a bundle that has 5.46 kB of headroom under a
 * frozen ceiling, it puts a private document id in a shareable string, and it
 * hands the back button control over what the reader is looking at. The session
 * belongs to the browser tab that was reading, not to a URL.
 *
 * ## What is deliberately not in here
 *
 * The conversation, the current selection and the sub-pixel scroll offset. A
 * question asked in a previous session is not a question this one asked; a
 * selection is a gesture that ended; and a pixel offset measured at one window
 * size points somewhere else at another. Each of those has its own session
 * (the IR, SQLite, the viewer's own geometry) or belongs to nobody.
 */
import type { SidebarPanel } from "@/stores/workspace";
import type { ReaderMode } from "@/stores/workspace";

/** The one key. Versioned in the name *and* in the record. */
export const ACTIVE_SESSION_STORAGE_KEY = "copilot:active_session_v1";

/** The only schema this build can read. Anything else is discarded, not guessed. */
export const SUPPORTED_SCHEMA_VERSION = 1;

export interface StoredReadingSession {
  schemaVersion: typeof SUPPORTED_SCHEMA_VERSION;
  /** The backend row the reader is in. The reader's place in the paper below. */
  documentId: string;
  name: string;
  /** 1-based, as the reader sees it. */
  activePage: number;
  readerMode: ReaderMode;
  outlinePanel: SidebarPanel;
  /** When this was last written, for diagnosis. Never used for ordering. */
  lastActiveAt: string;
}

/** The fields a caller may update after the first write. */
export type SessionPatch = Partial<Omit<StoredReadingSession, "schemaVersion" | "documentId">>;

/**
 * The stored session, or `null`.
 *
 * Every failure is `null`: no storage at all (a browser with `localStorage`
 * disabled), a value another program wrote, JSON that was truncated mid-write,
 * or a record from a schema this build does not know. A reader whose session
 * cannot be read gets the empty workspace they would have got anyway — never an
 * exception on the way to the first paint.
 */
export function readStoredSession(): StoredReadingSession | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    return null; // storage disabled by the browser, or a partitioned context
  }
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<StoredReadingSession>;
    if (record.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return null;
    if (typeof record.documentId !== "string" || record.documentId === "") return null;
    if (typeof record.name !== "string") return null;
    return {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      documentId: record.documentId,
      name: record.name,
      activePage: Number.isFinite(record.activePage) ? Number(record.activePage) : 1,
      readerMode: record.readerMode === "bilingual" || record.readerMode === "translation"
        ? record.readerMode
        : "original",
      outlinePanel:
        record.outlinePanel === "outline" || record.outlinePanel === "qa" ||
        record.outlinePanel === "notes"
          ? record.outlinePanel
          : "overview",
      lastActiveAt: typeof record.lastActiveAt === "string" ? record.lastActiveAt : "",
    };
  } catch {
    clearStoredSession();
    return null;
  }
}

export function writeStoredSession(session: StoredReadingSession): void {
  try {
    window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // A full or disabled store is not a reason to fail a reader's action: the
    // session is a convenience, and losing it costs a trip through the picker.
  }
}

/** Update a session that is already stored. A no-op when there is none. */
export function patchStoredSession(patch: SessionPatch): void {
  const current = readStoredSession();
  if (current === null) return;
  writeStoredSession({ ...current, ...patch, lastActiveAt: new Date().toISOString() });
}

export function clearStoredSession(): void {
  try {
    window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    // Nothing to do: the record is unreachable anyway if storage is broken.
  }
}
