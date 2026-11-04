// File icons: one quiet line glyph per kind of file, in the Mono spirit (no rainbow).
import {
  Braces,
  Database,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  Folder,
  FolderGit2,
  FolderOpen,
  Hash,
  type LucideIcon,
  Package,
} from 'lucide-react';
import { extname } from '../lib/paths';

const BY_EXTENSION: Record<string, LucideIcon> = {};
const add = (icon: LucideIcon, exts: string[]) => exts.forEach((e) => (BY_EXTENSION[e] = icon));

add(FileCode, [
  '.py',
  '.pyw',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.c',
  '.h',
  '.cpp',
  '.cc',
  '.cxx',
  '.hpp',
  '.hh',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.cs',
  '.rb',
  '.php',
  '.lua',
  '.swift',
  '.dart',
  '.scala',
  '.r',
  '.jl',
  '.zig',
  '.vue',
  '.svelte',
  '.html',
  '.htm',
  '.xml',
  '.ipynb',
]);
add(Hash, ['.css', '.scss', '.sass', '.less']);
add(FileJson, ['.json', '.jsonc', '.json5']);
add(Braces, ['.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env']);
add(FileText, ['.md', '.markdown', '.txt', '.rst', '.log', '.adoc']);
add(FileTerminal, ['.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd']);
add(FileImage, ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.avif']);
add(FileArchive, ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.xz', '.bz2']);
add(FileSpreadsheet, ['.csv', '.tsv', '.xlsx', '.xls']);
add(FileVideo, ['.mp4', '.mov', '.webm', '.mkv', '.avi']);
add(FileAudio, ['.mp3', '.wav', '.flac', '.ogg', '.m4a']);
add(FileType, ['.ttf', '.otf', '.woff', '.woff2']);
add(Database, ['.db', '.sqlite', '.sqlite3', '.sql']);
add(FileLock, ['.lock', '.pem', '.key', '.crt']);

const BY_NAME: Record<string, LucideIcon> = {
  'package.json': Package,
  'cargo.toml': Package,
  'pyproject.toml': Package,
  'requirements.txt': Package,
  'go.mod': Package,
  dockerfile: FileCog,
  makefile: FileCog,
  'cmakelists.txt': FileCog,
  '.gitignore': FileCog,
  '.gitattributes': FileCog,
  '.editorconfig': FileCog,
  'pnpm-lock.yaml': FileLock,
  'package-lock.json': FileLock,
  'yarn.lock': FileLock,
  'cargo.lock': FileLock,
};

export function fileIcon(name: string): LucideIcon {
  const lower = name.toLowerCase();
  return BY_NAME[lower] ?? BY_EXTENSION[extname(lower)] ?? (lower.startsWith('.') ? FileCog : File);
}

export function folderIcon(name: string, open: boolean): LucideIcon {
  if (name.toLowerCase() === '.git') return FolderGit2;
  return open ? FolderOpen : Folder;
}
