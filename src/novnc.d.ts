// noVNC 1.7 exports its ESM entry at the package root. DefinitelyTyped's
// declarations still name the old 1.6 entry point, and their index file is a
// global declaration rather than a module, so importing the package root does
// not type-check. The app uses a small part of the client, declared here.
declare module "@novnc/novnc" {
  export interface RfbCredentials {
    password?: string;
    username?: string;
    target?: string;
  }
  export interface RfbOptions {
    credentials?: RfbCredentials;
  }
  export interface RfbEventMap {
    connect: Event;
    disconnect: Event;
    clipboard: CustomEvent<{ text: string }>;
  }
  export default class RFB {
    constructor(target: HTMLElement, url?: string, options?: RfbOptions);
    scaleViewport: boolean;
    background: string;
    focusOnClick: boolean;
    disconnect(): void;
    sendKey(keysym: number, code: string | null): void;
    focus(options?: FocusOptions): void;
    clipboardPasteFrom(text: string): void;
    sendCtrlAltDel(): void;
    addEventListener<K extends keyof RfbEventMap>(type: K, listener: (event: RfbEventMap[K]) => void): void;
    removeEventListener<K extends keyof RfbEventMap>(type: K, listener: (event: RfbEventMap[K]) => void): void;
  }
}
