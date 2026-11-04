import { useRef } from 'react';
import { Sash } from '../../ui/Sash';
import { EditorGroupView } from './EditorGroup';
import { setGroupSizes, useEditors } from './store';

const MIN_GROUP = 0.12;

/** The editor groups, side by side or stacked, with sashes between them. */
export function EditorArea() {
  const groups = useEditors((s) => s.groups);
  const sizes = useEditors((s) => s.sizes);
  const direction = useEditors((s) => s.direction);
  const box = useRef<HTMLDivElement>(null);
  const startSizes = useRef<number[]>([]);
  const row = direction === 'row';

  return (
    <div
      ref={box}
      className={row ? 'flex h-full min-h-0 w-full' : 'flex h-full min-h-0 w-full flex-col'}
    >
      {groups.map((group, i) => (
        <div key={group.id} className="contents">
          {i > 0 && (
            <Sash
              direction={row ? 'vertical' : 'horizontal'}
              label="Resize editor groups"
              onStart={() => (startSizes.current = [...sizes])}
              onMove={(delta) => {
                const total = row
                  ? (box.current?.clientWidth ?? 1)
                  : (box.current?.clientHeight ?? 1);
                const next = [...startSizes.current];
                const change = delta / total;
                const a = (next[i - 1] ?? 0) + change;
                const b = (next[i] ?? 0) - change;
                if (a < MIN_GROUP || b < MIN_GROUP) return;
                next[i - 1] = a;
                next[i] = b;
                setGroupSizes(next);
              }}
              onReset={() => setGroupSizes(groups.map(() => 1 / groups.length))}
            />
          )}
          <div
            className="flex min-h-0 min-w-0 flex-col"
            style={{ flexBasis: 0, flexGrow: sizes[i] ?? 1 / groups.length }}
          >
            <EditorGroupView group={group} index={i} />
          </div>
        </div>
      ))}
    </div>
  );
}
