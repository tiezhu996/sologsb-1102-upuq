/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 * - 表的增删改查与整库导入导出
 * - 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie';
import type { Play } from '../types/play';
import type { Scene } from '../types/scene';
import type { ShadowRole } from '../types/role';
import type { Operator } from '../types/operator';
import type { PercussionCue } from '../types/cue';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';
import {
  buildMergePreview,
  diffBaseline,
  fingerprintOfBaseline,
  hashString,
  resequenceAfterMerge,
  resequenceAfterUndo,
  type MergeSnapshot,
  type OperatorConflict,
} from './merge';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据库名 */
export const DB_NAME = 'gbshadowplay';

/** 带结构修订号的持久化实体 */
export interface Revisioned {
  /** 数据行结构修订号，便于后续按行迁移 */
  revision: number;
}

export type PlayRow = Play & Revisioned;
export type SceneRow = Scene & Revisioned;
export type RoleRow = ShadowRole & Revisioned;
export type OperatorRow = Operator & Revisioned;
export type CueRow = PercussionCue & Revisioned;
export type MergeSnapshotRow = MergeSnapshot & Revisioned;

export const ROW_REVISION = 3;

class ShadowPlayDatabase extends Dexie {
  plays!: Table<PlayRow, string>;
  scenes!: Table<SceneRow, string>;
  roles!: Table<RoleRow, string>;
  operators!: Table<OperatorRow, string>;
  cues!: Table<CueRow, string>;
  mergeSnapshots!: Table<MergeSnapshotRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（仅基础自增字段，保留历史数据）
    this.version(1).stores({
      plays: 'id, title, genre, status, createdAt',
      scenes: 'id, playId, seq, progress',
      roles: 'id, sceneId, operatorId, roleType',
      operators: 'id, name',
      cues: 'id, sceneId, atSecond, instrument',
    });

    // v2：新增 revision 行修订号；场次补充索引，锣鼓点补充 playId 冗余便于按剧目统计
    this.version(2)
      .stores({
        plays: 'id, title, genre, status, createdAt, updatedAt',
        scenes: 'id, playId, seq, progress, needsShadowScreen',
        roles: 'id, sceneId, operatorId, roleType, name',
        operators: 'id, name, rehearsalHours',
        cues: 'id, sceneId, atSecond, instrument, beatName',
      })
      .upgrade(async (tx) => {
        // 迁移：补齐 revision，并兜底历史数据里缺失的字段
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('plays'),
          tx.table('scenes'),
          tx.table('roles'),
          tx.table('operators'),
          tx.table('cues'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = 2;
            if (typeof row.updatedAt !== 'string') row.updatedAt = nowIso();
            if (typeof row.createdAt !== 'string') row.createdAt = row.updatedAt;
          });
        }
      });

    // v3：新增 mergeSnapshots 表，保存相邻场次合并前的快照，支持撤回
    this.version(DB_SCHEMA_VERSION).stores({
      mergeSnapshots: 'id, playId, mergedAt, mergedSceneId',
    });
  }
}

export const db = new ShadowPlayDatabase();

/** 打开数据库：首次使用时灌入示例班社数据，保证界面不为空壳 */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.plays.count();
  if (count === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 剧目 ------------------------------ */

export async function listPlays(): Promise<PlayRow[]> {
  return db.plays.orderBy('createdAt').reverse().toArray();
}

export async function getPlay(id: string): Promise<PlayRow | undefined> {
  return db.plays.get(id);
}

export async function putPlay(row: PlayRow): Promise<void> {
  await db.plays.put(row);
}

export async function removePlay(id: string): Promise<void> {
  await db.transaction('rw', db.plays, db.scenes, db.roles, db.cues, db.mergeSnapshots, async () => {
    const scenes = await db.scenes.where('playId').equals(id).toArray();
    const sceneIds = scenes.map((scene) => scene.id);
    if (sceneIds.length > 0) {
      await db.roles.where('sceneId').anyOf(sceneIds).delete();
      await db.cues.where('sceneId').anyOf(sceneIds).delete();
    }
    await db.scenes.where('playId').equals(id).delete();
    await db.mergeSnapshots.delete(id);
    await db.plays.delete(id);
  });
}

/* ------------------------------ 场次 ------------------------------ */

export async function listScenesByPlay(playId: string): Promise<SceneRow[]> {
  const rows = await db.scenes.where('playId').equals(playId).toArray();
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function getScene(id: string): Promise<SceneRow | undefined> {
  return db.scenes.get(id);
}

export async function putScene(row: SceneRow): Promise<void> {
  await db.scenes.put(row);
}

export async function putScenes(rows: SceneRow[]): Promise<void> {
  await db.scenes.bulkPut(rows);
}

export async function removeScene(id: string): Promise<void> {
  await db.transaction('rw', db.scenes, db.roles, db.cues, async () => {
    await db.roles.where('sceneId').equals(id).delete();
    await db.cues.where('sceneId').equals(id).delete();
    await db.scenes.delete(id);
  });
}

/* ---------------------------- 影人角色 ---------------------------- */

export async function listRolesByScene(sceneId: string): Promise<RoleRow[]> {
  return db.roles.where('sceneId').equals(sceneId).toArray();
}

export async function listRolesByScenes(sceneIds: string[]): Promise<RoleRow[]> {
  if (sceneIds.length === 0) return [];
  return db.roles.where('sceneId').anyOf(sceneIds).toArray();
}

export async function listAllRoles(): Promise<RoleRow[]> {
  return db.roles.toArray();
}

export async function putRole(row: RoleRow): Promise<void> {
  await db.roles.put(row);
}

export async function removeRole(id: string): Promise<void> {
  await db.roles.delete(id);
}

/* ----------------------------- 操耍人 ----------------------------- */

export async function listOperators(): Promise<OperatorRow[]> {
  const rows = await db.operators.toArray();
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function getOperator(id: string): Promise<OperatorRow | undefined> {
  return db.operators.get(id);
}

export async function putOperator(row: OperatorRow): Promise<void> {
  await db.operators.put(row);
}

export async function putOperators(rows: OperatorRow[]): Promise<void> {
  await db.operators.bulkPut(rows);
}

export async function removeOperator(id: string): Promise<void> {
  await db.transaction('rw', db.operators, db.roles, async () => {
    const bound = await db.roles.where('operatorId').equals(id).toArray();
    if (bound.length > 0) {
      await db.roles.bulkPut(bound.map((role) => ({ ...role, operatorId: null, updatedAt: nowIso() })));
    }
    await db.cues.where('leadOperator').equals(id).modify({ leadOperator: null });
    await db.operators.delete(id);
  });
}

/* ----------------------------- 锣鼓点 ----------------------------- */

export async function listCuesByScene(sceneId: string): Promise<CueRow[]> {
  const rows = await db.cues.where('sceneId').equals(sceneId).toArray();
  return rows.sort((a, b) => a.atSecond - b.atSecond);
}

export async function putCue(row: CueRow): Promise<void> {
  await db.cues.put(row);
}

export async function removeCue(id: string): Promise<void> {
  await db.cues.delete(id);
}

/* --------------------------- 场次合并与撤回 --------------------------- */

/** 读取某出戏的合并快照（每出戏至多一份） */
export async function getMergeSnapshot(playId: string): Promise<MergeSnapshotRow | undefined> {
  return db.mergeSnapshots.get(playId);
}

/** 删除某出戏的合并快照 */
export async function deleteMergeSnapshot(playId: string): Promise<void> {
  await db.mergeSnapshots.delete(playId);
}

/** 合并预览结果（只读，不落库） */
export interface MergePreviewResult {
  ok: boolean;
  conflicts: OperatorConflict[];
  preview: ReturnType<typeof buildMergePreview> | null;
}

/**
 * 生成合并预览：加载两场的角色 / 锣鼓点 / 操耍人，做冲突检测并计算合并结果。
 * 不写入任何数据。
 */
export async function previewMergeScenes(
  playId: string,
  earlierSceneId: string,
  laterSceneId: string,
  mergedTitle: string,
): Promise<MergePreviewResult> {
  const [earlier, later] = await Promise.all([db.scenes.get(earlierSceneId), db.scenes.get(laterSceneId)]);
  if (!earlier || !later || earlier.playId !== playId || later.playId !== playId) {
    return { ok: false, conflicts: [], preview: null };
  }
  const [earlierRoles, laterRoles, earlierCues, laterCues, operators] = await Promise.all([
    db.roles.where('sceneId').equals(earlierSceneId).toArray(),
    db.roles.where('sceneId').equals(laterSceneId).toArray(),
    db.cues.where('sceneId').equals(earlierSceneId).toArray(),
    db.cues.where('sceneId').equals(laterSceneId).toArray(),
    db.operators.toArray(),
  ]);
  const preview = buildMergePreview(
    earlier,
    later,
    earlierRoles,
    laterRoles,
    earlierCues,
    laterCues,
    operators,
    mergedTitle,
  );
  return { ok: true, conflicts: preview.conflicts, preview };
}

/** 合并提交结果 */
export interface MergeCommitResult {
  ok: boolean;
  conflicts: OperatorConflict[];
  mergedSceneId: string | null;
}

/**
 * 原子提交相邻场次合并：
 * 1. 合并场次（id 沿前一场）、角色（后一场改挂）、锣鼓点（后一场顺延）
 * 2. 删除后一场，后续场次 seq 前移
 * 3. 写入合并快照（含基线指纹）
 * 全部在同一个 Dexie 事务内，失败整体回滚，不留半套数据。
 */
export async function commitMergeScenes(
  playId: string,
  earlierSceneId: string,
  laterSceneId: string,
  mergedTitle: string,
): Promise<MergeCommitResult> {
  const previewResult = await previewMergeScenes(playId, earlierSceneId, laterSceneId, mergedTitle);
  if (!previewResult.ok || !previewResult.preview) {
    return { ok: false, conflicts: [], mergedSceneId: null };
  }
  if (previewResult.conflicts.length > 0) {
    return { ok: false, conflicts: previewResult.conflicts, mergedSceneId: null };
  }
  const { preview } = previewResult;
  const stamp = nowIso();
  const snapshot: MergeSnapshotRow = {
    id: playId,
    playId,
    mergedAt: stamp,
    mergedSceneId: preview.mergedScene.id,
    scenes: [preview.earlier, preview.later],
    roles: [...preview.earlierRoles, ...preview.laterRoles],
    cues: [...preview.earlierCues, ...preview.laterCues],
    baseline: {
      scene: preview.mergedScene,
      roles: [...preview.mergedRoles],
      cues: [...preview.mergedCues],
    },
    fingerprint: '',
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  snapshot.fingerprint = hashString(fingerprintOfBaseline(snapshot.baseline));

  await db.transaction(
    'rw',
    db.scenes,
    db.roles,
    db.cues,
    db.mergeSnapshots,
    async () => {
      // 写入合并后的场次（沿前一场 id）
      await db.scenes.put(preview.mergedScene);
      // 写入合并后的角色（前一场保留，后一场改挂）
      await db.roles.bulkPut(preview.mergedRoles);
      // 写入合并后的锣鼓点（后一场顺延）
      await db.cues.bulkPut(preview.mergedCues);
      // 删除后一场
      await db.scenes.delete(laterSceneId);
      // 后续场次 seq 前移
      const remaining = await db.scenes.where('playId').equals(playId).toArray();
      const resequenced = resequenceAfterMerge(remaining, laterSceneId);
      if (resequenced.length > 0) await db.scenes.bulkPut(resequenced);
      // 写入合并快照
      await db.mergeSnapshots.put(snapshot);
    },
  );

  return { ok: true, conflicts: [], mergedSceneId: preview.mergedScene.id };
}

/** 撤回预览结果 */
export interface UndoPreviewResult {
  ok: boolean;
  /** 是否可以直接撤回 */
  undoable: boolean;
  /** 已改动时的变更清单（undoable=false 时非空） */
  changes: string[];
  snapshot: MergeSnapshotRow | null;
}

/**
 * 撤回预览：读取合并快照，比对合并后是否被改动。
 * - 未改动 → undoable=true，可安全撤回
 * - 已改动 → undoable=false，changes 列出具体变化，拒绝撤回
 */
export async function previewUndoMerge(playId: string): Promise<UndoPreviewResult> {
  const snapshot = await getMergeSnapshot(playId);
  if (!snapshot) return { ok: false, undoable: false, changes: [], snapshot: null };

  const mergedScene = await db.scenes.get(snapshot.mergedSceneId);
  if (!mergedScene) {
    // 合并场已被删除，快照失效
    await deleteMergeSnapshot(playId);
    return { ok: false, undoable: false, changes: ['合并后的场次已被删除，无法撤回'], snapshot: null };
  }
  const [currentRoles, currentCues] = await Promise.all([
    db.roles.where('sceneId').equals(snapshot.mergedSceneId).toArray(),
    db.cues.where('sceneId').equals(snapshot.mergedSceneId).toArray(),
  ]);
  const currentFingerprint = hashString(
    fingerprintOfBaseline({ scene: mergedScene, roles: currentRoles, cues: currentCues }),
  );
  if (currentFingerprint === snapshot.fingerprint) {
    return { ok: true, undoable: true, changes: [], snapshot };
  }
  const changes = diffBaseline(snapshot.baseline, {
    scene: mergedScene,
    roles: currentRoles,
    cues: currentCues,
  });
  return { ok: true, undoable: false, changes, snapshot };
}

/**
 * 原子撤回合并：恢复合并前的两场（原 id / seq / 角色 / 锣鼓点），
 * 删除合并场及其角色 / 锣鼓点，后续场次 seq 还原，删除快照。
 * 全部在同一个 Dexie 事务内，失败整体回滚。
 */
export async function commitUndoMerge(playId: string): Promise<{ ok: boolean; changes: string[] }> {
  const preview = await previewUndoMerge(playId);
  if (!preview.ok || !preview.snapshot) return { ok: false, changes: preview.changes };
  if (!preview.undoable) return { ok: false, changes: preview.changes };

  const { snapshot } = preview;
  const stamp = nowIso();

  await db.transaction(
    'rw',
    db.scenes,
    db.roles,
    db.cues,
    db.mergeSnapshots,
    async () => {
      // 删除合并场及其角色 / 锣鼓点
      await db.roles.where('sceneId').equals(snapshot.mergedSceneId).delete();
      await db.cues.where('sceneId').equals(snapshot.mergedSceneId).delete();
      await db.scenes.delete(snapshot.mergedSceneId);
      // 恢复合并前的两场（原 id / seq）
      await db.scenes.bulkPut(snapshot.scenes.map((scene) => ({ ...scene, updatedAt: stamp })));
      // 恢复合并前的角色（原 sceneId）
      await db.roles.bulkPut(snapshot.roles.map((role) => ({ ...role, updatedAt: stamp })));
      // 恢复合并前的锣鼓点（原 sceneId / atSecond）
      await db.cues.bulkPut(snapshot.cues.map((cue) => ({ ...cue, updatedAt: stamp })));
      // 后续场次 seq 还原
      const remaining = await db.scenes.where('playId').equals(playId).toArray();
      const resequenced = resequenceAfterUndo(remaining);
      if (resequenced.length > 0) await db.scenes.bulkPut(resequenced);
      // 删除快照
      await db.mergeSnapshots.delete(playId);
    },
  );

  return { ok: true, changes: [] };
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  /** 快照标识，固定为数据库名 */
  name: string;
  schemaVersion: number;
  exportedAt: string;
  plays: Play[];
  scenes: Scene[];
  roles: ShadowRole[];
  operators: Operator[];
  cues: PercussionCue[];
}

/** 导出整库快照（去掉内部 revision 字段） */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [plays, scenes, roles, operators, cues] = await Promise.all([
    db.plays.toArray(),
    db.scenes.toArray(),
    db.roles.toArray(),
    db.operators.toArray(),
    db.cues.toArray(),
  ]);
  const strip = <T extends Revisioned>(row: T): Omit<T, 'revision'> => {
    const { revision: _revision, ...rest } = row;
    return rest;
  };
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    plays: plays.map(strip),
    scenes: scenes.map(strip),
    roles: roles.map(strip),
    operators: operators.map(strip),
    cues: cues.map(strip),
  };
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.plays, db.scenes, db.roles, db.operators, db.cues, db.mergeSnapshots], async () => {
    await Promise.all([
      db.plays.clear(),
      db.scenes.clear(),
      db.roles.clear(),
      db.operators.clear(),
      db.cues.clear(),
      db.mergeSnapshots.clear(),
    ]);
    const rev = <T>(row: T): T & Revisioned => ({ ...row, revision: ROW_REVISION });
    await db.plays.bulkPut(snapshot.plays.map(rev));
    await db.scenes.bulkPut(snapshot.scenes.map(rev));
    await db.roles.bulkPut(snapshot.roles.map(rev));
    await db.operators.bulkPut(snapshot.operators.map(rev));
    await db.cues.bulkPut(snapshot.cues.map(rev));
  });
}

/** 清空全部数据并重新灌入示例数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.plays, db.scenes, db.roles, db.operators, db.cues, db.mergeSnapshots], async () => {
    await Promise.all([
      db.plays.clear(),
      db.scenes.clear(),
      db.roles.clear(),
      db.operators.clear(),
      db.cues.clear(),
      db.mergeSnapshots.clear(),
    ]);
  });
  await seedDatabase();
}

/** 粗略统计各表行数，用于页脚与概览展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [plays, scenes, roles, operators, cues] = await Promise.all([
    db.plays.count(),
    db.scenes.count(),
    db.roles.count(),
    db.operators.count(),
    db.cues.count(),
  ]);
  return { plays, scenes, roles, operators, cues };
}
