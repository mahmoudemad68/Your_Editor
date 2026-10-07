export interface SseFrame {
  event: string;
  data: string;
  id: string;
}
/** Incremental SSE framing: CR, LF, CRLF, multiline data, comments, and EOF. */
export class SseParser {
  private line = "";
  private data: string[] = [];
  private event = "";
  private id = "";
  private cr = false;
  private lineHasData = false;
  private size = 0;
  private oversized = false;
  constructor(
    private readonly emit: (frame: SseFrame) => void,
    private readonly limit = 8192,
  ) {}
  feed(text: string) {
    for (const char of text) {
      if (this.cr) {
        this.cr = false;
        if (char === "\n") continue;
      }
      if (char === "\r" || char === "\n") {
        this.consumeLine();
        this.cr = char === "\r";
      } else {
        this.lineHasData = true;
        this.size++;
        if (this.size > this.limit) this.oversized = true;
        if (!this.oversized) this.line += char;
      }
    }
  }
  end() {
    if (this.lineHasData) this.consumeLine();
    this.dispatch();
  }
  private consumeLine() {
    const line = this.line;
    const empty = !this.lineHasData;
    this.lineHasData = false;
    this.line = "";
    if (empty && !this.oversized) {
      this.dispatch();
      return;
    }
    // Oversized frames are discarded through the next real blank line.
    if (this.oversized) {
      if (empty) this.reset();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
  }
  private dispatch() {
    if (!this.oversized && this.data.length)
      this.emit({ event: this.event || "message", data: this.data.join("\n"), id: this.id });
    this.reset();
  }
  private reset() {
    this.line = "";
    this.data = [];
    this.event = "";
    this.id = "";
    this.size = 0;
    this.oversized = false;
  }
}
