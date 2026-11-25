export interface DiffLine {
  kind: "same" | "add" | "remove";
  text: string;
}

export function textLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lcs[i];
    const nextRow = lcs[i + 1];
    if (!row || !nextRow) continue;
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j] ? (nextRow[j + 1] ?? 0) + 1 : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  for (let i = 0, j = 0; i < a.length || j < b.length; ) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && left === right) {
      lines.push({ kind: "same", text: left });
      i++;
      j++;
    } else if (
      right !== undefined &&
      (i === a.length || (lcs[i]?.[j + 1] ?? 0) > (lcs[i + 1]?.[j] ?? 0))
    ) {
      lines.push({ kind: "add", text: right });
      j++;
    } else if (left !== undefined) {
      lines.push({ kind: "remove", text: left });
      i++;
    } else {
      break;
    }
  }
  return lines;
}
