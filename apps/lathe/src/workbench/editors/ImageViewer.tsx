import { useEffect, useState } from 'react';
import { backend, errorMessage } from '../../lib/backend';
import { basename, extname } from '../../lib/paths';

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/** Shows an image file on a checkerboard; click to switch between fit and actual size. */
export function ImageViewer({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState(true);
  const [size, setSize] = useState<{ w: number; h: number; bytes: number } | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    backend()
      .fs.readBytes(path)
      .then((bytes) => {
        if (revoked) return;
        const blob = new Blob([bytes], {
          type: TYPES[extname(path)] ?? 'application/octet-stream',
        });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setSize((s) => ({ w: s?.w ?? 0, h: s?.h ?? 0, bytes: bytes.byteLength }));
      })
      .catch((err: unknown) => setError(errorMessage(err)));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (error) {
    return <div className="grid h-full place-items-center text-[12px] text-text-3">{error}</div>;
  }
  return (
    <div className="flex h-full flex-col">
      <div
        className="image-checker grid min-h-0 flex-1 cursor-zoom-in place-items-center overflow-auto"
        onClick={() => setFit((f) => !f)}
      >
        {url && (
          <img
            src={url}
            alt={basename(path)}
            className={fit ? 'max-h-full max-w-full object-contain' : 'max-w-none'}
            style={{ imageRendering: fit ? 'auto' : 'pixelated' }}
            onLoad={(e) =>
              setSize((s) => ({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
                bytes: s?.bytes ?? 0,
              }))
            }
          />
        )}
      </div>
      {size && (
        <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line px-3 text-[11px] text-text-3">
          <span>
            {size.w} × {size.h}
          </span>
          <span>{formatBytes(size.bytes)}</span>
          <span className="flex-1" />
          <span>{fit ? 'Fit' : '100%'}</span>
        </div>
      )}
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
