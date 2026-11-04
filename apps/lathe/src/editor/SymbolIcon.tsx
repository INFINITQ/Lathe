import {
  Box,
  Boxes,
  Braces,
  Hammer,
  Hash,
  Heading1,
  Key,
  ListOrdered,
  type LucideIcon,
  Package,
  Pi,
  Shapes,
  SquareFunction,
  Type,
  Variable,
  Wrench,
} from 'lucide-react';
import { cn } from '../lib/cn';
import type { SymbolKind } from './symbols';

/** An icon and colour per kind: types warm, functions in the accent, values cool. */
const ICONS: Record<SymbolKind, [LucideIcon, string]> = {
  class: [Box, 'text-warning'],
  struct: [Boxes, 'text-warning'],
  interface: [Shapes, 'text-warning'],
  enum: [ListOrdered, 'text-warning'],
  type: [Type, 'text-warning'],
  function: [SquareFunction, 'text-accent-fg'],
  method: [SquareFunction, 'text-accent-fg'],
  constructor: [Hammer, 'text-accent-fg'],
  property: [Wrench, 'text-info'],
  variable: [Variable, 'text-info'],
  constant: [Pi, 'text-info'],
  key: [Key, 'text-info'],
  module: [Package, 'text-text-3'],
  namespace: [Braces, 'text-text-3'],
  selector: [Hash, 'text-text-3'],
  heading: [Heading1, 'text-text-3'],
};

export function SymbolIcon({ kind, className }: { kind: SymbolKind; className?: string }) {
  const [Icon, colour] = ICONS[kind];
  return (
    <Icon
      className={cn('size-3.5 shrink-0', colour, className)}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  );
}
