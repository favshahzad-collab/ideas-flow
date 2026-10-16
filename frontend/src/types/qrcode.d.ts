/**
 * Just the one function this app calls, declared here rather than installed.
 *
 * `@types/qrcode` opens with `/// <reference types="node" />` and imports
 * `stream`, because the package also renders to a file on a server. Installing
 * it pulls the whole of Node's global namespace into a browser program, and
 * the first thing that does is change what `setTimeout` returns - which broke
 * an unrelated file that had correctly written
 * `ReturnType<typeof window.setTimeout>` and suddenly meant Node's `Timeout`.
 *
 * The runtime is unaffected either way: the package's own `browser` field
 * already points the bundler at `lib/browser.js`, which is the half that has
 * no `fs` and no `stream` in it. This declaration describes that half.
 */
declare module 'qrcode' {
  export interface QrCodeToDataUrlOptions {
    /** Quiet zone in modules. The spec asks for 4; 1 is the usual compromise. */
    margin?: number
    /** Pixel width of the rendered square. */
    width?: number
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'
  }

  /** A `data:image/png;base64,…` URL for the text, black on white. */
  export function toDataURL(
    text: string,
    options?: QrCodeToDataUrlOptions
  ): Promise<string>

  const QRCode: { toDataURL: typeof toDataURL }
  export default QRCode
}
