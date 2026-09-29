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

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2;

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

export const ROW_REVISION = 2;

class ShadowPlayDatabase extends Dexie {
  plays!: Table<PlayRow, string>;
  scenes!: Table<SceneRow, string>;
  roles!: Table<RoleRow, string>;
  operators!: Table<OperatorRow, string>;
  cues!: Table<CueRow, string>;

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
    this.version(DB_SCHEMA_VERSION)
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
            row.revision = ROW_REVISION;
            if (typeof row.updatedAt !== 'string') row.updatedAt = nowIso();
            if (typeof row.createdAt !== 'string') row.createdAt = row.updatedAt;
          });
        }
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
  await db.transaction('rw', db.plays, db.scenes, db.roles, db.cues, async () => {
    const scenes = await db.scenes.where('playId').equals(id).toArray();
    const sceneIds = scenes.map((scene) => scene.id);
    if (sceneIds.length > 0) {
      await db.roles.where('sceneId').anyOf(sceneIds).delete();
      await db.cues.where('sceneId').anyOf(sceneIds).delete();
    }
    await db.scenes.where('playId').equals(id).delete();
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

/** 单剧目数据束（场次 + 角色 + 锣鼓点），供相邻场次合并与合并前快照使用 */
export interface PlayBundle {
  scenes: SceneRow[];
  roles: RoleRow[];
  cues: CueRow[];
}

/** 读取单剧目的完整数据束（按场序、秒点排好序），用于合并前快照与撤回核对 */
export async function getPlayBundle(playId: string): Promise<PlayBundle> {
  const scenes = await listScenesByPlay(playId);
  if (scenes.length === 0) return { scenes: [], roles: [], cues: [] };
  const sceneIds = scenes.map((scene) => scene.id);
  const [roles, cues] = await Promise.all([listRolesByScenes(sceneIds), db.cues.where('sceneId').anyOf(sceneIds).toArray()]);
  return {
    scenes,
    roles,
    cues: cues.sort((a, b) => a.atSecond - b.atSecond),
  };
}

/**
 * 原子执行相邻场次合并：
 * 一次事务内写合并场、迁移角色、顺延后场鼓点、删除次场、重排后续场序、同步剧目场次数。
 * 任一步失败整体回滚，不会留下半套数据。所有写入行由 sceneMerge 统一预生成，
 * 保证与内存里的「合并后预期数据束」逐字段一致，供撤回时核对。
 */
export async function mergeAdjacentScenesAtomic(input: {
  playId: string;
  mergedScene: SceneRow;
  removedScene: SceneRow;
  movedRoles: RoleRow[];
  shiftedCues: CueRow[];
  rescenes: SceneRow[];
  nextSceneCount: number;
}): Promise<void> {
  const { playId, mergedScene, removedScene, movedRoles, shiftedCues, rescenes, nextSceneCount } = input;
  await db.transaction('rw', db.plays, db.scenes, db.roles, db.cues, async () => {
    const play = await db.plays.get(playId);
    if (!play) throw new Error('未找到剧目，合并已取消');
    const [left, right] = await Promise.all([db.scenes.get(mergedScene.id), db.scenes.get(removedScene.id)]);
    if (!left || !right || left.playId !== playId || right.playId !== playId || right.seq !== left.seq + 1) {
      throw new Error('待合并场次已变化或不再相邻，合并已取消');
    }
    // 角色与鼓点必须仍挂在次场名下，且数量与计划完全一致，
    // 防止计划生成后数据被改过（新增/挪走）而漏迁或留下挂在已删场次上的孤儿行
    const [ownedRoles, ownedCues, rightRoleCount, rightCueCount] = await Promise.all([
      db.roles.where('id').anyOf(movedRoles.map((role) => role.id)).toArray(),
      db.cues.where('id').anyOf(shiftedCues.map((cue) => cue.id)).toArray(),
      db.roles.where('sceneId').equals(removedScene.id).count(),
      db.cues.where('sceneId').equals(removedScene.id).count(),
    ]);
    const roleStillOnRight =
      ownedRoles.length !== movedRoles.length ||
      rightRoleCount !== movedRoles.length ||
      ownedRoles.some((role) => role.sceneId !== removedScene.id);
    const cueStillOnRight =
      ownedCues.length !== shiftedCues.length ||
      rightCueCount !== shiftedCues.length ||
      ownedCues.some((cue) => cue.sceneId !== removedScene.id);
    if (roleStillOnRight || cueStillOnRight) throw new Error('角色或锣鼓点归属已变化，合并已取消');

    // 角色：原样迁入前场（只改 sceneId），保留全部影人字段不丢不漏
    if (movedRoles.length > 0) await db.roles.bulkPut(movedRoles);
    // 鼓点：后场鼓点整体顺延前场时长，前场鼓点不动
    if (shiftedCues.length > 0) await db.cues.bulkPut(shiftedCues);

    // 删除次场，并写回合并场与重排后的后续场次
    await db.scenes.delete(removedScene.id);
    await db.scenes.bulkPut([mergedScene, ...rescenes]);

    // 同步剧目建档场次数
    await db.plays.put({
      ...play,
      totalScenes: nextSceneCount,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
  });
}

/** 原子恢复单剧目数据束（撤回合并）：覆盖该剧目下的场次、角色与锣鼓点 */
export async function restorePlayBundle(playId: string, bundle: PlayBundle, sceneCount: number): Promise<void> {
  await db.transaction('rw', db.plays, db.scenes, db.roles, db.cues, async () => {
    const play = await db.plays.get(playId);
    if (!play) throw new Error('未找到剧目，撤回已取消');
    const sceneIds = await db.scenes.where('playId').equals(playId).primaryKeys();
    if (sceneIds.length > 0) {
      await db.roles.where('sceneId').anyOf(sceneIds).delete();
      await db.cues.where('sceneId').anyOf(sceneIds).delete();
    }
    await db.scenes.where('playId').equals(playId).delete();
    await db.scenes.bulkPut(bundle.scenes);
    await db.roles.bulkPut(bundle.roles);
    await db.cues.bulkPut(bundle.cues);
    await db.plays.put({
      ...play,
      totalScenes: sceneCount,
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    });
  });
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
  await db.transaction('rw', db.plays, db.scenes, db.roles, db.operators, db.cues, async () => {
    await Promise.all([
      db.plays.clear(),
      db.scenes.clear(),
      db.roles.clear(),
      db.operators.clear(),
      db.cues.clear(),
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
  await db.transaction('rw', db.plays, db.scenes, db.roles, db.operators, db.cues, async () => {
    await Promise.all([
      db.plays.clear(),
      db.scenes.clear(),
      db.roles.clear(),
      db.operators.clear(),
      db.cues.clear(),
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
