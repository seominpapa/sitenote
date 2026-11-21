import type { FileName } from '../src/records/store.ts';

export type StoredRecord = { id: string } & Partial<Record<FileName, string>>;
export type NoteFolder = { folder: string; root: string };
export type DraftDocument = { id: string; filename: string; markdown: string };

type NoteFilesBridge = {
  status(): Promise<NoteFolder>;
  chooseFolder(entries: readonly StoredRecord[]): Promise<NoteFolder | undefined>;
  sync(entries: readonly StoredRecord[], deletedIds?: readonly string[]): Promise<void>;
  pickDocument(): Promise<DraftDocument | undefined>;
  saveImport(entry: StoredRecord): Promise<void>;
  revealOriginal(id: string): Promise<boolean>;
};

declare global {
  interface Window { sitenoteNoteFiles?: NoteFilesBridge }
}

export const noteFiles = () => window.sitenoteNoteFiles;
