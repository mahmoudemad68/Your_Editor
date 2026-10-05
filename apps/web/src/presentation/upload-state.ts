import type { UploadDeclaration } from "../project-contract";
export interface SavedUpload extends UploadDeclaration {
  readonly scope: string;
  readonly projectId: string;
  readonly uploadSessionId: string;
  readonly partSize: number;
  readonly lastModified: number;
  readonly updatedAt: number;
}
export interface UploadStateStore {
  get(scope: string): Promise<SavedUpload | null>;
  save(record: SavedUpload): Promise<void>;
  remove(scope: string): Promise<void>;
}
/** Metadata only: no File/blob, session token, provider upload id or presigned URL. */
export class IndexedUploadState implements UploadStateStore {
  private async db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("editagent-upload-state", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("uploads", { keyPath: "scope" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Resumable upload metadata could not be opened."));
    });
  }
  private async transaction<T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.db();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction("uploads", mode);
        const request = action(tx.objectStore("uploads"));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(new Error("Resumable upload metadata could not be saved."));
        tx.onabort = () => reject(new Error("Resumable upload metadata could not be saved."));
      });
    } finally {
      db.close();
    }
  }
  async get(scope: string): Promise<SavedUpload | null> {
    return (await this.transaction("readonly", (store) => store.get(scope))) ?? null;
  }
  async save(record: SavedUpload): Promise<void> {
    await this.transaction("readwrite", (store) => store.put(record));
  }
  async remove(scope: string): Promise<void> {
    await this.transaction("readwrite", (store) => store.delete(scope));
  }
}
