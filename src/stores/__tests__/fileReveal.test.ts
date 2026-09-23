import { describe, it, expect } from 'vitest';
import {
  ancestorResolutionBases,
  classifyPathToken,
  computeRevealExpansions,
  findBestWorkspaceSearchMatch,
  findDirectoryLandingFile,
  findNodeByPath,
  findUniqueNodeByBasename,
  normalizeFileReferencePath,
  normalizePath,
  parseFileReference,
  reconcilePathToRoot,
  resolvePathToken,
  slugifyHeading,
} from '../fileReveal';
import type { FileNode } from '../../lib/tauri-bridge';

describe('normalizePath', () => {
  it('去掉末尾斜杠（含多个）', () => {
    expect(normalizePath('/a/b/')).toBe('/a/b');
    expect(normalizePath('/a/b///')).toBe('/a/b');
  });
  it('没有末尾斜杠时原样返回', () => {
    expect(normalizePath('/a/b')).toBe('/a/b');
  });
  it('根斜杠保留', () => {
    expect(normalizePath('/')).toBe('/');
  });
});

describe('ancestorResolutionBases', () => {
  it('从消息 cwd 逐级回溯到工作区边界', () => {
    expect(ancestorResolutionBases(
      '/workspace/Dev/enterprise-brain-v1/runs/20260920-c-repair',
      '/workspace',
    )).toEqual([
      '/workspace/Dev/enterprise-brain-v1/runs/20260920-c-repair',
      '/workspace/Dev/enterprise-brain-v1/runs',
      '/workspace/Dev/enterprise-brain-v1',
      '/workspace/Dev',
      '/workspace',
    ]);
  });
});

// 聊天里点一个路径引用块 → 要在右侧文件树里展开到它。
// computeRevealExpansions 算出「为此需要展开哪些文件夹」，再喂给 fileStore。
describe('computeRevealExpansions（定位时要展开哪些祖先文件夹）', () => {
  const root = '/root';

  it('深层文件：展开各级父目录，不含文件自身', () => {
    expect(computeRevealExpansions('/root/a/b/c.md', root, false))
      .toEqual(['/root/a', '/root/a/b']);
  });

  it('深层文件夹：展开各级父目录 + 文件夹自身', () => {
    expect(computeRevealExpansions('/root/a/b/c', root, true))
      .toEqual(['/root/a', '/root/a/b', '/root/a/b/c']);
  });

  it('文件夹路径带末尾斜杠也能正确处理', () => {
    expect(computeRevealExpansions('/root/a/b/c/', root, true))
      .toEqual(['/root/a', '/root/a/b', '/root/a/b/c']);
  });

  it('中文 + 数字前缀路径（真实工作间形态）', () => {
    expect(computeRevealExpansions('/root/01_Her/02_创业系统/_增长线/', root, true))
      .toEqual(['/root/01_Her', '/root/01_Her/02_创业系统', '/root/01_Her/02_创业系统/_增长线']);
  });

  it('顶层文件：没有需要展开的祖先', () => {
    expect(computeRevealExpansions('/root/x.md', root, false)).toEqual([]);
  });

  it('顶层文件夹：只展开它自身', () => {
    expect(computeRevealExpansions('/root/x', root, true)).toEqual(['/root/x']);
  });

  it('目标就是根：返回空', () => {
    expect(computeRevealExpansions('/root', root, false)).toEqual([]);
  });

  it('目标不在根之下：返回空（无法定位）', () => {
    expect(computeRevealExpansions('/other/a', root, true)).toEqual([]);
  });

  it('root 带末尾斜杠也兼容', () => {
    expect(computeRevealExpansions('/root/a/b', '/root/', true))
      .toEqual(['/root/a', '/root/a/b']);
  });

  it('前缀相近但不是真子路径（/root2 不算 /root 的下级）', () => {
    expect(computeRevealExpansions('/root2/a', root, true)).toEqual([]);
  });
});

describe('findNodeByPath（按绝对路径在树里找节点）', () => {
  const tree: FileNode[] = [
    { name: '01_Her', path: '/root/01_Her', is_dir: true, children: [
      { name: '02_创业系统', path: '/root/01_Her/02_创业系统', is_dir: true, children: [
        { name: '_增长线', path: '/root/01_Her/02_创业系统/_增长线', is_dir: true, children: [] },
        { name: 'a.md', path: '/root/01_Her/02_创业系统/a.md', is_dir: false, children: null },
      ] },
    ] },
    { name: 'readme.md', path: '/root/readme.md', is_dir: false, children: null },
  ];

  it('找到深层文件夹', () => {
    expect(findNodeByPath(tree, '/root/01_Her/02_创业系统/_增长线')?.is_dir).toBe(true);
  });
  it('找到深层文件', () => {
    expect(findNodeByPath(tree, '/root/01_Her/02_创业系统/a.md')?.is_dir).toBe(false);
  });
  it('目标带末尾斜杠也能匹配', () => {
    expect(findNodeByPath(tree, '/root/01_Her/02_创业系统/_增长线/')?.name).toBe('_增长线');
  });
  it('顶层文件', () => {
    expect(findNodeByPath(tree, '/root/readme.md')?.is_dir).toBe(false);
  });
  it('找不到返回 null', () => {
    expect(findNodeByPath(tree, '/root/不存在/x')).toBe(null);
  });
});

// 聊天里反引号包的文本，要判断成 文件 / 文件夹 / 都不是。
// 关键诉求：支持中文路径（旧规则只认英文前缀路径，中文一律漏判）。
describe('classifyPathToken（判断反引号内是不是路径）', () => {
  it('中文相对路径文件 → file', () => {
    expect(classifyPathToken('01_Her/02_创业系统/_增长线/6.7看板.html')).toBe('file');
  });
  it('中文裸文件名 → file', () => {
    expect(classifyPathToken('数据05-31.html')).toBe('file');
  });
  it('英文裸文件名 → file', () => {
    expect(classifyPathToken('package.json')).toBe('file');
  });
  it('中文文件夹（末尾斜杠）→ folder', () => {
    expect(classifyPathToken('01_Her/02_创业系统/_增长线/')).toBe('folder');
  });
  it('普通行内代码 useState → null', () => {
    expect(classifyPathToken('useState')).toBe(null);
  });
  it('Math.PI 不是已知扩展名 → null', () => {
    expect(classifyPathToken('Math.PI')).toBe(null);
  });
  it('含空格的全路径 → file', () => {
    expect(classifyPathToken('/Users/x/Mobile Documents/a/6.7看板.html')).toBe('file');
  });
  it('单字符 → null', () => {
    expect(classifyPathToken('a')).toBe(null);
  });
  // 前缀检测（#110）：有明确路径前缀时，扩展名可选
  it('项目目录前缀 + 无扩展名 → file', () => {
    expect(classifyPathToken('src/build')).toBe('file');
  });
  it('相对前缀 ./ + 无扩展名 → file', () => {
    expect(classifyPathToken('./scripts/deploy')).toBe('file');
  });
  it('隐藏目录前缀 .claude/ → file', () => {
    expect(classifyPathToken('.claude/settings.local')).toBe('file');
  });
  it('隐藏目录自身（末尾斜杠）→ folder', () => {
    expect(classifyPathToken('.github/')).toBe('folder');
  });
  it('盘符前缀 + 无扩展名 → file', () => {
    expect(classifyPathToken('C:\\Users\\x\\bin')).toBe('file');
  });
  it('绝对路径 + 无扩展名 → file', () => {
    expect(classifyPathToken('/usr/local/bin/claude')).toBe('file');
  });
});

describe('parseFileReference（统一解析聊天与 Markdown 本地引用）', () => {
  const base = '/Users/example/Workspace/Assistant/Projects/AgentApp';

  it('支持中文、空格和反引号内常见的相对路径', () => {
    expect(parseFileReference('设计 文档/阶段 一.md', { basePath: base })).toMatchObject({
      path: `${base}/设计 文档/阶段 一.md`,
      kind: 'file',
    });
  });

  it('支持 ~、:line 和 :column', () => {
    expect(parseFileReference('~/Workspace/Assistant/说明.md:12:4', { basePath: base })).toMatchObject({
      path: '/Users/example/Workspace/Assistant/说明.md',
      line: 12,
      column: 4,
    });
  });

  it('支持相对路径、dot segments 和 #Lx-Ly', () => {
    expect(parseFileReference('../docs/指南.md#L8-L13', { basePath: base })).toMatchObject({
      path: '/Users/example/Workspace/Assistant/Projects/docs/指南.md',
      line: 8,
      endLine: 13,
    });
  });

  it('支持 Markdown heading anchor', () => {
    expect(parseFileReference('README.md#安装说明', { basePath: base })).toMatchObject({
      path: `${base}/README.md`,
      anchor: '安装说明',
    });
  });

  it('fragment-only 引用定位当前预览文件', () => {
    expect(parseFileReference('#安装说明', {
      basePath: base,
      sourcePath: `${base}/README.md`,
      explicit: true,
    })).toMatchObject({
      path: `${base}/README.md`,
      anchor: '安装说明',
    });
  });

  it('支持尖括号包裹、百分号编码与 file URI', () => {
    expect(parseFileReference('<file:///Users/example/My%20Docs/a.md#L2>')).toMatchObject({
      path: '/Users/example/My Docs/a.md',
      line: 2,
    });
  });

  it('Markdown 显式相对链接可引用无扩展名文件', () => {
    expect(parseFileReference('docs/README', { basePath: base, explicit: true })?.path)
      .toBe(`${base}/docs/README`);
  });

  it('拒绝外部 URL、域名与普通行内代码', () => {
    expect(parseFileReference('https://example.com/a.md', { explicit: true })).toBe(null);
    expect(parseFileReference('obsidian://open?vault=Notes', { explicit: true })).toBe(null);
    expect(parseFileReference('example.com', { explicit: true })).toBe(null);
    expect(parseFileReference('useState')).toBe(null);
    expect(parseFileReference('Math.PI')).toBe(null);
  });

  it('识别 Office 文件扩展名', () => {
    expect(parseFileReference('报表.xlsx')?.kind).toBe('file');
    expect(parseFileReference('路演.pptx')?.kind).toBe('file');
  });

  it('不把无语言 fenced code 中的多行结构树识别成一个文件', () => {
    expect(parseFileReference('AgentSync/\n├── Workspace/\n└── Agent_Merak/')).toBe(null);
  });
});

describe('历史路径恢复与目录落地文件', () => {
  const tree: FileNode[] = [
    {
      name: '01 Projects Zone',
      path: '/root/01 Projects Zone',
      is_dir: true,
      children: [{
        name: 'Cognitive_Theory',
        path: '/root/01 Projects Zone/Cognitive_Theory',
        is_dir: true,
        children: [
          {
            name: '_overview.md',
            path: '/root/01 Projects Zone/Cognitive_Theory/_overview.md',
            is_dir: false,
            children: null,
          },
          {
            name: '_index.md',
            path: '/root/01 Projects Zone/Cognitive_Theory/_index.md',
            is_dir: false,
            children: null,
          },
        ],
      }],
    },
  ];

  it('父目录改名后以唯一 basename 找回目标', () => {
    expect(findUniqueNodeByBasename(
      tree,
      '/root/01 Projects/Cognitive_Theory',
    )?.path).toBe('/root/01 Projects Zone/Cognitive_Theory');
  });

  it('basename 重名时拒绝猜测', () => {
    const ambiguous = [
      ...tree,
      {
        name: 'Cognitive_Theory',
        path: '/root/archive/Cognitive_Theory',
        is_dir: true,
        children: [],
      },
    ] satisfies FileNode[];
    expect(findUniqueNodeByBasename(
      ambiguous,
      '/root/legacy/Cognitive_Theory',
    )).toBe(null);
  });

  it('目录点击优先展示 _overview.md', () => {
    const directory = findUniqueNodeByBasename(tree, '/root/Cognitive_Theory');
    expect(directory && findDirectoryLandingFile(directory)?.name).toBe('_overview.md');
  });
});

describe('全工作区裸文件名恢复', () => {
  const matches = [
    {
      name: '00.memory_agent.md',
      path: '/root/Workspace/00 Focus Zone/_archive/smoke/00.memory_agent.md',
      relative_dir: 'Workspace/00 Focus Zone/_archive/smoke',
      is_dir: false,
    },
    {
      name: '00.memory_agent.md',
      path: '/root/PGH/harness/tests/00.memory_agent.md',
      relative_dir: 'PGH/harness/tests',
      is_dir: false,
    },
    {
      name: '00.memory_agent.md',
      path: '/root/Agent_Alkaid/MEMORY/00.memory_agent.md',
      relative_dir: 'Agent_Alkaid/MEMORY',
      is_dir: false,
    },
  ];

  it('裸文件名优先恢复到唯一的浅层现役文件', () => {
    expect(findBestWorkspaceSearchMatch(
      matches,
      '/root/00.memory_agent.md',
      'file',
    )?.path).toBe('/root/Agent_Alkaid/MEMORY/00.memory_agent.md');
  });

  it('完整历史后缀优先于较浅的同名文件', () => {
    expect(findBestWorkspaceSearchMatch([
      ...matches,
      {
        name: '00.memory_agent.md',
        path: '/root/Agent_Merak/00.memory_agent.md',
        relative_dir: 'Agent_Merak',
        is_dir: false,
      },
    ], '/old/Agent_Alkaid/MEMORY/00.memory_agent.md', 'file')?.path)
      .toBe('/root/Agent_Alkaid/MEMORY/00.memory_agent.md');
  });

  it('同分歧义时拒绝猜测，文件夹和文件也不会串型', () => {
    expect(findBestWorkspaceSearchMatch([
      { name: 'README.md', path: '/root/a/README.md', relative_dir: 'a', is_dir: false },
      { name: 'README.md', path: '/root/b/README.md', relative_dir: 'b', is_dir: false },
    ], '/root/README.md', 'file')).toBe(null);
    expect(findBestWorkspaceSearchMatch(matches, '/root/00.memory_agent.md', 'folder')).toBe(null);
  });

  it('多段路径没有目录后缀重合时拒绝打开同名无关文件', () => {
    expect(findBestWorkspaceSearchMatch([
      { name: 'RESULT.md', path: '/root/unrelated/RESULT.md', relative_dir: 'unrelated', is_dir: false },
    ], '/root/runs/20260920-gates/RESULT.md', 'file')).toBe(null);

    expect(findBestWorkspaceSearchMatch([
      {
        name: 'RESULT.md',
        path: '/root/project/runs/20260920-gates/RESULT.md',
        relative_dir: 'project/runs/20260920-gates',
        is_dir: false,
      },
    ], '/old/project/runs/20260920-gates/RESULT.md', 'file')?.path)
      .toBe('/root/project/runs/20260920-gates/RESULT.md');
  });
});

describe('normalizeFileReferencePath / slugifyHeading', () => {
  it('规范化分隔符与 dot segments', () => {
    expect(normalizeFileReferencePath('/a/b/../中文/./c.md')).toBe('/a/中文/c.md');
    expect(normalizeFileReferencePath('C:\\Users\\x\\..\\y\\a.md')).toBe('C:/Users/y/a.md');
  });

  it('生成中英文稳定 heading id', () => {
    expect(slugifyHeading('安装说明')).toBe('安装说明');
    expect(slugifyHeading('API 配置：Quick Start!')).toBe('api-配置quick-start');
  });
});

describe('resolvePathToken（相对路径拼成绝对路径）', () => {
  const base = '/root';
  it('相对路径拼到 base 下', () => {
    expect(resolvePathToken('01_Her/a.md', base)).toBe('/root/01_Her/a.md');
  });
  it('文件夹末尾斜杠被去掉', () => {
    expect(resolvePathToken('01_Her/_增长线/', base)).toBe('/root/01_Her/_增长线');
  });
  it('绝对路径原样（只去末尾斜杠）', () => {
    expect(resolvePathToken('/abs/path/a.md', base)).toBe('/abs/path/a.md');
  });
  it('base 带末尾斜杠也兼容', () => {
    expect(resolvePathToken('a.md', '/root/')).toBe('/root/a.md');
  });
});

// AI 在聊天里给的全路径，iCloud 前缀段常写得和真实文件系统不一致
// （com~apple~CloudDocs ↔ com-apple-CloudDocs / 整段缺失）→ 定位前先对齐回真实 root。
describe('reconcilePathToRoot（前缀不准的绝对路径对齐回真实 root）', () => {
  const root = '/Users/x/Library/Mobile Documents/com~apple~CloudDocs/2026工作间';

  it('iCloud 段缺失的全路径 → 对齐回真实 root', () => {
    expect(reconcilePathToRoot('/Users/x/Library/Mobile Documents/2026工作间/01_Her/6.7看板.html', root))
      .toBe('/Users/x/Library/Mobile Documents/com~apple~CloudDocs/2026工作间/01_Her/6.7看板.html');
  });
  it('iCloud 段被写成连字符 → 对齐回真实 root', () => {
    expect(reconcilePathToRoot('/Users/x/Library/Mobile Documents/com-apple-CloudDocs/2026工作间/01_Her/6.7看板.html', root))
      .toBe('/Users/x/Library/Mobile Documents/com~apple~CloudDocs/2026工作间/01_Her/6.7看板.html');
  });
  it('已在真实 root 下 → 原样返回', () => {
    const p = `${root}/01_Her/6.7看板.html`;
    expect(reconcilePathToRoot(p, root)).toBe(p);
  });
  it('找不到工作区名锚点 → 原样返回', () => {
    expect(reconcilePathToRoot('/totally/different/a.html', root)).toBe('/totally/different/a.html');
  });
  it('末尾斜杠先规范化', () => {
    expect(reconcilePathToRoot('/Users/x/Library/Mobile Documents/2026工作间/01_Her/', root))
      .toBe(`${root}/01_Her`);
  });
});
