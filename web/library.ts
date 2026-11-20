import { isCategoryPath, type RecordData } from '../src/records/core.ts';

export type CategoryNode = {
  label: string;
  path: string[];
  records: RecordData[];
  children: CategoryNode[];
};

const dayLabel = new Intl.DateTimeFormat('ko-KR', {dateStyle: 'full'});
const collator = new Intl.Collator('ko-KR', {numeric: true});

function groups(records: readonly RecordData[], getPath: (record: RecordData) => string[] | undefined, folders: readonly string[][] = []): CategoryNode[] {
  const roots: CategoryNode[] = [];
  function insert(path: string[], record?: RecordData) {
    let siblings = roots;
    for (const [depth, label] of path.entries()) {
      let group = siblings.find(node => node.label === label);
      if (!group) {
        group = { label, path: path.slice(0, depth + 1), records: [], children: [] };
        siblings.push(group);
      }
      if (record && depth === path.length - 1) group.records.push(record);
      siblings = group.children;
    }
  }
  for (const folder of folders) if (isCategoryPath(folder)) insert(folder);
  for (const record of records) {
    const path = getPath(record);
    if (path) insert(path, record);
  }
  return roots;
}

function ordered(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.sort((a, b) => collator.compare(a.label, b.label))
    .map(node => ({ ...node, children: ordered(node.children) }));
}

export function categoryTree(records: readonly RecordData[], mode: 'date' | 'category' = 'category', folders: readonly string[][] = []): CategoryNode[] {
  const sorted = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  if (mode === 'date') return groups(sorted, record => [dayLabel.format(new Date(record.createdAt))]);
  const nodes = ordered(groups(sorted, record => isCategoryPath(record.category) ? record.category : undefined, folders));
  const unclassified = sorted.filter(record => !isCategoryPath(record.category));
  return unclassified.length ? [...nodes, {label: '미분류', path: [], records: unclassified, children: []}] : nodes;
}
