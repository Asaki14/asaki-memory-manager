declare module "@oh-my-pi/pi-coding-agent" {
  export type ExtensionAPI = any;
}

declare module "@oh-my-pi/pi-tui" {
  export class Text {
    constructor(content: string, top?: number, bottom?: number);
  }
}
