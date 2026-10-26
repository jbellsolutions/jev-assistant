declare module "@novnc/novnc/lib/rfb" {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string } });
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    qualityLevel: number;
    compressionLevel: number;
    addEventListener(type: string, listener: (event: Event) => void): void;
    sendCredentials(credentials: { password: string }): void;
    disconnect(): void;
  }
}
