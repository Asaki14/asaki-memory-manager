// Runtime stub for `@earendil-works/pi-tui` (and the type-only `@earendil-works/pi-coding-agent`),
// used only by scripts/eval-pi-inject.mjs via scripts/pi-host-stubs.mjs. Renderers are not under
// test here; the stub just has to construct.
export class Text {
  constructor(content, top = 0, bottom = 0) {
    this.content = content;
    this.top = top;
    this.bottom = bottom;
  }
}
