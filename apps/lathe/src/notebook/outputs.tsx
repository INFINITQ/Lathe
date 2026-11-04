// A code cell's outputs: printed text and tracebacks (with their ANSI colours), and rich output
// by the richest type it offers: HTML (inline when it has no scripts, else in the sandboxed
// lathe-output frame), SVG, PNG/JPEG/GIF, Markdown, JSON, then plain text.

import { marked } from 'marked';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type AnsiSpan, ansiSpans, applyCarriageReturns } from '../lib/ansiSpans';
import { cn } from '../lib/cn';
import { sanitizeHTML } from '../lsp/sanitize';
import { type MimeBundle, type Output, joinText } from './model';

function spanStyle(span: AnsiSpan): React.CSSProperties | undefined {
  if (!span.color && !span.background && !span.bold && !span.dim && !span.italic && !span.underline)
    return undefined;
  return {
    color: span.color,
    backgroundColor: span.background,
    fontWeight: span.bold ? 600 : undefined,
    opacity: span.dim ? 0.7 : undefined,
    fontStyle: span.italic ? 'italic' : undefined,
    textDecoration: span.underline ? 'underline' : undefined,
  };
}

export function Ansi({ text }: { text: string }) {
  const spans = useMemo(() => ansiSpans(text), [text]);
  return (
    <>
      {spans.map((span, i) => (
        <span key={i} style={spanStyle(span)}>
          {span.text}
        </span>
      ))}
    </>
  );
}

/** Markdown (a cell, or a text/markdown output), sanitized; images may be embedded ones. */
export function renderMarkdown(source: string, attachments?: Record<string, MimeBundle>): string {
  let html = marked.parse(source, { async: false, gfm: true, breaks: false });
  if (attachments) {
    html = html.replace(/attachment:([^"'\s)]+)/g, (whole, name: string) => {
      const bundle = attachments[decodeURIComponent(name)];
      const mime = bundle && Object.keys(bundle).find((m) => m.startsWith('image/'));
      return mime ? `data:${mime};base64,${joinText(bundle[mime]).replace(/\s/g, '')}` : whole;
    });
  }
  return sanitizeHTML(html, { images: true });
}

const OUTPUT_FRAME = 'http://lathe-output.localhost/';

/** HTML with scripts runs in the sandboxed output frame, which grows to fit it. */
function HtmlFrame({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(24);
  useEffect(() => {
    const dark = document.documentElement.dataset.theme !== 'light';
    const send = () => frame.current?.contentWindow?.postMessage({ html, dark }, '*');
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { latheReady?: boolean; latheHeight?: number } | null;
      if (data?.latheReady) send();
      if (typeof data?.latheHeight === 'number') {
        setHeight(Math.min(Math.max(data.latheHeight, 16), 4000));
      }
    };
    window.addEventListener('message', onMessage);
    send();
    return () => window.removeEventListener('message', onMessage);
  }, [html]);
  return (
    <iframe
      ref={frame}
      title="HTML output"
      src={OUTPUT_FRAME}
      sandbox="allow-scripts"
      className="block w-full border-0"
      style={{ height }}
    />
  );
}

const ORDER = [
  'text/html',
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'text/markdown',
  'text/latex',
  'application/json',
  'text/plain',
];

function imageWidth(metadata: Record<string, unknown>, mime: string): number | undefined {
  const own = metadata[mime] as { width?: unknown } | undefined;
  return typeof own?.width === 'number' ? own.width : undefined;
}

export function RichOutput({
  data,
  metadata,
}: {
  data: MimeBundle;
  metadata: Record<string, unknown>;
}) {
  const widget = 'application/vnd.jupyter.widget-view+json' in data;
  const mime = ORDER.find((m) => m in data) ?? Object.keys(data)[0];
  if (!mime) return null;
  const value = data[mime];
  let body: React.ReactNode;
  if (mime === 'text/html') {
    const html = joinText(value);
    body = /<script[\s>]/i.test(html) ? (
      <HtmlFrame html={html} />
    ) : (
      <div
        className="nb-html"
        dangerouslySetInnerHTML={{ __html: sanitizeHTML(html, { images: true }) }}
      />
    );
  } else if (mime === 'image/svg+xml') {
    body = (
      <img
        alt="SVG output"
        className="max-w-full"
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(joinText(value))}`}
      />
    );
  } else if (mime.startsWith('image/')) {
    body = (
      <img
        alt="Image output"
        className="max-w-full rounded-sm"
        style={{ width: imageWidth(metadata, mime) }}
        src={`data:${mime};base64,${joinText(value).replace(/\s/g, '')}`}
      />
    );
  } else if (mime === 'text/markdown') {
    body = (
      <div
        className="nb-markdown"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(joinText(value)) }}
      />
    );
  } else if (mime === 'application/json' || mime.endsWith('+json')) {
    body = <pre className="nb-pre">{JSON.stringify(value, null, 2)}</pre>;
  } else {
    body = (
      <pre className="nb-pre">
        <Ansi text={joinText(value)} />
      </pre>
    );
  }
  return (
    <div data-mime={mime}>
      {widget && (
        <p className="text-[11px] text-text-3">Interactive widgets aren't supported yet.</p>
      )}
      {body}
    </div>
  );
}

function OutputView({ output }: { output: Output }) {
  if (output.output_type === 'stream') {
    return (
      <pre
        className={cn('nb-pre', output.name === 'stderr' && 'nb-stderr')}
        data-stream={output.name}
      >
        <Ansi text={applyCarriageReturns(output.text)} />
      </pre>
    );
  }
  if (output.output_type === 'error') {
    const text = output.traceback.length
      ? output.traceback.join('\n')
      : `${output.ename}: ${output.evalue}`;
    return (
      <pre className="nb-pre nb-error" data-error={output.ename}>
        <Ansi text={text} />
      </pre>
    );
  }
  return <RichOutput data={output.data} metadata={output.metadata} />;
}

export function Outputs({ outputs }: { outputs: Output[] }) {
  return (
    <div role="group" aria-label="Output" className="nb-outputs space-y-1.5">
      {outputs.map((output, i) => (
        <OutputView key={i} output={output} />
      ))}
    </div>
  );
}
