import { describe, expect, it } from 'vitest';
import { substitute, taskFromJson } from './tasks';

describe('taskFromJson', () => {
  it('reads a VS Code shell task with a default build group and Windows overrides', () => {
    const task = taskFromJson(
      {
        label: 'build',
        type: 'shell',
        command: 'make',
        args: ['all', { value: 'two words', quoting: 'strong' }],
        group: { kind: 'build', isDefault: true },
        problemMatcher: ['$gcc'],
        options: { cwd: '${workspaceFolder}/src', env: { MODE: 'debug', SKIP: 1 } },
        windows: { command: 'mingw32-make' },
      },
      'vscode',
    );
    expect(task).toMatchObject({
      label: 'build',
      type: 'shell',
      command: 'mingw32-make',
      args: ['all', 'two words'],
      group: 'build',
      isDefault: true,
      problems: true,
      cwd: '${workspaceFolder}/src',
      env: { MODE: 'debug' },
    });
  });

  it('turns npm and cargo task types into commands', () => {
    expect(taskFromJson({ type: 'npm', script: 'build' }, 'vscode', 'pnpm')).toMatchObject({
      label: 'npm: build',
      command: 'pnpm run build',
    });
    expect(taskFromJson({ type: 'cargo', command: 'test' }, 'vscode')).toMatchObject({
      label: 'cargo test',
      type: 'process',
      command: 'cargo',
      args: ['test'],
      problems: true,
    });
  });

  it('keeps tasks that only depend on others, and skips kinds it cannot run', () => {
    expect(taskFromJson({ label: 'all', dependsOn: ['a', { label: 'b' }] }, 'lathe')).toMatchObject(
      {
        dependsOn: ['a', 'b'],
        command: '',
      },
    );
    expect(taskFromJson({ type: 'gulp', task: 'x' }, 'vscode')).toBeNull();
    expect(taskFromJson({ label: 'empty' }, 'lathe')).toBeNull();
  });
});

describe('substitute', () => {
  const ctx = { root: 'C:\\proj', file: 'C:\\proj\\src\\Main.Test.cpp', shell: null };

  it('fills in the folder and file variables', () => {
    expect(
      substitute(
        '${workspaceFolderBasename}|${relativeFile}|${fileBasenameNoExtension}|${fileExtname}|${fileDirname}',
        ctx,
      ),
    ).toBe('proj|src\\Main.Test.cpp|Main.Test|.cpp|C:\\proj\\src');
  });

  it("writes ${env:NAME} in the shell's own syntax and leaves unknown variables", () => {
    expect(substitute('${env:PATH}', { ...ctx, shell: 'powershell' })).toBe('$env:PATH');
    expect(substitute('${env:PATH}', { ...ctx, shell: 'cmd' })).toBe('%PATH%');
    expect(substitute('${input:thing}', ctx)).toBe('${input:thing}');
  });
});
