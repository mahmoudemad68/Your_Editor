/** Canonical Component name. Remotion manifests and packs are later Components stories. */

import { type ComponentId } from "../../kernel/id.js";

export class Component {
  readonly id: ComponentId;

  private constructor(id: ComponentId) {
    this.id = id;
  }

  static create(id: ComponentId): Component {
    return new Component(id);
  }
}
