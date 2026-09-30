/** Canonical Component name. Remotion manifests and packs are later Components stories. */

import { type ComponentId, componentId } from "../../kernel/id.js";

export class Component {
  readonly id: ComponentId;

  constructor(id: ComponentId | string) {
    this.id = componentId(String(id));
    Object.freeze(this);
  }

  static create(id: ComponentId): Component {
    return new Component(id);
  }
}
