/**
 * Canonical Tool name. Execution, manifests, and FFmpeg stay in later Tools stories.
 * No Tool declares a shell permission.
 */

import { DomainError } from "../../kernel/error.js";
import { type ToolId, toolId } from "../../kernel/id.js";

export class Tool {
  readonly id: ToolId;
  readonly shellPermission = false as const;

  constructor(id: ToolId | string, shellPermission = false) {
    if (shellPermission) {
      throw new DomainError("A Tool must not declare a shell permission.");
    }
    this.id = toolId(String(id));
    Object.freeze(this);
  }

  static create(id: ToolId, shellPermission = false): Tool {
    return new Tool(id, shellPermission);
  }
}
