/** Parse real level-two Markdown sections; fenced examples cannot declare required sections. */
export function reportSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = markdown
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  let section: string | undefined;
  let fence: { character: string; length: number } | undefined;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined;
      continue;
    }
    const heading = !fence && /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      if (sections.has(section)) throw new Error(`Duplicate report section: ${section}`);
      sections.set(section, '');
    } else if (section) {
      sections.set(section, sections.get(section)! + line + '\n');
    }
  }
  return sections;
}

export function hasReportContent(content: string): boolean {
  const text = content
    .replace(/^#{1,6}\s.*$/gm, '')
    .replace(/\{\{[\s\S]*?\}\}/g, '')
    .trim();
  return Boolean(text) && !/^(?:TODO|TBD|N\/A|[-*\s])+[.!]?$/i.test(text);
}
