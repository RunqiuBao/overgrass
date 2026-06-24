import { useState } from 'react';
import type { FileNode } from '../types';

interface Props {
  nodes: FileNode[];
  selected: string | null;
  mainFile: string | null;
  onSelect: (node: FileNode) => void;
  onCreate: (parentDir: string, type: 'file' | 'dir') => void;
  onRename: (node: FileNode) => void;
  onDelete: (node: FileNode) => void;
  onSetMain: (node: FileNode) => void;
  /** Upload files into the given directory ('' = project root). */
  onUpload: (dir: string) => void;
}

function iconFor(node: FileNode): string {
  if (node.type === 'dir') return '📁';
  const ext = node.name.split('.').pop()?.toLowerCase();
  if (ext === 'tex') return '📄';
  if (ext === 'bib') return '📚';
  if (['png', 'jpg', 'jpeg', 'gif', 'pdf', 'svg', 'eps'].includes(ext ?? '')) return '🖼';
  return '📃';
}

function TreeNode({
  node,
  depth,
  ...props
}: { node: FileNode; depth: number } & Omit<Props, 'nodes'>) {
  const [open, setOpen] = useState(depth < 1);
  const isSelected = props.selected === node.path;
  const isMain = props.mainFile === node.path;

  return (
    <div className="tree-node">
      <div
        className={`tree-row${isSelected ? ' selected' : ''}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => (node.type === 'dir' ? setOpen((o) => !o) : props.onSelect(node))}
      >
        {node.type === 'dir' && <span className="caret">{open ? '▾' : '▸'}</span>}
        <span className="tree-icon">{iconFor(node)}</span>
        <span className="tree-name" title={node.path}>
          {node.name}
        </span>
        {isMain && <span className="main-badge" title="Main file">main</span>}
        <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
          {node.type === 'dir' && (
            <>
              <button className="mini" title="New file" onClick={() => props.onCreate(node.path, 'file')}>
                ＋
              </button>
              <button className="mini" title="New folder" onClick={() => props.onCreate(node.path, 'dir')}>
                📁
              </button>
              <button
                className="mini"
                title={`Upload files into ${node.name}/`}
                onClick={() => props.onUpload(node.path)}
              >
                📤
              </button>
            </>
          )}
          {node.type === 'file' && node.name.toLowerCase().endsWith('.tex') && (
            <button className="mini" title="Set as main file" onClick={() => props.onSetMain(node)}>
              ★
            </button>
          )}
          <button className="mini" title="Rename" onClick={() => props.onRename(node)}>
            ✎
          </button>
          <button className="mini danger" title="Delete" onClick={() => props.onDelete(node)}>
            ✕
          </button>
        </span>
      </div>
      {node.type === 'dir' && open && (
        <div className="tree-children">
          {(node.children ?? []).map((child) => (
            <TreeNode key={child.path} node={child} depth={depth + 1} {...props} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FileTree({ nodes, ...props }: Props) {
  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <span>Files</span>
        <span className="tree-actions">
          <button className="mini" title="New file at root" onClick={() => props.onCreate('', 'file')}>
            ＋
          </button>
          <button className="mini" title="New folder at root" onClick={() => props.onCreate('', 'dir')}>
            📁
          </button>
          <button className="mini" title="Upload files to project root" onClick={() => props.onUpload('')}>
            📤
          </button>
        </span>
      </div>
      <div className="file-tree-body">
        {nodes.length === 0 ? (
          <p className="muted small" style={{ padding: 12 }}>
            No files. Create one with ＋.
          </p>
        ) : (
          nodes.map((node) => <TreeNode key={node.path} node={node} depth={0} {...props} />)
        )}
      </div>
    </div>
  );
}
