import { describe, expect, it } from 'vitest';
import { parseProblems } from './problems';

const CWD = 'C:\\proj';
const where = (output: string) =>
  parseProblems(output, CWD).map(
    (p) => `${p.path}:${p.line}:${p.column} ${p.severity} ${p.message}`,
  );

describe('parseProblems', () => {
  it('reads gcc and clang, skipping notes', () => {
    expect(
      where(
        "src\\main.cpp:3:5: error: 'x' was not declared in this scope\nsrc\\main.cpp:1:1: note: here\nC:\\proj\\a.c:7:2: warning: unused variable 'y'",
      ),
    ).toEqual([
      "C:\\proj\\src\\main.cpp:3:5 error 'x' was not declared in this scope",
      "C:\\proj\\a.c:7:2 warning unused variable 'y'",
    ]);
  });

  it('reads MSVC, C# and plain tsc', () => {
    expect(
      where(
        "C:\\proj\\main.cpp(4): error C2065: 'x': undeclared identifier\nsrc/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      ),
    ).toEqual([
      "C:\\proj\\main.cpp:4:1 error 'x': undeclared identifier",
      "C:\\proj\\src\\a.ts:3:7 error Type 'string' is not assignable to type 'number'.",
    ]);
  });

  it('reads pretty tsc output with colours', () => {
    const e = String.fromCharCode(27);
    expect(
      where(
        `${e}[96msrc/a.ts${e}[0m:${e}[93m3${e}[0m:${e}[93m7${e}[0m - ${e}[91merror${e}[0m ${e}[90mTS2322: ${e}[0mBad type.`,
      ),
    ).toEqual(['C:\\proj\\src\\a.ts:3:7 error Bad type.']);
  });

  it('reads rustc across its two lines', () => {
    expect(
      where('error[E0425]: cannot find value `x` in this scope\n --> src\\main.rs:2:13\n  |'),
    ).toEqual(['C:\\proj\\src\\main.rs:2:13 error cannot find value `x` in this scope']);
  });

  it('reads javac and go', () => {
    expect(where('Hello.java:3: error: cannot find symbol\n./main.go:5:2: undefined: x')).toEqual([
      'C:\\proj\\Hello.java:3:1 error cannot find symbol',
      'C:\\proj\\main.go:5:2 error undefined: x',
    ]);
  });

  it("reads ESLint's stylish format", () => {
    expect(
      where(
        "C:\\proj\\src\\a.js\n  1:7  error  'x' is assigned a value but never used  no-unused-vars\n  2:1  warning  Unexpected console statement  no-console\n\n✖ 2 problems",
      ),
    ).toEqual([
      "C:\\proj\\src\\a.js:1:7 error 'x' is assigned a value but never used",
      'C:\\proj\\src\\a.js:2:1 warning Unexpected console statement',
    ]);
  });

  it('ignores ordinary output', () => {
    expect(where('Compiling lathe v0.1.0\nFinished in 2.3s\nhello world')).toEqual([]);
  });
});
