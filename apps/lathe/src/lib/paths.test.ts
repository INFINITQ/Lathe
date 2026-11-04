import { describe, expect, it } from 'vitest';
import { basename, dirname, extname, isUnder, join, relative, resolve, samePath } from './paths';

describe('paths', () => {
  it('splits Windows paths with either separator', () => {
    expect(basename('C:\\a\\b.txt')).toBe('b.txt');
    expect(basename('C:/a/b/')).toBe('b');
    expect(dirname('C:\\a\\b.txt')).toBe('C:\\a');
    expect(dirname('C:\\a')).toBe('C:\\');
    expect(dirname('C:\\')).toBe('C:\\');
    expect(extname('Main.PY')).toBe('.py');
    expect(extname('.gitignore')).toBe('');
  });

  it('joins, resolves and relates paths', () => {
    expect(join('C:\\', 'src', 'a.ts')).toBe('C:\\src\\a.ts');
    expect(join('C:\\proj\\', 'src/lib', 'x.rs')).toBe('C:\\proj\\src\\lib\\x.rs');
    expect(resolve('C:\\proj\\src', '..\\README.md')).toBe('C:\\proj\\README.md');
    expect(resolve('C:\\proj', 'D:\\other')).toBe('D:\\other');
    expect(relative('C:\\Proj', 'c:\\proj\\src\\a.ts')).toBe('src/a.ts');
  });

  it('compares paths without case, as Windows does', () => {
    expect(samePath('C:\\Proj\\A.txt', 'c:/proj/a.txt')).toBe(true);
    expect(isUnder('C:\\proj\\src', 'C:\\proj')).toBe(true);
    expect(isUnder('C:\\project', 'C:\\proj')).toBe(false);
    expect(isUnder('C:\\proj', 'C:\\proj')).toBe(true);
  });
});
