declare module "yazl" {
  /** zip を作る（ファイル名は UTF-8 の印を付けて書く）。使う分だけの型。 */
  export class ZipFile {
    addFile(realPath: string, metadataPath: string, options?: { mtime?: Date; mode?: number }): void;
    addEmptyDirectory(metadataPath: string, options?: { mtime?: Date; mode?: number }): void;
    end(): void;
    outputStream: NodeJS.ReadableStream;
  }
  const yazl: { ZipFile: typeof ZipFile };
  export default yazl;
}
