import type { FileName } from '../src/records/store.ts';

export type StoredRecord = { id: string; importMarkdown?: string } & Partial<Record<FileName, string>>;
export type NoteFilesEntry = { id: string; folderName: string; imported?: true; 'transcript.md': string; 'summary.md'?: string };
export type NoteFolder = { folder: string; root: string };
export type DraftDocument = { id: string; filename: string; markdown: string };

type NoteFilesBridge = {
  status(): Promise<NoteFolder>;
  chooseFolder(entries: readonly NoteFilesEntry[]): Promise<NoteFolder | undefined>;
  sync(entries: readonly NoteFilesEntry[], deletedIds?: readonly string[]): Promise<void>;
  pickDocument(): Promise<DraftDocument | undefined>;
  saveImport(entry: NoteFilesEntry): Promise<void>;
  revealOriginal(id: string): Promise<boolean>;
};

declare global {
  interface Window { sitenoteNoteFiles?: NoteFilesBridge }
}

export const noteFiles = () => window.sitenoteNoteFiles;
