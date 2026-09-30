/** The declared upload breaks the media policy. No URL is issued. */
export class UploadPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadPolicyError";
  }
}

/** Completion cannot find the object that the declared upload names. */
export class UploadObjectMissing extends Error {
  constructor() {
    super("The uploaded object is not available.");
    this.name = "UploadObjectMissing";
  }
}

/** The stored object does not match the declared upload. */
export class UploadObjectMismatch extends Error {
  constructor() {
    super("The uploaded object does not match the declared upload.");
    this.name = "UploadObjectMismatch";
  }
}

/** Object storage failed. The message stays free of provider details. */
export class ObjectStorageUnavailable extends Error {
  constructor() {
    super("Object storage is unavailable.");
    this.name = "ObjectStorageUnavailable";
  }
}
