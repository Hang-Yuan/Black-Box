export interface ResponseArtifact { id: string; name: string; language: string; content: string }

/** Only complete fenced blocks become artifacts. Partial streaming code stays visible. */
export function extractResponseArtifacts(markdown: string): { markdown: string; artifacts: ResponseArtifact[] } {
  const artifacts: ResponseArtifact[] = [];
  const transformed = markdown.replace(/^([ \t]{0,3})(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n[ \t]{0,3}\2([`~]*)[ \t]*(?=\n|$)/gm,
    (whole, _indent: string, fence: string, info: string, code: string, extraFence: string, position: number) => {
      if ([...extraFence].some((character) => character !== fence[0])) return whole;
      if (code.length < 1800 && code.split('\n').length < 35) return whole;
      const language = info.trim().split(/\s+/)[0] || 'text';
      const explicit = info.match(/(?:file(?:name)?|title)=["']?([^\s"']+)/i)?.[1];
      const heading = markdown.slice(0, position).match(/(?:^|\n)(?:#{1,6}\s+)?`?([^\n`]+\.[a-z0-9]{1,8})`?\s*\n*$/i)?.[1];
      const extensions: Record<string, string> = { javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', shell: 'sh', yaml: 'yaml', sql: 'sql', json: 'json', rust: 'rs', text: 'txt' };
      const suggested = explicit || heading || `artifact-${artifacts.length + 1}.${extensions[language] || language.replace(/[^a-z0-9]/gi, '') || 'txt'}`;
      const name = suggested.replace(/^[\/\\]+/, '').split(/[\/\\]/).filter((part: string) => part !== '..' && part !== '.').join('/') || 'artifact.txt';
      const id = `artifact-${artifacts.length + 1}`;
      artifacts.push({ id, name, language, content: code + '\n' });
      return `\n> 📄 **${name}** · ${code.split('\n').length} lines · Artifact\n`;
    });
  return { markdown: transformed, artifacts };
}
