import { type Readable } from "node:stream";

export interface OpenedObject {
  readonly stream: Readable;
  readonly contentLength: bigint | null;
}

/** Reads one object as a stream. Callers must not buffer the whole body. */
export interface ObjectByteSource {
  open(storageKey: string): Promise<OpenedObject>;
}
