import { describe, expect, it } from 'vitest';
import { ansiSpans, applyCarriageReturns } from '../lib/ansiSpans';
import { nextOutputs } from './document';
import { type Output, parseNotebook, pythonJson, serializeNotebook, splitLines } from './model';

/** A notebook exactly as nbformat writes it (json.dumps, indent=1, sorted keys). */
const NOTEBOOK = `{
 "cells": [
  {
   "cell_type": "markdown",
   "id": "a1b2c3d4",
   "metadata": {},
   "source": [
    "# Title\\n",
    "\\n",
    "Some *text*, café."
   ]
  },
  {
   "cell_type": "code",
   "execution_count": 2,
   "id": "e5f6a7b8",
   "metadata": {
    "scrolled": true
   },
   "outputs": [
    {
     "name": "stdout",
     "output_type": "stream",
     "text": [
      "2\\n"
     ]
    },
    {
     "data": {
      "image/png": "iVBORw0KGgo=",
      "text/plain": [
       "<Figure size 640x480 with 1 Axes>"
      ]
     },
     "metadata": {},
     "output_type": "display_data"
    },
    {
     "data": {
      "text/plain": [
       "3.0"
      ]
     },
     "execution_count": 2,
     "metadata": {},
     "output_type": "execute_result"
    },
    {
     "ename": "ValueError",
     "evalue": "bad",
     "output_type": "error",
     "traceback": [
      "\\u001b[31mValueError\\u001b[0m: bad"
     ]
    }
   ],
   "source": [
    "print(1+1)\\n",
    "plot()"
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "id": "c9d0e1f2",
   "metadata": {},
   "outputs": [],
   "source": []
  }
 ],
 "metadata": {
  "kernelspec": {
   "display_name": "Python 3 (ipykernel)",
   "language": "python",
   "name": "python3"
  },
  "language_info": {
   "name": "python",
   "version": "3.14.7"
  },
  "widths": [
   1.0,
   2.5e-05
  ]
 },
 "nbformat": 4,
 "nbformat_minor": 5
}
`;

describe('notebooks', () => {
  it('save back byte for byte when nothing changed', () => {
    expect(serializeNotebook(parseNotebook(NOTEBOOK))).toBe(NOTEBOOK);
  });

  it('read cells, joining their lines', () => {
    const notebook = parseNotebook(NOTEBOOK);
    expect(notebook.cells.map((c) => c.cell_type)).toEqual(['markdown', 'code', 'code']);
    expect(notebook.cells[0]!.source).toBe('# Title\n\nSome *text*, café.');
    expect(notebook.cells[1]!.source).toBe('print(1+1)\nplot()');
    expect(notebook.cells[1]!.outputs[0]).toEqual({
      output_type: 'stream',
      name: 'stdout',
      text: '2\n',
    });
    expect(notebook.cells[1]!.execution_count).toBe(2);
  });

  it('write an edit as Jupyter would', () => {
    const notebook = parseNotebook(NOTEBOOK);
    notebook.cells[2]!.source = 'x = 1\ny = 2\n';
    notebook.cells[2]!.execution_count = 3;
    const text = serializeNotebook(notebook);
    expect(text).toContain('"execution_count": 3,');
    expect(text).toContain('   "source": [\n    "x = 1\\n",\n    "y = 2\\n"\n   ]');
    expect(serializeNotebook(parseNotebook(text))).toBe(text);
  });

  it('refuse files that are not nbformat 4', () => {
    expect(() => parseNotebook('{"nbformat": 3, "worksheets": []}')).toThrow('nbformat 3');
    expect(() => parseNotebook('{"hello": 1}')).toThrow("isn't a Jupyter notebook");
  });

  it('split lines as Python does', () => {
    expect(splitLines('a\nb\r\nc\rd')).toEqual(['a\n', 'b\r\n', 'c\r', 'd']);
    expect(splitLines('x\n')).toEqual(['x\n']);
    expect(splitLines('')).toEqual([]);
  });

  it('write JSON as Python does', () => {
    expect(pythonJson({ b: [], a: {}, c: 'é\u0001' })).toBe(
      '{\n "a": {},\n "b": [],\n "c": "é\\u0001"\n}',
    );
  });
});

describe('ANSI output', () => {
  it('turns colour codes into styled spans', () => {
    expect(ansiSpans('\x1b[31mred\x1b[0m plain \x1b[1;38;5;208mbold orange\x1b[22m!')).toEqual([
      { text: 'red', color: 'var(--ansi-1)' },
      { text: ' plain ' },
      { text: 'bold orange', bold: true, color: 'rgb(255,135,0)' },
      { text: '!', color: 'rgb(255,135,0)' },
    ]);
  });

  it('shows what a carriage return leaves on the line', () => {
    expect(applyCarriageReturns('10%\r50%\r100%\ndone\r\n')).toBe('100%\ndone\n');
  });
});

describe('kernel output', () => {
  it('joins printing that arrives in pieces, and clears when asked', () => {
    const state = { clear: false };
    let outputs: Output[] = [];
    outputs = nextOutputs(outputs, 'stream', { name: 'stdout', text: 'a' }, state);
    outputs = nextOutputs(outputs, 'stream', { name: 'stdout', text: 'b\n' }, state);
    outputs = nextOutputs(outputs, 'stream', { name: 'stderr', text: 'oops\n' }, state);
    expect(outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'ab\n' },
      { output_type: 'stream', name: 'stderr', text: 'oops\n' },
    ]);
    // clear_output(wait=True) keeps the old output until the next one arrives.
    outputs = nextOutputs(outputs, 'clear_output', { wait: true }, state);
    expect(outputs).toHaveLength(2);
    outputs = nextOutputs(outputs, 'stream', { name: 'stdout', text: 'fresh' }, state);
    expect(outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: 'fresh' }]);
  });
});
