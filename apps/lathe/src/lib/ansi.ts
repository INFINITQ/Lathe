// Plain text from terminal output: colours, cursor moves and titles removed, and a carriage
// return's overwrite applied (progress bars keep only their last state). Problem matching reads
// task output this way.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

const SEQUENCES = new RegExp(
  [
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, // OSC: titles, links, shell marks
    `${ESC}\\[[0-?]*[ -/]*[@-~]`, // CSI: colours, cursor moves, erases
    `${ESC}[()#][0-9A-Za-z]`, // character sets
    `${ESC}[@-Z\\\\-_]`, // other two-character escapes
  ].join('|'),
  'g',
);

export function plainText(raw: string): string {
  return raw
    .replace(SEQUENCES, '')
    .split('\n')
    .map((line) => {
      const text = line.endsWith('\r') ? line.slice(0, -1) : line;
      const cut = text.lastIndexOf('\r');
      return cut >= 0 ? text.slice(cut + 1) : text;
    })
    .join('\n');
}
