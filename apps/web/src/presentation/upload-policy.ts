/** Matches the API media policy. The web package cannot import the domain package. */
export const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;

const ALLOWED_MIME = new Set(["video/mp4", "video/quicktime", "video/x-matroska", "video/webm"]);

const EXTENSION_MIME: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
};

export function validateMediaFile(file: File): { mimeType: string } | { error: string } {
  if (file.size < 1) {
    return { error: "The file is empty. Choose a video that contains data." };
  }
  if (file.size > MAX_MEDIA_BYTES) {
    return { error: "Media byte size must be from 1 byte through 4 GiB." };
  }
  const filenameError = filenameProblem(file.name);
  if (filenameError !== null) {
    return { error: filenameError };
  }
  const mimeType = declaredMime(file);
  if (mimeType === null) {
    return {
      error: "Media MIME type must be video/mp4, video/quicktime, video/x-matroska, or video/webm.",
    };
  }
  return { mimeType };
}

function filenameProblem(name: string): string | null {
  if (name.length === 0 || name.length > 255) {
    return "A media display filename must be 1 to 255 characters.";
  }
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      return "A media display filename cannot contain control characters.";
    }
  }
  return null;
}

function declaredMime(file: File): string | null {
  if (ALLOWED_MIME.has(file.type)) {
    return file.type;
  }
  if (file.type !== "") {
    return null;
  }
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIME[extension] ?? null;
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
