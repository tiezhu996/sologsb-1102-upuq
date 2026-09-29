/**
 * 相邻场次合并：冲突预检、合并计划、合并前快照与撤回核对。
 *
 * 设计要点：
 * - 纯函数规划：所有要写入的行（合并场 / 迁移角色 / 顺延鼓点 / 重排场序）在此一次性生成，
 *   内存里的「合并后预期数据束」与交给原子事务写入的内容完全一致。
 * - 冲突拦截：同一操耍人在两场各演不同角色时，合并后要兼顾两个角色，直接拒绝并点明角色。
 * - 撤回：合并前保存整剧数据束；撤回前用业务字段与「合并后预期数据束」逐项核对，
 *   合并后若又做过改动，则列出变化并拒绝撤回。
 */
import {
  getPlayBundle,
  mergeAdjacentScenesAtomic,
  restorePlayBundle,
  type CueRow,
  type PlayBundle,
  type RoleRow,
  type SceneRow,
} from './db';
import { nowIso } from './uuid';
import { STORAGE_KEYS, readLocalJson, writeLocalJson } from './localStore';

/* ------------------------------ 冲突与计划 ------------------------------ */

/** 同一操耍人兼顾两个角色的冲突明细 */
export interface MergeOperatorConflict {
  operatorId: string;
  /** 操耍人姓名（执行合并时由页面传入的姓名解析器填充） */
  operatorName: string;
  /** 前场承担的角色名（去重） */
  leftRoles: string[];
  /** 后场承担的角色名（去重） */
  rightRoles: string[];
}

/** 合并计划：经纯函数预生成的全部写入内容 */
export interface MergePlan {
  playId: string;
  leftScene: SceneRow;
  rightScene: SceneRow;
  mergedScene: SceneRow;
  movedRoles: RoleRow[];
  shiftedCues: CueRow[];
  rescenes: SceneRow[];
  nextSceneCount: number;
  stamp: string;
}

function roleName(name: string): string {
  return name.trim();
}

/**
 * 预检操耍人冲突：同一操耍人在两场都被指派，且承担的是不同角色时返回冲突。
 * 同一角色（同名）在两场延续出演不算冲突；未指派操耍人的角色不参与判定。
 */
export function findOperatorConflicts(
  leftScene: SceneRow,
  rightScene: SceneRow,
  roles: RoleRow[],
): MergeOperatorConflict[] {
  const left = roles.filter((role) => role.sceneId === leftScene.id && role.operatorId !== null);
  const right = roles.filter((role) => role.sceneId === rightScene.id && role.operatorId !== null);
  const add = (map: Map<string, Set<string>>, operatorId: string, name: string) => {
    const set = map.get(operatorId) ?? new Set<string>();
    set.add(roleName(name));
    map.set(operatorId, set);
  };
  const leftMap = new Map<string, Set<string>>();
  const rightMap = new Map<string, Set<string>>();
  left.forEach((role) => add(leftMap, role.operatorId as string, role.name));
  right.forEach((role) => add(rightMap, role.operatorId as string, role.name));

  const conflicts: MergeOperatorConflict[] = [];
  leftMap.forEach((leftNames, operatorId) => {
    const rightNames = rightMap.get(operatorId);
    if (!rightNames) return;
    // 同名角色延续出演不算兼顾两个角色
    const onlyLeft = [...leftNames].filter((name) => !rightNames.has(name));
    const onlyRight = [...rightNames].filter((name) => !leftNames.has(name));
    if (onlyLeft.length > 0 || onlyRight.length > 0) {
      conflicts.push({ operatorId, operatorName: '', leftRoles: onlyLeft, rightRoles: onlyRight });
    }
  });
  return conflicts;
}

/** 两场均值进度（时长为 0 时退化为算术平均） */
function mergedProgress(left: SceneRow, right: SceneRow): number {
  const total = Math.max(0, left.durationMin) + Math.max(0, right.durationMin);
  if (total <= 0) return Math.round((left.progress + right.progress) / 2);
  return Math.round((left.progress * left.durationMin + right.progress * right.durationMin) / total);
}

/** 生成合并场标题：沿用前场标题（已含「第 N 场」前缀） */
function mergedTitle(left: SceneRow): string {
  return left.title;
}

/** 合并舞台提示：空提示忽略，均有内容时分段保留并标注来源 */
function mergedStageNote(left: SceneRow, right: SceneRow): string {
  const l = left.stageNote.trim();
  const r = right.stageNote.trim();
  if (!l) return r;
  if (!r) return l;
  return `【前场】${l}\n【后场】${r}`;
}

/**
 * 生成相邻场次合并计划（纯函数，不写库）。
 * @param orderedScenes 按场序排好的全部场次
 * @param roles 该剧目全部角色
 * @param cues 该剧目全部锣鼓点
 * @param leftIndex 前场在 orderedScenes 中的下标，后场必须是其紧后一场
 */
export function buildMergePlan(
  orderedScenes: SceneRow[],
  roles: RoleRow[],
  cues: CueRow[],
  leftIndex: number,
): MergePlan | { error: string } {
  const left = orderedScenes[leftIndex];
  const right = orderedScenes[leftIndex + 1];
  if (!left || !right) return { error: '只有相邻的两场才能合并' };
  if (left.playId !== right.playId) return { error: '两场不属于同一剧目，不能合并' };
  if (right.seq !== left.seq + 1) return { error: '两场场序不相邻，不能合并' };

  const stamp = nowIso();
  const mergedScene: SceneRow = {
    ...left,
    title: mergedTitle(left),
    durationMin: Math.max(0, left.durationMin) + Math.max(0, right.durationMin),
    stageNote: mergedStageNote(left, right),
    needsShadowScreen: left.needsShadowScreen,
    progress: mergedProgress(left, right),
    updatedAt: stamp,
    revision: left.revision,
  };

  // 后场角色原样迁入前场，只改归属与更新时间
  const movedRoles = roles
    .filter((role) => role.sceneId === right.id)
    .map((role) => ({ ...role, sceneId: left.id, updatedAt: stamp }));

  // 后场鼓点整体顺延前场时长并迁入前场；前场鼓点不动
  const shiftSeconds = Math.max(0, left.durationMin) * 60;
  const shiftedCues = cues
    .filter((cue) => cue.sceneId === right.id)
    .map((cue) => ({ ...cue, sceneId: left.id, atSecond: cue.atSecond + shiftSeconds, updatedAt: stamp }));

  // 后场之后的场次场序 -1（后场本身被删除，前场保留新 seq 不变）
  const rescenes = orderedScenes
    .slice(leftIndex + 2)
    .map((scene) => ({ ...scene, seq: scene.seq - 1, updatedAt: stamp }));

  return {
    playId: left.playId,
    leftScene: left,
    rightScene: right,
    mergedScene,
    movedRoles,
    shiftedCues,
    rescenes,
    nextSceneCount: orderedScenes.length - 1,
    stamp,
  };
}

/* --------------------------- 合并后预期数据束 --------------------------- */

/**
 * 依据计划推导合并后应有的整剧数据束，供撤回前核对与撤回记录留档。
 * 行内容与原子事务实际写入的行严格一致（同一对象拷贝）。
 */
export function expectedBundleAfterMerge(
  before: PlayBundle,
  plan: MergePlan,
): PlayBundle {
  const scenes = before.scenes.map((scene) => {
    if (scene.id === plan.mergedScene.id) return plan.mergedScene;
    const rescene = plan.rescenes.find((item) => item.id === scene.id);
    return rescene ?? scene;
  }).filter((scene) => scene.id !== plan.rightScene.id);

  const movedRoleIds = new Set(plan.movedRoles.map((role) => role.id));
  const shiftedCueIds = new Set(plan.shiftedCues.map((cue) => cue.id));
  const roles = before.roles
    .filter((role) => !movedRoleIds.has(role.id))
    .concat(plan.movedRoles);
  const cues = before.cues
    .filter((cue) => !shiftedCueIds.has(cue.id))
    .concat(plan.shiftedCues)
    .sort((a, b) => a.atSecond - b.atSecond);

  return { scenes, roles, cues };
}

/* ----------------------------- 撤回前差异核对 ----------------------------- */

type ChangeKind = 'added' | 'removed' | 'modified';

export interface EntityChange {
  kind: ChangeKind;
  label: string;
  detail?: string;
}

export interface BundleDiff {
  hasChanges: boolean;
  changes: EntityChange[];
}

const SCENE_WATCH: ReadonlyArray<keyof SceneRow> = [
  'seq',
  'title',
  'durationMin',
  'stageNote',
  'needsShadowScreen',
  'progress',
];
const ROLE_WATCH: ReadonlyArray<keyof RoleRow> = [
  'sceneId',
  'name',
  'roleType',
  'propParts',
  'entranceCue',
  'lineNote',
  'operatorId',
];
const CUE_WATCH: ReadonlyArray<keyof CueRow> = [
  'sceneId',
  'beatName',
  'instrument',
  'atSecond',
  'leadOperator',
  'note',
];

function fieldChanges<T extends object>(before: T, after: T, fields: ReadonlyArray<keyof T>): string[] {
  const diffs: string[] = [];
  fields.forEach((field) => {
    const a = before[field];
    const b = after[field];
    const same = typeof a === 'object' || typeof b === 'object'
      ? JSON.stringify(a) === JSON.stringify(b)
      : a === b;
    if (!same) diffs.push(String(field));
  });
  return diffs;
}

const SCENE_FIELD_LABEL: Record<string, string> = {
  seq: '场序',
  title: '标题',
  durationMin: '时长',
  stageNote: '舞台提示',
  needsShadowScreen: '影窗规格',
  progress: '排练进度',
};
const ROLE_FIELD_LABEL: Record<string, string> = {
  sceneId: '所属场次',
  name: '角色名',
  roleType: '行当',
  propParts: '影件',
  entranceCue: '出场提示',
  lineNote: '唱白要点',
  operatorId: '操耍人',
};
const CUE_FIELD_LABEL: Record<string, string> = {
  sceneId: '所属场次',
  beatName: '锣鼓点',
  instrument: '乐器',
  atSecond: '秒点',
  leadOperator: '领奏',
  note: '备注',
};

function labelOf(map: Record<string, string>, field: string): string {
  return map[field] ?? field;
}

/**
 * 对比「当前数据束」与「合并后预期数据束」的业务字段（忽略 createdAt/updatedAt/revision）。
 * 用于撤回前判断合并之后是否又做过修改。
 */
export function diffBundles(current: PlayBundle, expected: PlayBundle): BundleDiff {
  const changes: EntityChange[] = [];
  const expectedScenes = new Map(expected.scenes.map((scene) => [scene.id, scene]));
  const currentScenes = new Map(current.scenes.map((scene) => [scene.id, scene]));

  current.scenes.forEach((scene) => {
    const exp = expectedScenes.get(scene.id);
    if (!exp) changes.push({ kind: 'added', label: `场次「${scene.title}」` });
    else {
      const fields = fieldChanges(exp, scene, SCENE_WATCH).map((f) => labelOf(SCENE_FIELD_LABEL, f));
      if (fields.length > 0) changes.push({ kind: 'modified', label: `场次「${scene.title}」`, detail: fields.join('、') });
    }
  });
  expected.scenes.forEach((scene) => {
    if (!currentScenes.has(scene.id)) changes.push({ kind: 'removed', label: `场次「${scene.title}」` });
  });

  const compareEntities = <T extends { id: string; name?: string; sceneId: string; atSecond?: number }>(
    currentList: T[],
    expectedList: T[],
    watch: ReadonlyArray<keyof T>,
    labels: Record<string, string>,
    typeLabel: string,
  ) => {
    const expMap = new Map(expectedList.map((item) => [item.id, item]));
    const curMap = new Map(currentList.map((item) => [item.id, item]));
    const sceneTitleOf = (id: string): string => currentScenes.get(id)?.title ?? expectedScenes.get(id)?.title ?? '未知场次';
    currentList.forEach((item) => {
      const exp = expMap.get(item.id);
      const where = sceneTitleOf(item.sceneId);
      if (!exp) {
        changes.push({ kind: 'added', label: `${typeLabel}「${item.name ?? `#${item.atSecond ?? ''}秒`}」（${where}）` });
      } else {
        const fields = fieldChanges(exp, item, watch).map((f) => labelOf(labels, f));
        if (fields.length > 0) {
          changes.push({
            kind: 'modified',
            label: `${typeLabel}「${item.name ?? `${item.atSecond ?? ''} 秒`}」（${where}）`,
            detail: fields.join('、'),
          });
        }
      }
    });
    expectedList.forEach((item) => {
      if (!curMap.has(item.id)) {
        changes.push({
          kind: 'removed',
          label: `${typeLabel}「${item.name ?? `${item.atSecond ?? ''} 秒`}」（${sceneTitleOf(item.sceneId)}）`,
        });
      }
    });
  };

  compareEntities(current.roles, expected.roles, ROLE_WATCH, ROLE_FIELD_LABEL, '角色');
  compareEntities(current.cues, expected.cues, CUE_WATCH, CUE_FIELD_LABEL, '锣鼓点');

  return { hasChanges: changes.length > 0, changes };
}

/* ------------------------------ 撤回记录 ------------------------------ */

/** 合并前快照与撤回核对所需的全部信息（按剧目保存最近一次） */
export interface MergeUndoRecord {
  playId: string;
  mergedAt: string;
  leftTitle: string;
  rightTitle: string;
  mergedTitle: string;
  sceneCountAfter: number;
  sceneCountBefore: number;
  beforeBundle: PlayBundle;
  expectedBundle: PlayBundle;
}

type MergeUndoMap = Record<string, MergeUndoRecord>;

function readUndoMap(): MergeUndoMap {
  return readLocalJson<MergeUndoMap>(STORAGE_KEYS.mergeUndo, {});
}

function writeUndoMap(map: MergeUndoMap): void {
  writeLocalJson(STORAGE_KEYS.mergeUndo, map);
}

export function getMergeUndo(playId: string): MergeUndoRecord | null {
  return readUndoMap()[playId] ?? null;
}

export function clearMergeUndo(playId: string): void {
  const map = readUndoMap();
  if (map[playId]) {
    delete map[playId];
    writeUndoMap(map);
  }
}

/* ------------------------------ 执行合并 ------------------------------ */

export type MergePreview =
  | { ok: true; left: SceneRow; right: SceneRow }
  | { ok: false; blocked: true; conflicts: MergeOperatorConflict[] }
  | { ok: false; blocked: false; error: string };

/**
 * 只读预检相邻场次合并：不写任何数据。
 * 点「合下场」时先调用：有操耍人冲突直接拒绝并点明角色，通过后才弹确认框。
 */
export async function previewAdjacentMerge(
  playId: string,
  leftSceneId: string,
  operatorName: (operatorId: string) => string,
): Promise<MergePreview> {
  const bundle = await getPlayBundle(playId);
  const leftIndex = bundle.scenes.findIndex((scene) => scene.id === leftSceneId);
  if (leftIndex < 0 || leftIndex >= bundle.scenes.length - 1) {
    return { ok: false, blocked: false, error: '只有场序表里相邻的两场才能合并' };
  }
  const left = bundle.scenes[leftIndex];
  const right = bundle.scenes[leftIndex + 1];
  if (right.seq !== left.seq + 1) {
    return { ok: false, blocked: false, error: '两场场序不相邻，不能合并' };
  }
  const conflicts = findOperatorConflicts(left, right, bundle.roles);
  if (conflicts.length > 0) {
    return {
      ok: false,
      blocked: true,
      conflicts: conflicts.map((conflict) => ({ ...conflict, operatorName: operatorName(conflict.operatorId) })),
    };
  }
  return { ok: true, left, right };
}

export type MergeOutcome =
  | { ok: true; plan: MergePlan }
  | { ok: false; blocked: true; conflicts: MergeOperatorConflict[] }
  | { ok: false; blocked: false; error: string };

/**
 * 执行相邻场次合并：
 * 1. 读整剧最新数据；2. 校验相邻与操耍人冲突（冲突拒绝并点明角色）；
 * 3. 保存合并前快照；4. 一次事务原子写入（失败不留半套数据，快照也不落盘）；
 * 5. 留下撤回记录。
 */
export async function mergeAdjacentScenes(
  playId: string,
  leftSceneId: string,
  operatorName: (operatorId: string) => string,
): Promise<MergeOutcome> {
  const bundle = await getPlayBundle(playId);
  const leftIndex = bundle.scenes.findIndex((scene) => scene.id === leftSceneId);
  if (leftIndex < 0 || leftIndex >= bundle.scenes.length - 1) {
    return { ok: false, blocked: false, error: '只有场序表里相邻的两场才能合并' };
  }
  const left = bundle.scenes[leftIndex];
  const right = bundle.scenes[leftIndex + 1];

  const conflicts = findOperatorConflicts(left, right, bundle.roles);
  if (conflicts.length > 0) {
    // 点明冲突：操耍人 + 前场/后场角色名
    return {
      ok: false,
      blocked: true,
      conflicts: conflicts.map((conflict) => ({ ...conflict, operatorName: operatorName(conflict.operatorId) })),
    };
  }

  const planResult = buildMergePlan(bundle.scenes, bundle.roles, bundle.cues, leftIndex);
  if ('error' in planResult) return { ok: false, blocked: false, error: planResult.error };

  const expectedBundle = expectedBundleAfterMerge(bundle, planResult);

  // 原子写入：失败抛错，整体回滚，不写撤回快照
  await mergeAdjacentScenesAtomic({
    playId,
    mergedScene: planResult.mergedScene,
    removedScene: planResult.rightScene,
    movedRoles: planResult.movedRoles,
    shiftedCues: planResult.shiftedCues,
    rescenes: planResult.rescenes,
    nextSceneCount: planResult.nextSceneCount,
  });

  const record: MergeUndoRecord = {
    playId,
    mergedAt: planResult.stamp,
    leftTitle: planResult.leftScene.title,
    rightTitle: planResult.rightScene.title,
    mergedTitle: planResult.mergedScene.title,
    sceneCountAfter: planResult.nextSceneCount,
    sceneCountBefore: bundle.scenes.length,
    beforeBundle: bundle,
    expectedBundle,
  };
  const map = readUndoMap();
  map[playId] = record;
  writeUndoMap(map);

  return { ok: true, plan: planResult };
}

/* ------------------------------ 撤回合并 ------------------------------ */

export type UndoOutcome =
  | { ok: true; record: MergeUndoRecord }
  | { ok: false; blocked: true; diff: BundleDiff }
  | { ok: false; blocked: false; error: string };

/**
 * 撤回合并：先核对合并之后是否又改过；未改则原子恢复合并前快照，
 * 已改动则列出变化并拒绝撤回。
 */
export async function undoSceneMerge(playId: string): Promise<UndoOutcome> {
  const record = getMergeUndo(playId);
  if (!record) return { ok: false, blocked: false, error: '没有可撤回的合并记录' };

  const current = await getPlayBundle(playId);
  const diff = diffBundles(current, record.expectedBundle);
  if (diff.hasChanges) return { ok: false, blocked: true, diff };

  await restorePlayBundle(playId, record.beforeBundle, record.sceneCountBefore);
  clearMergeUndo(playId);
  return { ok: true, record };
}
