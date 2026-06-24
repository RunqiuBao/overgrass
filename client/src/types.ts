export interface ProjectMeta {
  id: string;
  name: string;
  mainFile: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface CompileResult {
  success: boolean;
  pdfPath: string | null;
  log: string;
  errors: string[];
  mainFile: string | null;
  durationMs: number;
}

export interface ForwardHit {
  page: number;
  x: number;
  y: number;
  h: number;
  v: number;
  W: number;
  H: number;
}

export interface InverseHit {
  file: string | null;
  line: number;
  column: number;
}

export interface Version {
  hash: string;
  date: string;
  message: string;
}
