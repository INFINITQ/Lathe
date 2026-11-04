// Notebook and # %% cell commands for the palette. Keys inside a notebook (Shift+Enter, A, B,
// D D…) are handled by the notebook editor itself.

import { getActiveView } from '../editor/active';
import { backend, errorMessage } from '../lib/backend';
import { join } from '../lib/paths';
import { type Command, registerCommands } from '../services/commands';
import { notify } from '../services/notifications';
import { activeTab, openPath } from '../workbench/editors/store';
import { showPanel } from '../workbench/layout';
import { useWorkspace } from '../workbench/workspaceStore';
import { type NotebookDoc, focusCell, notebookFor } from './document';
import { clearInteractive, interactiveSession, runActiveCell } from './interactive';
import { emptyNotebook, serializeNotebook } from './model';

export function activeNotebook(): NotebookDoc | null {
  const { tab, doc } = activeTab();
  return tab?.kind === 'notebook' && doc ? notebookFor(doc) : null;
}

function onNotebook(run: (nb: NotebookDoc) => unknown) {
  return () => {
    const nb = activeNotebook();
    if (!nb) {
      notify('info', 'Open a notebook (.ipynb) first.');
      return;
    }
    void run(nb);
  };
}

/** Creates an empty notebook where you choose, and opens it. */
export async function newNotebook() {
  const root = useWorkspace.getState().root;
  const picked = await backend().dialogs.saveAs(
    root ? join(root, 'Untitled.ipynb') : 'Untitled.ipynb',
  );
  if (!picked) return;
  const path = /\.ipynb$/i.test(picked) ? picked : `${picked}.ipynb`;
  try {
    const format = await backend().fs.newFileFormat(path);
    await backend().fs.writeText(path, serializeNotebook(emptyNotebook()), format, null, false);
    await openPath(path);
  } catch (err) {
    notify('error', "Couldn't create the notebook.", { detail: errorMessage(err) });
  }
}

function addCell(nb: NotebookDoc, type: 'code' | 'markdown') {
  const at = nb.selected ? nb.indexOf(nb.selected) + 1 : nb.notebook.cells.length;
  const key = nb.insertCell(at, type);
  nb.select(key, true);
  focusCell(nb, key);
}

export function registerNotebookCommands() {
  const commands: Command[] = [
    {
      id: 'notebook.new',
      title: 'New Jupyter notebook…',
      category: 'File',
      run: () => void newNotebook(),
    },
    {
      id: 'notebook.runAll',
      title: 'Run all cells',
      category: 'Notebook',
      run: onNotebook((nb) => nb.runAll()),
    },
    {
      id: 'notebook.runCell',
      title: 'Run the selected cell',
      category: 'Notebook',
      run: onNotebook((nb) => nb.selected && nb.run([nb.selected])),
    },
    {
      id: 'notebook.runAbove',
      title: 'Run the cells above',
      category: 'Notebook',
      run: onNotebook((nb) => {
        const at = nb.selected ? nb.indexOf(nb.selected) : 0;
        return nb.run(nb.notebook.cells.slice(0, at).map((c) => c.key));
      }),
    },
    {
      id: 'notebook.runBelow',
      title: 'Run the selected cell and those below',
      category: 'Notebook',
      run: onNotebook((nb) => {
        const at = nb.selected ? nb.indexOf(nb.selected) : 0;
        return nb.run(nb.notebook.cells.slice(at).map((c) => c.key));
      }),
    },
    {
      id: 'notebook.interrupt',
      title: 'Interrupt the kernel',
      category: 'Notebook',
      run: onNotebook((nb) => nb.interrupt()),
    },
    {
      id: 'notebook.restart',
      title: 'Restart the kernel',
      category: 'Notebook',
      run: onNotebook((nb) => nb.restart()),
    },
    {
      id: 'notebook.restartAndRunAll',
      title: 'Restart the kernel and run all cells',
      category: 'Notebook',
      run: onNotebook((nb) => nb.restartAndRunAll()),
    },
    {
      id: 'notebook.clearOutputs',
      title: 'Clear all outputs',
      category: 'Notebook',
      run: onNotebook((nb) => nb.clearOutputs()),
    },
    {
      id: 'notebook.selectKernel',
      title: 'Select a kernel',
      category: 'Notebook',
      run: onNotebook((nb) => nb.selectKernel()),
    },
    {
      id: 'notebook.addCodeCell',
      title: 'Add a code cell',
      category: 'Notebook',
      run: onNotebook((nb) => addCell(nb, 'code')),
    },
    {
      id: 'notebook.addMarkdownCell',
      title: 'Add a Markdown cell',
      category: 'Notebook',
      run: onNotebook((nb) => addCell(nb, 'markdown')),
    },
    {
      id: 'interactive.runCell',
      title: 'Run the # %% cell at the cursor',
      category: 'Python',
      run: () => runActiveCell(getActiveView(), activeTab().doc),
    },
    {
      id: 'interactive.restart',
      title: 'Restart the interactive kernel',
      category: 'Python',
      run: () => void interactiveSession()?.restart(),
    },
    {
      id: 'interactive.interrupt',
      title: 'Interrupt the interactive kernel',
      category: 'Python',
      run: () => void interactiveSession()?.interrupt(),
    },
    {
      id: 'interactive.clear',
      title: 'Clear the Interactive panel',
      category: 'Python',
      run: () => clearInteractive(),
    },
    {
      id: 'view.interactive',
      title: 'Show the Interactive panel',
      category: 'View',
      run: () => showPanel('interactive', true),
    },
  ];
  registerCommands(commands);
}
