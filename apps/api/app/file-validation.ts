import { TextDecoder } from 'node:util';
import yauzl from 'yauzl';
import { ApiError } from './http.js';

export const mib = 1024 * 1024;
export const mediaTypes = {
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;
type Extension = keyof typeof mediaTypes;
const dangerous = new Set([
  'exe',
  'com',
  'cmd',
  'bat',
  'ps1',
  'js',
  'mjs',
  'cjs',
  'msi',
  'htm',
  'html',
  'svg',
  'jar',
  'php',
  'scr',
  'dll',
  'sh',
  'bin',
  'app',
  'docm',
  'pptm',
  'xlsm',
]);
const documentPart = { docx: 'word/document.xml', pptx: 'ppt/presentation.xml', xlsx: 'xl/workbook.xml' };

function unsupported(): never {
  throw new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'The file does not match a supported format.');
}

function readArchive(bytes: Buffer, expected?: string): Promise<boolean> {
  return new Promise((resolve) => {
    yauzl.fromBuffer(
      bytes,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, archive) => {
        if (error || !archive || archive.entryCount > 1024) {
          archive?.close();
          resolve(false);
          return;
        }
        let manifest = false;
        let part = false;
        let macro = false;
        archive.once('error', () => {
          archive.close();
          resolve(false);
        });
        archive.on('entry', (entry) => {
          const name = entry.fileName.toLowerCase();
          if (name === '[content_types].xml') manifest = true;
          if (name === expected) part = true;
          if (name.endsWith('/vbaproject.bin')) macro = true;
          archive.readEntry();
        });
        archive.once('end', () => resolve(!expected || (manifest && part && !macro)));
        archive.readEntry();
      },
    );
  });
}

export async function inspectUpload(originalName: string, bytes: Buffer) {
  if (!bytes.length) unsupported();
  const filename = originalName
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim();
  if (!filename || Array.from(filename).length > 200 || filename.startsWith('.')) unsupported();
  const [, ...suffixes] = filename.toLowerCase().split('.');
  const extension = suffixes.at(-1) as Extension;
  if (!extension || !Object.hasOwn(mediaTypes, extension) || suffixes.some((part) => dangerous.has(part)))
    unsupported();

  switch (extension) {
    case 'pdf':
      if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) unsupported();
      break;
    case 'png':
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) unsupported();
      break;
    case 'jpg':
    case 'jpeg':
      if (!bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) unsupported();
      break;
    case 'txt':
    case 'md':
      try {
        if (new TextDecoder('utf-8', { fatal: true }).decode(bytes).includes('\u0000')) unsupported();
      } catch {
        unsupported();
      }
      break;
    default:
      if (!(await readArchive(bytes, extension === 'zip' ? undefined : documentPart[extension]))) unsupported();
  }
  return { filename, extension, contentType: mediaTypes[extension] };
}
