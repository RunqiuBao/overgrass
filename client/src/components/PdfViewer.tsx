import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// Vite resolves this to a URL string for the worker bundle.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ForwardHit } from '../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** A forward-search target plus a nonce so repeated hits on the same spot re-trigger. */
export interface PdfHighlight extends ForwardHit {
  nonce: number;
}

interface Props {
  url: string | null;
  highlight: PdfHighlight | null;
  /** Double-click on the PDF -> inverse SyncTeX search. x,y in PDF points (top-left origin). */
  onReverse: (page: number, x: number, y: number) => void;
}

interface PageDim {
  num: number;
  /** CSS pixel size at the current scale. */
  w: number;
  h: number;
}

export default function PdfViewer({ url, highlight, onReverse }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageDim[]>([]);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<{ page: number; left: number; top: number; w: number; h: number } | null>(null);

  const canvasRefs = useRef<Record<number, HTMLCanvasElement | null>>({});
  const wrapRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const textRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const overlayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load the document whenever the URL changes.
  useEffect(() => {
    if (!url) {
      setDoc(null);
      setPages([]);
      return;
    }
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const d = await pdfjsLib.getDocument({ url }).promise;
        if (cancelled) return;
        setDoc(d);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Compute page dimensions whenever the document or scale changes.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const dims: PageDim[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const vp = page.getViewport({ scale });
        dims.push({ num: n, w: Math.floor(vp.width), h: Math.floor(vp.height) });
      }
      if (!cancelled) setPages(dims);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, scale]);

  // Render each page into its canvas once the page elements exist.
  // Depends on `pages` only (which already encodes the scale via its dims), so
  // a zoom change re-renders exactly once. In-flight render tasks are cancelled
  // on cleanup — overlapping renders on the same canvas corrupt/flip output.
  useEffect(() => {
    if (!doc || pages.length === 0) return;
    let cancelled = false;
    // Structural type matching the parts of a PDF.js RenderTask we use.
    const tasks: { cancel: () => void; promise: Promise<void> }[] = [];
    const textLayers: TextLayer[] = [];
    (async () => {
      const dpr = window.devicePixelRatio || 1;
      for (const dim of pages) {
        if (cancelled) return;
        const canvas = canvasRefs.current[dim.num];
        if (!canvas) continue;
        const page = await doc.getPage(dim.num);
        if (cancelled) return;
        const vp = page.getViewport({ scale });
        const ctx = canvas.getContext('2d')!;
        // Setting width/height also resets the canvas transform.
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${Math.floor(vp.width)}px`;
        canvas.style.height = `${Math.floor(vp.height)}px`;
        const task = page.render({
          canvasContext: ctx,
          viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        tasks.push(task);
        try {
          await task.promise;
        } catch {
          // RenderingCancelledException when a newer render supersedes this one.
          return;
        }

        // Overlay a selectable text layer (transparent positioned glyphs) so
        // users can highlight/copy text from the rendered page.
        const textDiv = textRefs.current[dim.num];
        if (textDiv) {
          textDiv.textContent = ''; // clear any previous render (e.g. on zoom)
          const textLayer = new TextLayer({
            textContentSource: page.streamTextContent(),
            container: textDiv,
            viewport: vp,
          });
          textLayers.push(textLayer);
          try {
            await textLayer.render();
          } catch {
            // cancelled by a newer render
            return;
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const t of tasks) {
        try {
          t.cancel();
        } catch {
          /* already settled */
        }
      }
      for (const tl of textLayers) {
        try {
          tl.cancel();
        } catch {
          /* already settled */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pages]);

  // Forward search: scroll to and flash the highlighted box.
  useEffect(() => {
    if (!highlight) return;
    const wrap = wrapRefs.current[highlight.page];
    if (!wrap) return;
    // synctex gives h (left) and v (baseline) in points; box top = v - H.
    const left = highlight.h * scale;
    const top = Math.max(0, (highlight.v - highlight.H) * scale);
    const w = Math.max(highlight.W * scale, 12);
    const h = Math.max(highlight.H * scale, 12);
    setOverlay({ page: highlight.page, left, top, w, h });
    wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (overlayTimer.current) clearTimeout(overlayTimer.current);
    overlayTimer.current = setTimeout(() => setOverlay(null), 2500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight?.nonce]);

  function handleDoubleClick(e: React.MouseEvent, num: number) {
    const wrap = wrapRefs.current[num];
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const xPt = (e.clientX - rect.left) / scale;
    const yPt = (e.clientY - rect.top) / scale;
    onReverse(num, xPt, yPt);
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <button className="icon-btn" onClick={() => setScale((s) => Math.max(0.4, s - 0.2))} title="Zoom out">
          −
        </button>
        <span className="small">{Math.round(scale * 100)}%</span>
        <button className="icon-btn" onClick={() => setScale((s) => Math.min(3, s + 0.2))} title="Zoom in">
          +
        </button>
        {doc && <span className="small muted">{doc.numPages} page{doc.numPages > 1 ? 's' : ''}</span>}
        <span className="small muted synctex-hint" title="Double-click the PDF to jump to the source line">
          ⤢ dbl-click to sync
        </span>
        {url && (
          <a className="icon-btn" href={url} target="_blank" rel="noreferrer" title="Open PDF in new tab">
            ↗
          </a>
        )}
      </div>
      {error && <div className="banner banner-error">Could not render PDF: {error}</div>}
      {!url && !error && (
        <div className="pdf-empty muted">No PDF yet — press Recompile to build the document.</div>
      )}
      <div className="pdf-pages" ref={scroller}>
        {pages.map((dim) => (
          <div
            key={dim.num}
            className="pdf-page-wrap"
            style={{ width: dim.w, height: dim.h, '--scale-factor': scale } as CSSProperties}
            ref={(el) => (wrapRefs.current[dim.num] = el)}
            onDoubleClick={(e) => handleDoubleClick(e, dim.num)}
            title="Double-click to jump to source"
          >
            <canvas className="pdf-page" ref={(el) => (canvasRefs.current[dim.num] = el)} />
            <div className="textLayer" ref={(el) => (textRefs.current[dim.num] = el)} />
            {overlay && overlay.page === dim.num && (
              <div
                className="pdf-highlight"
                style={{ left: overlay.left, top: overlay.top, width: overlay.w, height: overlay.h }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
