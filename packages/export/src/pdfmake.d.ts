declare module "pdfmake/build/pdfmake.js" {
  interface PdfDocument {
    getBuffer(callback: (buffer: Buffer) => void): void;
  }

  interface PdfMake {
    vfs: Readonly<Record<string, string>>;
    createPdf(definition: unknown): PdfDocument;
  }

  const pdfMake: PdfMake;
  export default pdfMake;
}

declare module "pdfmake/build/vfs_fonts.js" {
  const fonts: Readonly<Record<string, string>>;
  export default fonts;
}
