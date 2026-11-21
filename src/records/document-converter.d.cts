export declare const documentExtensions: readonly string[];
export declare const maxDocumentBytes: number;
export declare const maxDocumentTextLength: number;

export declare class DocumentImportError extends Error {
  readonly code: 'DOCUMENT_IMPORT_ERROR';
}

export declare function convertDocument(filename: string, bytes: Uint8Array): Promise<string>;
