/**
 * 相邻场次合并 · 纯函数工具
 * - 冲突检测：同一操耍人是否在两场各担一个角色（合并后一人无法同时操耍两个影偶）
 * - 合并计算：场次 / 角色 / 锣鼓点（后一场鼓点按前一场时长顺延）
 * - 快照指纹与变更比对：撤回时判断合并后是否被改动
 */
import type { CueRow, OperatorRow, RoleRow, SceneRow } from './db';
import type { ShadowScreenSpec } from '../types/scene';
import { nowIso } from './uuid';

/** 影窗规格排序（取两场中较大的规格作为合并场规格） */
const SCREEN_ORDER: Record<ShadowScreenSpec, number> = {
  small: 0,
  standard: 1,
  large: 2,
  twin: 3,
};

/** 操耍人冲突：同一人在合并的两场中各担一个角色 */
export interface OperatorConflict {
  operatorId: string;
  operatorName: string;
  /** 前一场中该操耍人担纲的角色名 */
  earlierRoleName: string;
  /** 后一场中该操耍人担纲的角色名 */
  laterRoleName: string;
  /** 前一场场次标题 */
  earlierSceneTitle: string;
  /** 后一场场次标题 */
  laterSceneTitle: string;
}

/** 合并前的预览数据（只读，不落库） */
export interface MergePreview {
  earlier: SceneRow;
  later: SceneRow;
  /** 前一场原始角色 */
  earlierRoles: RoleRow[];
  /** 后一场原始角色 */
  laterRoles: RoleRow[];
  /** 前一场原始锣鼓点 */
  earlierCues: CueRow[];
  /** 后一场原始锣鼓点 */
  laterCues: CueRow[];
  conflicts: OperatorConflict[];
  /** 合并后的场次草稿（id 沿前一场） */
  mergedScene: SceneRow;
  /** 合并后的角色（前一场保留，后一场改挂合并场） */
  mergedRoles: RoleRow[];
  /** 合并后的锣鼓点（后一场 atSecond 顺延） */
  mergedCues: CueRow[];
  /** 后一场鼓点顺延的秒数 */
  offsetSeconds: number;
}

/** 合并快照：保留合并前两场完整数据，用于撤回 */
export interface MergeSnapshot {
  /** 主键，固定为 playId（每出戏只保留最近一次合并快照） */
  id: string;
  playId: string;
  mergedAt: string;
  /** 合并后保留的场次 id（原前一场） */
  mergedSceneId: string;
  /** 合并前的原始场次（[前一场, 后一场]，保留原 id/seq） */
  scenes: SceneRow[];
  /** 合并前两场的全部角色（原 sceneId） */
  roles: RoleRow[];
  /** 合并前两场的全部锣鼓点（原 sceneId/atSecond） */
  cues: CueRow[];
  /** 合并后的基线状态（撤回时用于比对是否被改动） */
  baseline: {
    scene: SceneRow;
    roles: RoleRow[];
    cues: CueRow[];
  };
  /** 基线指纹（baseline 的稳定序列化） */
  fingerprint: string;
  /** 创建时间（ISO 字符串） */
  createdAt: string;
  /** 最近修改时间（ISO 字符串） */
  updatedAt: string;
}

/** 检测操耍人冲突：同一人在两场各担一个角色即冲突 */
export function detectOperatorConflicts(
  earlier: SceneRow,
  later: SceneRow,
  earlierRoles: RoleRow[],
  laterRoles: RoleRow[],
  operators: OperatorRow[],
): OperatorConflict[] {
  const operatorName = new Map(operators.map((op) => [op.id, op.name]));
  const laterByOperator = new Map<string, RoleRow>();
  laterRoles.forEach((role) => {
    if (role.operatorId !== null && !laterByOperator.has(role.operatorId)) {
      laterByOperator.set(role.operatorId, role);
    }
  });

  const conflicts: OperatorConflict[] = [];
  const seen = new Set<string>();
  earlierRoles.forEach((role) => {
    if (role.operatorId === null) return;
    const counterpart = laterByOperator.get(role.operatorId);
    if (!counterpart) return;
    if (seen.has(role.operatorId)) return;
    seen.add(role.operatorId);
    conflicts.push({
      operatorId: role.operatorId,
      operatorName: operatorName.get(role.operatorId) ?? '（已解绑）',
      earlierRoleName: role.name,
      laterRoleName: counterpart.name,
      earlierSceneTitle: earlier.title,
      laterSceneTitle: later.title,
    });
  });
  return conflicts;
}

/** 计算合并后的场次（id 沿前一场，seq 沿前一场，其余按规则合并） */
export function computeMergedScene(
  earlier: SceneRow,
  later: SceneRow,
  mergedTitle: string,
): SceneRow {
  const stamp = nowIso();
  const durationMin = earlier.durationMin + later.durationMin;
  const stageNote = [earlier.stageNote, later.stageNote].map((note) => note.trim()).filter(Boolean).join('\n');
  const needsShadowScreen =
    SCREEN_ORDER[later.needsShadowScreen] > SCREEN_ORDER[earlier.needsShadowScreen]
      ? later.needsShadowScreen
      : earlier.needsShadowScreen;
  const progress =
    durationMin > 0
      ? Math.round(
          (earlier.progress * earlier.durationMin + later.progress * later.durationMin) / durationMin,
        )
      : 0;
  return {
    ...earlier,
    title: mergedTitle.trim() || earlier.title,
    durationMin,
    stageNote,
    needsShadowScreen,
    progress: Math.min(100, Math.max(0, progress)),
    updatedAt: stamp,
    revision: earlier.revision,
  };
}

/** 计算合并后的角色：前一场保留原 sceneId，后一场改挂合并场 */
export function computeMergedRoles(
  earlierRoles: RoleRow[],
  laterRoles: RoleRow[],
  mergedSceneId: string,
): RoleRow[] {
  const stamp = nowIso();
  return [
    ...earlierRoles.map((role) => ({ ...role, updatedAt: stamp })),
    ...laterRoles.map((role) => ({ ...role, sceneId: mergedSceneId, updatedAt: stamp })),
  ];
}

/** 计算合并后的锣鼓点：前一场保留，后一场 atSecond 按前一场时长顺延 */
export function computeMergedCues(
  earlierCues: CueRow[],
  laterCues: CueRow[],
  mergedSceneId: string,
  offsetSeconds: number,
): CueRow[] {
  const stamp = nowIso();
  return [
    ...earlierCues.map((cue) => ({ ...cue, updatedAt: stamp })),
    ...laterCues.map((cue) => ({
      ...cue,
      sceneId: mergedSceneId,
      atSecond: cue.atSecond + offsetSeconds,
      updatedAt: stamp,
    })),
  ];
}

/** 生成合并预览（只读，不落库） */
export function buildMergePreview(
  earlier: SceneRow,
  later: SceneRow,
  earlierRoles: RoleRow[],
  laterRoles: RoleRow[],
  earlierCues: CueRow[],
  laterCues: CueRow[],
  operators: OperatorRow[],
  mergedTitle: string,
): MergePreview {
  const conflicts = detectOperatorConflicts(earlier, later, earlierRoles, laterRoles, operators);
  const mergedScene = computeMergedScene(earlier, later, mergedTitle);
  const mergedRoles = computeMergedRoles(earlierRoles, laterRoles, mergedScene.id);
  const offsetSeconds = earlier.durationMin * 60;
  const mergedCues = computeMergedCues(earlierCues, laterCues, mergedScene.id, offsetSeconds);
  return {
    earlier,
    later,
    earlierRoles,
    laterRoles,
    earlierCues,
    laterCues,
    conflicts,
    mergedScene,
    mergedRoles,
    mergedCues,
    offsetSeconds,
  };
}

/** 稳定序列化（按 id 排序），用于生成指纹 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.keys(inner)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = (inner as Record<string, unknown>)[key];
          return acc;
        }, {});
    }
    return inner;
  });
}

/** 生成基线指纹 */
export function fingerprintOfBaseline(baseline: MergeSnapshot['baseline']): string {
  const sorted = {
    scene: baseline.scene,
    roles: [...baseline.roles].sort((a, b) => a.id.localeCompare(b.id)),
    cues: [...baseline.cues].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return stableStringify(sorted);
}

/** 简易字符串哈希（FNV-1a 32 位），用于指纹比对 */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 合并后撤回到的原始场次（用于恢复场序） */
export function resequenceAfterUndo(scenes: SceneRow[]): SceneRow[] {
  const stamp = nowIso();
  return [...scenes]
    .sort((a, b) => a.seq - b.seq)
    .map((scene, index) => ({ ...scene, seq: index + 1, updatedAt: stamp }));
}

/** 合并后重排场序（删除后一场，后续场次 seq 前移） */
export function resequenceAfterMerge(
  scenes: SceneRow[],
  removedSceneId: string,
): SceneRow[] {
  const stamp = nowIso();
  return scenes
    .filter((scene) => scene.id !== removedSceneId)
    .sort((a, b) => a.seq - b.seq)
    .map((scene, index) => ({ ...scene, seq: index + 1, updatedAt: stamp }));
}

/** 比对基线与当前状态，返回人类可读的变更清单（空数组表示未改动） */
export function diffBaseline(
  baseline: MergeSnapshot['baseline'],
  current: MergeSnapshot['baseline'],
): string[] {
  const changes: string[] = [];

  if (baseline.scene.title !== current.scene.title) {
    changes.push(`场次标题：「${baseline.scene.title}」→「${current.scene.title}」`);
  }
  if (baseline.scene.durationMin !== current.scene.durationMin) {
    changes.push(`时长：${baseline.scene.durationMin} 分钟 → ${current.scene.durationMin} 分钟`);
  }
  if (baseline.scene.needsShadowScreen !== current.scene.needsShadowScreen) {
    changes.push('影窗规格已调整');
  }
  if (baseline.scene.stageNote !== current.scene.stageNote) {
    changes.push('舞台提示已修改');
  }
  if (baseline.scene.progress !== current.scene.progress) {
    changes.push(`排练进度：${baseline.scene.progress}% → ${current.scene.progress}%`);
  }

  const baselineRoles = new Map(baseline.roles.map((role) => [role.id, role]));
  const currentRoles = new Map(current.roles.map((role) => [role.id, role]));
  baseline.roles.forEach((role) => {
    const target = currentRoles.get(role.id);
    if (!target) {
      changes.push(`角色「${role.name}」已被删除`);
      return;
    }
    if (role.name !== target.name) changes.push(`角色「${role.name}」改名为「${target.name}」`);
    if (role.operatorId !== target.operatorId) changes.push(`角色「${role.name}」的操耍人指派已变更`);
    if (role.roleType !== target.roleType) changes.push(`角色「${role.name}」的行当已调整`);
  });
  current.roles.forEach((role) => {
    if (!baselineRoles.has(role.id)) changes.push(`新增角色「${role.name}」`);
  });

  const baselineCues = new Map(baseline.cues.map((cue) => [cue.id, cue]));
  const currentCues = new Map(current.cues.map((cue) => [cue.id, cue]));
  baseline.cues.forEach((cue) => {
    const target = currentCues.get(cue.id);
    if (!target) {
      changes.push(`锣鼓点「${cue.beatName}」已被删除`);
      return;
    }
    if (cue.atSecond !== target.atSecond) changes.push(`锣鼓点「${cue.beatName}」的时间点已调整`);
    if (cue.leadOperator !== target.leadOperator) changes.push(`锣鼓点「${cue.beatName}」的领奏已变更`);
    if (cue.beatName !== target.beatName || cue.instrument !== target.instrument) {
      changes.push(`锣鼓点「${cue.beatName}」的板式/乐器已调整`);
    }
  });
  current.cues.forEach((cue) => {
    if (!baselineCues.has(cue.id)) changes.push(`新增锣鼓点「${cue.beatName}」`);
  });

  return changes;
}
