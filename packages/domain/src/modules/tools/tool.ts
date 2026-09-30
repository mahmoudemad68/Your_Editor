/**
 * Canonical Tool name. Execution, manifests, and FFmpeg stay in later Tools stories.
 * No Tool declares a shell permission.
 */

import { DomainError } from "../../kernel/error.js";
import { type ToolId } from "../../kernel/id.js";

export class Tool {
  readonly id: ToolId;
  readonly shellPermission = false as const;

  private constructor(id: ToolId) {
    this.id = id;
  }

  static create(id: ToolId, shellPermission = false): Tool {
    if (shellPermission) {
      throw new DomainError("A Tool must not declare a shell permission.");
    }
    return new Tool(id);
  }
}
