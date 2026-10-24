/**
 * zx_20261013_1 批三「称引于人」——**导航配置一处真源**。
 *
 * 此前 `NAV_GROUPS` 只住在 `AppLayout.tsx` 里。首启导览要"依次高亮核心入口"，若另写一份
 * 入口清单，就多出**第二份词表**（`biz_20261011 §3` 最担心的事）。故把导航表提到此处，
 * 让**侧栏**与**导览**消费同一个数组：
 *   · 侧栏 → `NAV_GROUPS`（原样长出来）；
 *   · 导览 → `tourEntries()`（凡带 `tour` 一句说明者入册，**顺序即导航顺序**）。
 *
 * 加/删一个导览项 = 在 `NAV_GROUPS` 里加/删 `tour` 字段一处；两处自动同源，不会分家。
 */
import { LayoutDashboard, FolderKanban, MessageSquare, Settings, Cpu, Users, Package, Wand2, Server, Globe, Puzzle, Brain, Key, Box, User, LayoutTemplate, History, Network, Router, ScrollText, Library } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  icon: LucideIcon;
  label: string;
  /**
   * 首启导览的**一句说明**——**有则入导览**（无则不参与）。导览词表由此字段派生：
   * 想要某个入口进导览，就在这里给它写一句话；不想它进，就别写 `tour`。
   */
  tour?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    // zx_20261004 M4/M10：协同与设备——本轮新增（M4 协同面板 / M10 设备面板）。
    label: '协同与设备',
    items: [
      { to: '/peers', icon: Network, label: '协同面板', tour: '多台工蚁互相派活、看对端在不在场——一个人也能组起一队。' },
      { to: '/devices', icon: Router, label: '设备' },
      // zx_20261017_1 批二: 审计视图（三本账合成一个时间线；Team 能力，锁定显升级提示）。
      { to: '/audit', icon: ScrollText, label: '审计视图' },
      // zx_20261017_1 批六: 团队共享库（跨节点共享模板/记忆/成果元数据；Team 能力）。
      { to: '/team-library', icon: Library, label: '团队共享库' },
    ],
  },
  {
    label: 'ANS 资源管理',
    items: [
      { to: '/models', icon: Cpu, label: 'AI模型', tour: '把你要用的模型接进来——工蚁干活的那只手，在这里配。' },
      { to: '/skills', icon: Wand2, label: '技能', tour: '把可复用的做法存成技能，任务里可直接调用。' },
      { to: '/mcp', icon: Server, label: 'MCP服务', tour: '挂上 MCP 服务，给工蚁添一批外部工具。' },
      { to: '/a2a', icon: Globe, label: 'A2A服务' },
      { to: '/plugins', icon: Puzzle, label: '插件市场' },
    ],
  },
  {
    label: '项目管理',
    items: [
      { to: '/projects', icon: FolderKanban, label: '项目', tour: '一个项目圈住一摊事：目标、记忆、产出都归它管。' },
      { to: '/tasks', icon: Box, label: '任务', tour: '把一句话交给工蚁，它自己拆解、执行、把成果交回来。' },
      { to: '/templates', icon: LayoutTemplate, label: '任务模板' },
      { to: '/deliverables', icon: Package, label: '产出物', tour: '每次干完留下的成果都汇总在这儿，可验收、可翻开。' },
      { to: '/im', icon: MessageSquare, label: 'IM渠道', tour: '接上微信／飞书／钉钉，用聊天派活、收成果。' },
    ],
  },
  {
    label: '运维管理',
    items: [
      { to: '/', icon: LayoutDashboard, label: '运维看板' },
      { to: '/activity', icon: History, label: '活动' },
      { to: '/api-keys', icon: Key, label: 'API Keys' },
      { to: '/preferences', icon: User, label: '用户偏好' },
      { to: '/memories', icon: Brain, label: '系统记忆', tour: '工蚁从过往任务里攒下的经验，随时可查、可改。' },
      { to: '/users', icon: Users, label: '用户管理' },
      { to: '/settings', icon: Settings, label: '系统设置' },
    ],
  },
];

/** 导览条目（**必有** `tour` 说明）。 */
export type TourEntry = NavItem & { tour: string };

/**
 * 首启导览条目 = **从导航配置派生**（凡带 `tour` 者，顺序即导航顺序）。
 * 这是词表的**唯一**来源——导览组件不得自持一份入口清单。
 */
export function tourEntries(): TourEntry[] {
  const out: TourEntry[] = [];
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (typeof item.tour === 'string') out.push({ ...item, tour: item.tour });
    }
  }
  return out;
}
