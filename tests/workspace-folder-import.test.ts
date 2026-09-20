import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPlanningFiles } from '../web/src/WorkspaceHome.js';
import { parseWorkspaceImport } from '../server/workspace-import.js';

describe('planning-folder upload', () => {
  it('imports the uploaded demo folder with the same facts and Marriott proposal as the linked-folder flow', async () => {
    const root = fileURLToPath(new URL('../fixtures/demo-event-folder/', import.meta.url));
    const files: File[] = [];
    const visit = (relative = '') => {
      for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const name = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) visit(name);
        else if (entry.isFile()) {
          const file = new File([readFileSync(path.join(root, name))], entry.name);
          Object.defineProperty(file, 'webkitRelativePath', { value: `Ripple Christmas dinner/${name}` });
          files.push(file);
        }
      }
    };
    visit();
    const upload = parseWorkspaceImport({ demo: true, files: await readPlanningFiles(files) });
    const linked = parseWorkspaceImport({ demo: true, files: [] });
    expect(files).toHaveLength(6); expect(upload.facts).toEqual(linked.facts); expect(upload.name).toBe(linked.name);
    const terms = upload.sources.find(source => source.material?.path.endsWith('Marriott proposal.json'))!;
    expect(JSON.parse(terms.content)).toMatchObject({ provenance: 'fictional_scenario', proposal: { venue: 'Boston Marriott Cambridge', venueCostCents: 800000, venueCapacity: 600, venueIncludesAV: true } });
    expect(upload.sources.filter(source => source.material).every(source => source.material!.provenance === 'user_selected')).toBe(true);
  });

  it('skips unsupported exports instead of forwarding a folder the server rejects', async () => {
    const selected = await readPlanningFiles([new File(['Guests: 200'], 'brief.md'), new File(['<p>Preview</p>'], 'preview.html'), new File(['a\tb'], 'export.tsv')]);
    expect(selected).toEqual([{ path: 'brief.md', content: 'Guests: 200' }]);
    await expect(readPlanningFiles([new File(['preview'], 'preview.html')])).rejects.toThrow('planning documents');
  });

  it('rejects an oversized folder before uploading it', async () => {
    await expect(readPlanningFiles(Array.from({ length: 6 }, (_, index) => new File(['x'.repeat(90_000)], `part-${index}.txt`)))).rejects.toThrow('500 KB');
  });
});
