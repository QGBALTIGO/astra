/**
 * Render Markdown pipe tables as readable lists on messaging platforms.
 * WhatsApp and Telegram do not natively render Markdown tables.
 */
function parseCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isDivider(line: string, columns: number): boolean {
  const cells = parseCells(line);
  return (
    cells.length === columns && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')))
  );
}

/** Does not modify code blocks or ordinary text containing a pipe. */
export function formatChannelTables(markdown: string): string {
  if (!markdown.includes('|')) return markdown;
  const lines = markdown.split('\n');
  const output: string[] = [];
  let inCode = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```') || line.trimStart().startsWith('~~~')) {
      inCode = !inCode;
      output.push(line);
      continue;
    }

    if (!inCode && line.includes('|') && i + 2 < lines.length) {
      const headers = parseCells(line);
      if (headers.length >= 2 && headers.length <= 12 && isDivider(lines[i + 1]!, headers.length)) {
        const rows: string[][] = [];
        let j = i + 2;
        while (j < lines.length && lines[j]!.trimStart().startsWith('|')) {
          const cells = parseCells(lines[j]!);
          if (cells.length !== headers.length) break;
          rows.push(cells);
          j++;
        }
        if (rows.length > 0) {
          for (const cells of rows) {
            output.push('• **' + (cells[0] || headers[0] || 'Item') + '**');
            for (let col = 1; col < cells.length; col++) {
              if (cells[col])
                output.push('  ' + (headers[col] || 'Campo ' + (col + 1)) + ': ' + cells[col]);
            }
          }
          i = j - 1;
          continue;
        }
      }
    }
    output.push(line);
  }
  return output.join('\n');
}
