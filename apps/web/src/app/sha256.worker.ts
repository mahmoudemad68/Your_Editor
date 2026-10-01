import { hashBlob } from "../presentation/sha256-file";

interface WorkerScope {
  onmessage: ((event: MessageEvent<{ file: Blob }>) => void) | null;
  postMessage(message: unknown): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<{ file: Blob }>) => {
  const file = event.data.file;
  void hashBlob(file, {
    onProgress: (loaded, total) => {
      scope.postMessage({ type: "progress", loaded, total });
    },
  }).then(
    (hex) => {
      scope.postMessage({ type: "done", hex });
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "Hashing failed.";
      scope.postMessage({ type: "error", message });
    },
  );
};
