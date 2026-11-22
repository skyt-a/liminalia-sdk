declare module "subset-font" {
  /** 字の集まり（text）だけを残したフォントを作る（harfbuzz の hb-subset）。 */
  export default function subsetFont(font: Buffer, text: string, options?: { targetFormat?: "sfnt" | "woff" | "woff2"; preserveNameIds?: number[] }): Promise<Buffer>;
}
