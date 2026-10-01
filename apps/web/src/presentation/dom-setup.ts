import { Window } from "happy-dom";

const window = new Window({ url: "http://127.0.0.1:3000/" });

function install(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

install("window", window);
install("document", window.document);
install("Event", window.Event);
install("CustomEvent", window.CustomEvent);
install("KeyboardEvent", window.KeyboardEvent);
install("MouseEvent", window.MouseEvent);
install("PointerEvent", window.PointerEvent);
install("FocusEvent", window.FocusEvent);
install("HTMLElement", window.HTMLElement);
install("HTMLInputElement", window.HTMLInputElement);
install("HTMLButtonElement", window.HTMLButtonElement);
install("HTMLTextAreaElement", window.HTMLTextAreaElement);
install("HTMLSelectElement", window.HTMLSelectElement);
install("HTMLAnchorElement", window.HTMLAnchorElement);
install("Node", window.Node);
install("Element", window.Element);
install("DocumentFragment", window.DocumentFragment);
install("NodeFilter", window.NodeFilter);
install("MutationObserver", window.MutationObserver);
install("ResizeObserver", window.ResizeObserver);
install("getComputedStyle", window.getComputedStyle.bind(window));
install("IS_REACT_ACT_ENVIRONMENT", true);
install("requestAnimationFrame", (callback: FrameRequestCallback) =>
  setTimeout(() => callback(Date.now()), 0),
);
install("cancelAnimationFrame", (id: number) => clearTimeout(id));
