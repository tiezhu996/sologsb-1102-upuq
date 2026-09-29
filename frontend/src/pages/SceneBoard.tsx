/**
 * /plays/:id/scenes 场次拆分与调序
 * 左列场序（拖拽调序 + 勾选本次排练覆盖），右侧场次明细；消费 Scene、Play，复用 <SceneCard>。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Col,
  Divider,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Progress,
  Row,
  Select,
  Slider,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckSquareOutlined,
  MergeCellsOutlined,
  PlusOutlined,
  RollbackOutlined,
  SaveOutlined,
  SoundOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { SceneCard } from '../components/common/SceneCard';
import { EmptyState } from '../components/common/EmptyState';
import { useSceneOrder } from '../hooks/useSceneOrder';
import { usePlayStore } from '../stores/playStore';
import { useSceneStore } from '../stores/sceneStore';
import { useOperatorStore } from '../stores/operatorStore';
import { ROUTES } from '../router';
import { SHADOW_SCREEN_LABEL, SHADOW_SCREEN_OPTIONS, type SceneDraft, createEmptySceneDraft } from '../types/scene';
import { minutesToReadable, secondsToTimecode } from '../utils/timecode';
import { formatStamp } from '../utils/uuid';
import {
  getMergeUndo,
  mergeAdjacentScenes,
  previewAdjacentMerge,
  undoSceneMerge,
  type EntityChange,
  type MergeOperatorConflict,
} from '../utils/sceneMerge';
import type { SceneRow } from '../utils/db';

export default function SceneBoard() {
  const { id: playId = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<SceneDraft>();

  const plays = usePlayStore((state) => state.plays);
  const selectPlay = usePlayStore((state) => state.selectPlay);
  const syncSceneCount = usePlayStore((state) => state.syncSceneCount);
  const statOf = usePlayStore((state) => state.statOf);

  const {
    items,
    scenes,
    selectedSceneIds,
    selectedMinute,
    totalMinute,
    totalReadable,
    loading,
    reorder,
    adjacentMinute,
    toggleSelected,
    selectAll,
    clearSelected,
  } = useSceneOrder(playId);

  const createSceneFromPrevious = useSceneStore((state) => state.createSceneFromPrevious);
  const updateScene = useSceneStore((state) => state.updateScene);
  const deleteScene = useSceneStore((state) => state.deleteScene);
  const bumpProgress = useSceneStore((state) => state.bumpProgress);
  const loadScenes = useSceneStore((state) => state.loadScenes);
  const onlySelected = useSceneStore((state) => state.onlySelected);
  const setOnlySelected = useSceneStore((state) => state.setOnlySelected);

  const operators = useOperatorStore((state) => state.operators);
  const loadPlays = usePlayStore((state) => state.loadPlays);

  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [undoRecord, setUndoRecord] = useState(() => getMergeUndo(playId));

  const play = plays.find((item) => item.id === playId) ?? null;
  const playStat = statOf(playId);

  useEffect(() => {
    if (playId) selectPlay(playId);
  }, [playId, selectPlay]);

  useEffect(() => {
    setUndoRecord(getMergeUndo(playId));
  }, [playId, scenes.length]);

  useEffect(() => {
    if (scenes.length > 0 && (activeSceneId === null || !scenes.some((scene) => scene.id === activeSceneId))) {
      setActiveSceneId(scenes[0].id);
    }
    if (scenes.length === 0) setActiveSceneId(null);
  }, [scenes, activeSceneId]);

  useEffect(() => {
    if (playId && !loading) void syncSceneCount(playId);
  }, [playId, loading, syncSceneCount]);

  const activeItem = useMemo(() => items.find((item) => item.scene.id === activeSceneId) ?? null, [items, activeSceneId]);
  const visibleItems = onlySelected ? items.filter((item) => selectedSceneIds.includes(item.scene.id)) : items;

  const handleReorder = async (targetId: string) => {
    if (!draggingId || draggingId === targetId) return;
    const ids = items.map((item) => item.scene.id);
    const fromIndex = ids.indexOf(draggingId);
    const toIndex = ids.indexOf(targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...ids];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, draggingId);
    await reorder(next);
    message.success('场序已调整');
  };

  const handleCreate = async () => {
    const values = await form.validateFields();
    const last = scenes.length > 0 ? scenes[scenes.length - 1] : undefined;
    const created = await createSceneFromPrevious(playId, last);
    await updateScene(created.id, {
      title: values.title.trim() || created.title,
      durationMin: values.durationMin,
      stageNote: values.stageNote ?? '',
      needsShadowScreen: values.needsShadowScreen,
      progress: values.progress ?? 0,
    });
    setCreateOpen(false);
    setActiveSceneId(created.id);
    message.success(`已新增「${values.title.trim() || created.title}」`);
  };

  /** 打开新增弹窗：先落一次初始值，避免弹窗内残留上一次的输入 */
  const openCreate = () => {
    form.setFieldsValue(createEmptySceneDraft(scenes.length + 1));
    setCreateOpen(true);
  };

  const closeCreate = () => {
    setCreateOpen(false);
    form.resetFields();
  };

  const confirmDelete = (sceneId: string, title: string) => {
    modal.confirm({
      title: `删除「${title}」？`,
      content: '该场次下的影人角色与锣鼓点会一并删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteScene(sceneId);
        message.success('场次已删除，场序已重排');
      },
    });
  };

  /** 合并相邻两场：先只读预检操耍人冲突，冲突拒绝并点明角色；通过后确认再原子写入 */
  const requestMerge = async (leftId: string) => {
    setMergeBusy(true);
    try {
      const preview = await previewAdjacentMerge(
        playId,
        leftId,
        (operatorId) => operators.find((operator) => operator.id === operatorId)?.name ?? '未具名师傅',
      );
      if (!preview.ok) {
        if (preview.blocked) showConflictModal(preview.conflicts);
        else message.warning(preview.error);
        return;
      }
      modal.confirm({
        title: '合并相邻场次',
        width: 560,
        okText: '确认合并',
        cancelText: '取消',
        content: <MergeConfirmContent left={preview.left} right={preview.right} />,
        onOk: () => doMerge(leftId),
      });
    } catch (error) {
      message.error(`预检失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setMergeBusy(false);
    }
  };

  const doMerge = async (leftId: string) => {
    try {
      const result = await mergeAdjacentScenes(
        playId,
        leftId,
        (operatorId) => operators.find((operator) => operator.id === operatorId)?.name ?? '未具名师傅',
      );
      if (result.ok) {
        await loadScenes(playId);
        await loadPlays();
        setUndoRecord(getMergeUndo(playId));
        setActiveSceneId(result.plan.mergedScene.id);
        message.success(
          `已合并为「${result.plan.mergedScene.title}」：角色已并入、后场鼓点顺延 ${secondsToTimecode(
            result.plan.leftScene.durationMin * 60,
          )}`,
        );
      } else if (result.blocked) {
        // 预检通过后、确认前若指派又被改动，这里兜底拦截
        showConflictModal(result.conflicts);
      } else {
        message.error(result.error);
      }
    } catch (error) {
      message.error(`合并失败，数据未改动：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  /** 冲突弹窗：拒绝合并并逐一点名操耍人在两场的角色 */
  const showConflictModal = (conflicts: MergeOperatorConflict[]) => {
    modal.warning({
      title: '合并已拒绝：操耍人会兼顾两个角色',
      width: 560,
      okText: '知道了',
      content: (
        <Space direction="vertical" size={10} style={{ marginTop: 8 }}>
          <Typography.Text type="secondary">
            同一操耍人在相邻两场承担不同角色，合并后该场次要兼顾两个影人，无法同时操耍。请先调整角色指派：
          </Typography.Text>
          <List
            size="small"
            bordered
            dataSource={conflicts}
            renderItem={(conflict) => (
              <List.Item>
                <Space direction="vertical" size={2}>
                  <Typography.Text strong>{conflict.operatorName}</Typography.Text>
                  <Space size={6} wrap>
                    <Tag color="gold">前场：{conflict.leftRoles.join('、') || '—'}</Tag>
                    <Tag color="#7a1f1f">后场：{conflict.rightRoles.join('、') || '—'}</Tag>
                  </Space>
                </Space>
              </List.Item>
            )}
          />
        </Space>
      ),
    });
  };

  /** 撤回合并：未再改可一键回到合并前；已改动则列出变化并拒绝 */
  const requestUndo = () => {
    const record = getMergeUndo(playId);
    if (!record) {
      message.info('当前剧目暂无可撤回的合并');
      return;
    }
    modal.confirm({
      title: '撤回最近一次场次合并？',
      width: 520,
      okText: '撤回合并',
      cancelText: '取消',
      content: (
        <Space direction="vertical" size={6}>
          <Typography.Text>
            将恢复为合并前的两场：
            <Tag color="gold">{record.leftTitle}</Tag>
            <Tag color="gold">{record.rightTitle}</Tag>
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            合并发生于 {formatStamp(record.mergedAt)}。若合并后又改过场次、角色或锣鼓点，将拒绝撤回并列出变化。
          </Typography.Text>
        </Space>
      ),
      onOk: () => void doUndo(),
    });
  };

  const doUndo = async () => {
    setMergeBusy(true);
    try {
      const result = await undoSceneMerge(playId);
      if (result.ok) {
        await loadScenes(playId);
        await loadPlays();
        setUndoRecord(null);
        message.success('已撤回合并，恢复为合并前的两场与原始角色、鼓点');
      } else if (result.blocked) {
        showUndoBlockedModal(result.diff.changes.map((change) => formatChange(change)));
      } else {
        message.error(result.error);
      }
    } catch (error) {
      message.error(`撤回失败，数据未改动：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setMergeBusy(false);
    }
  };

  const showUndoBlockedModal = (lines: string[]) => {
    modal.warning({
      title: '撤回已拒绝：合并后又有改动',
      width: 580,
      okText: '知道了',
      content: (
        <Space direction="vertical" size={10} style={{ marginTop: 8 }}>
          <Typography.Text type="secondary">
            为避免覆盖新改动，不会回滚到合并前。检测到与刚合并完时相比有以下出入：
          </Typography.Text>
          <List
            size="small"
            bordered
            dataSource={lines}
            renderItem={(line) => <List.Item>{line}</List.Item>}
          />
        </Space>
      ),
    });
  };

  if (!play) {
    return (
      <div className="gb-panel">
        <EmptyState
          title="未找到该剧目"
          description="剧目可能已被删除，请回到剧目库重新选择。"
          actionText="回到剧目库"
          onAction={() => navigate(ROUTES.plays)}
        />
      </div>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="gb-panel">
        <div className="gb-panel-title">
          <Space size={10} wrap>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(ROUTES.plays)}>
              剧目库
            </Button>
            <Typography.Title level={4} style={{ margin: 0 }}>
              场次拆分 · {play.title}
            </Typography.Title>
            <Tag color="gold">共 {scenes.length} 场 / 建档 {play.totalScenes} 场</Tag>
            <Tag>合计 {totalReadable}</Tag>
          </Space>
          <Space wrap>
            <Button icon={<PlusOutlined />} type="primary" onClick={openCreate}>
              新增场次
            </Button>
            <Button
              icon={<RollbackOutlined />}
              disabled={!undoRecord || mergeBusy}
              onClick={requestUndo}
            >
              撤回合并{undoRecord ? `（${formatStamp(undoRecord.mergedAt)}）` : ''}
            </Button>
            <Button
              icon={<TeamOutlined />}
              disabled={!activeSceneId}
              onClick={() => activeSceneId && navigate(ROUTES.roles(activeSceneId))}
            >
              角色指派
            </Button>
            <Button
              icon={<SoundOutlined />}
              disabled={!activeSceneId}
              onClick={() => activeSceneId && navigate(ROUTES.cues(activeSceneId))}
            >
              锣鼓点
            </Button>
          </Space>
        </div>

        <Row gutter={16}>
          <Col xs={12} md={6}>
            <Statistic title="整剧合计时长" value={totalMinute} suffix="分钟" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="本次排练勾选" value={selectedSceneIds.length} suffix={`/ ${scenes.length} 场`} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="勾选场次合计" value={selectedMinute} suffix="分钟" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="平均排练成熟度" value={playStat.averageProgress} suffix="%" />
          </Col>
        </Row>

        <Divider style={{ margin: '14px 0 10px' }} />
        <Space wrap size={10}>
          <Checkbox checked={onlySelected} onChange={(event) => setOnlySelected(event.target.checked)}>
            只看本次勾选
          </Checkbox>
          <Button size="small" icon={<CheckSquareOutlined />} onClick={selectAll}>
            全选本次排练
          </Button>
          <Button size="small" onClick={clearSelected}>
            清空勾选
          </Button>
          <Typography.Text type="secondary">
            相邻两场合计参考：
            {items.length > 1
              ? `第1+2场 ${minutesToReadable(adjacentMinute(0))}、第2+3场 ${
                  items.length > 2 ? minutesToReadable(adjacentMinute(1)) : '—'
                }`
              : '—'}
          </Typography.Text>
        </Space>
      </div>

      {scenes.length === 0 ? (
        <div className="gb-panel">
          <EmptyState
            title="这出戏还没有场次"
            description="把剧目拆成场次后，才能为每场指派影人操耍人与锣鼓点。"
            actionText="新增第一场"
            onAction={openCreate}
          />
        </div>
      ) : (
        <Row gutter={16}>
          <Col xs={24} lg={13}>
            <div className="gb-panel">
              <div className="gb-panel-title">
                <Typography.Text strong>场序表（拖动手柄可调序）</Typography.Text>
                <Space size={8}>
                  <Tag>{visibleItems.length} 场可见</Tag>
                  <Tag color="gold">勾选 {selectedSceneIds.length} 场</Tag>
                </Space>
              </div>
              <div className="gb-scene-list">
                {visibleItems.length === 0 ? (
                  <EmptyState
                    size="small"
                    title="勾选为空"
                    description="已开启「只看本次勾选」，请先在场序表中勾选本次排练覆盖的场次。"
                    actionText="显示全部场次"
                    onAction={() => setOnlySelected(false)}
                  />
                ) : (
                  visibleItems.map((item, index) => (
                    <div
                      key={item.scene.id}
                      className={`gb-scene-row ${dropTargetId === item.scene.id ? 'is-drop-target' : ''}`}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDropTargetId(item.scene.id);
                      }}
                      onDragLeave={() => setDropTargetId((prev) => (prev === item.scene.id ? null : prev))}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDropTargetId(null);
                        void handleReorder(item.scene.id);
                      }}
                    >
                      <TinyOrderIndex index={index} total={visibleItems.length} />
                      <div style={{ flex: 1 }}>
                        <SceneCard
                          scene={item.scene}
                          startTimecode={item.startTimecode}
                          endTimecode={item.endTimecode}
                          roleCount={0}
                          cueCount={0}
                          selected={selectedSceneIds.includes(item.scene.id)}
                          selectable
                          draggable
                          dragging={draggingId === item.scene.id}
                          onToggleSelect={() => toggleSelected(item.scene.id)}
                          onOpen={() => setActiveSceneId(item.scene.id)}
                          onEdit={() => setActiveSceneId(item.scene.id)}
                          onDelete={() => confirmDelete(item.scene.id, item.scene.title)}
                          onDragStart={() => setDraggingId(item.scene.id)}
                          onDragEnd={() => {
                            setDraggingId(null);
                            setDropTargetId(null);
                          }}
                          onDrop={() => {
                            void handleReorder(item.scene.id);
                          }}
                          extraActions={
                            <Space size={4}>
                              {(() => {
                                const fullIndex = scenes.findIndex((scene) => scene.id === item.scene.id);
                                const nextScene = fullIndex >= 0 ? scenes[fullIndex + 1] : undefined;
                                return nextScene ? (
                                  <Tooltip
                                    title={`与下场「${nextScene.title}」合并：角色并入，后场鼓点整体顺延 ${minutesToReadable(
                                      item.scene.durationMin,
                                    )}`}
                                  >
                                    <Button
                                      size="small"
                                      type="text"
                                      icon={<MergeCellsOutlined />}
                                      loading={mergeBusy}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void requestMerge(item.scene.id);
                                      }}
                                    >
                                      合下场
                                    </Button>
                                  </Tooltip>
                                ) : null;
                              })()}
                              <Tag color={selectedSceneIds.includes(item.scene.id) ? '#7a1f1f' : 'default'}>
                                {selectedSceneIds.includes(item.scene.id) ? '本次排练' : '本次跳过'}
                              </Tag>
                            </Space>
                          }
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Col>

          <Col xs={24} lg={11}>
            <div className="gb-panel">
              {activeItem ? (
                <SceneDetailPanel
                  key={activeItem.scene.id}
                  sceneId={activeItem.scene.id}
                  startTimecode={activeItem.startTimecode}
                  accumulatedMinute={activeItem.accumulatedMinute}
                  operatorCount={operators.length}
                  onSave={updateScene}
                  onProgress={(delta) => void bumpProgress(activeItem.scene.id, delta)}
                  onDelete={() => confirmDelete(activeItem.scene.id, activeItem.scene.title)}
                  onRoles={() => navigate(ROUTES.roles(activeItem.scene.id))}
                  onCues={() => navigate(ROUTES.cues(activeItem.scene.id))}
                />
              ) : (
                <EmptyState
                  size="small"
                  title="请选择左侧场次"
                  description="选中场次后可编辑舞台提示、影窗规格与排练进度。"
                />
              )}
            </div>
          </Col>
        </Row>
      )}

      <Modal
        open={createOpen}
        title={`新增场次（当前共 ${scenes.length} 场）`}
        okText="新增"
        cancelText="取消"
        onCancel={closeCreate}
        onOk={() => void handleCreate()}
      >
        <Form form={form} layout="vertical" initialValues={createEmptySceneDraft(scenes.length + 1)}>
          <Form.Item name="title" label="场次标题" rules={[{ required: true, message: '请填写场次标题' }]}>
            <Input placeholder="如：第四场·断桥" />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="durationMin" label="时长（分钟）" rules={[{ required: true, message: '请填写时长' }]}>
                <InputNumber min={1} max={180} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="needsShadowScreen" label="影窗规格" rules={[{ required: true, message: '请选择影窗规格' }]}>
                <Select options={[...SHADOW_SCREEN_OPTIONS]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="stageNote" label="舞台提示">
            <Input.TextArea rows={3} placeholder="影件更换、走位、灯暗留白等提示" />
          </Form.Item>
          <Form.Item name="progress" label="初始排练进度（%）">
            <Slider min={0} max={100} step={5} marks={{ 0: '0', 50: '50', 100: '100' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

/** 合并确认弹窗内容：合并规则一览，让用户知道角色与鼓点会如何落位 */
function MergeConfirmContent({ left, right }: { left: SceneRow; right: SceneRow }) {
  return (
    <Space direction="vertical" size={10} style={{ marginTop: 4 }}>
      <Space size={6} wrap>
        <Tag color="gold">{left.title}</Tag>
        <Typography.Text type="secondary">＋</Typography.Text>
        <Tag color="gold">{right.title}</Tag>
      </Space>
      <div>
        <Typography.Text type="secondary">合并后</Typography.Text>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          <li>合为一场，沿用前场标题与影窗规格，时长合计 {left.durationMin + right.durationMin} 分钟；</li>
          <li>后场角色原样并入，行当、影件、唱白要点与操耍人指派不丢；</li>
          <li>
            后场锣鼓点整体顺延 {secondsToTimecode(left.durationMin * 60)}（前场时长），前场鼓点不动；
          </li>
          <li>后续场序自动重排。若同一操耍人因此兼顾两个角色，会直接拒绝合并。</li>
        </ul>
      </div>
      {left.needsShadowScreen !== right.needsShadowScreen ? (
        <Alert
          type="warning"
          showIcon
          message={`两场影窗规格不同（${SHADOW_SCREEN_LABEL[left.needsShadowScreen]} / ${SHADOW_SCREEN_LABEL[right.needsShadowScreen]}），将沿用前场规格，合并后请核对舞美。`}
        />
      ) : null}
    </Space>
  );
}

/** 把撤回核对得到的变化条目格式化成中文行 */
function formatChange(change: EntityChange): string {
  const verb = change.kind === 'added' ? '新增' : change.kind === 'removed' ? '删除' : '改动';
  return `${verb} ${change.label}${change.detail ? `（${change.detail}）` : ''}`;
}

/** 左侧列表的场序角标 */
function TinyOrderIndex({ index, total }: { index: number; total: number }) {
  return (
    <div style={{ width: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#7a1f1f', lineHeight: 1.1 }}>{index + 1}</div>
      <div style={{ fontSize: 11, color: 'rgba(0,0,0,0.45)' }}>/ {total}</div>
    </div>
  );
}

interface SceneDetailPanelProps {
  sceneId: string;
  startTimecode: string;
  accumulatedMinute: number;
  operatorCount: number;
  onSave: (
    sceneId: string,
    patch: Partial<Omit<SceneRow, 'id' | 'playId' | 'createdAt' | 'revision'>>,
  ) => Promise<void>;
  onProgress: (delta: number) => void;
  onDelete: () => void;
  onRoles: () => void;
  onCues: () => void;
}

function SceneDetailPanel({
  sceneId,
  startTimecode,
  accumulatedMinute,
  operatorCount,
  onSave,
  onProgress,
  onDelete,
  onRoles,
  onCues,
}: SceneDetailPanelProps) {
  const { message } = App.useApp();
  const scene = useSceneStore((state) => state.scenes.find((item) => item.id === sceneId) ?? null);
  const [title, setTitle] = useState(scene?.title ?? '');
  const [durationMin, setDurationMin] = useState(scene?.durationMin ?? 12);
  const [stageNote, setStageNote] = useState(scene?.stageNote ?? '');
  const [screen, setScreen] = useState(scene?.needsShadowScreen ?? 'standard');
  const [saving, setSaving] = useState(false);

  if (!scene) return null;

  const dirty =
    title !== scene.title ||
    durationMin !== scene.durationMin ||
    stageNote !== scene.stageNote ||
    screen !== scene.needsShadowScreen;

  const save = async () => {
    setSaving(true);
    await onSave(sceneId, {
      title: title.trim() || scene.title,
      durationMin: Math.max(1, Math.round(durationMin)),
      stageNote: stageNote.trim(),
      needsShadowScreen: screen,
    });
    setSaving(false);
    message.success('场次明细已保存');
  };

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
        <Typography.Text strong>
          第 {scene.seq} 场明细（开场 {startTimecode}｜累计 {minutesToReadable(accumulatedMinute)}）
        </Typography.Text>
        <Tag>更新于 {formatStamp(scene.updatedAt)}</Tag>
      </Space>

      <div>
        <Typography.Text type="secondary">场次标题</Typography.Text>
        <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={40} />
      </div>

      <Row gutter={12}>
        <Col span={12}>
          <Typography.Text type="secondary">时长（分钟）</Typography.Text>
          <InputNumber
            min={1}
            max={180}
            style={{ width: '100%' }}
            value={durationMin}
            onChange={(value) => setDurationMin(typeof value === 'number' ? value : 12)}
          />
        </Col>
        <Col span={12}>
          <Typography.Text type="secondary">影窗规格</Typography.Text>
          <Select
            style={{ width: '100%' }}
            value={screen}
            onChange={(value) => setScreen(value)}
            options={[...SHADOW_SCREEN_OPTIONS]}
          />
        </Col>
      </Row>

      <div>
        <Typography.Text type="secondary">舞台提示</Typography.Text>
        <Input.TextArea
          rows={4}
          value={stageNote}
          maxLength={200}
          showCount
          onChange={(event) => setStageNote(event.target.value)}
        />
      </div>

      <div>
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Typography.Text type="secondary">排练进度</Typography.Text>
          <Space size={4}>
            <Button size="small" onClick={() => onProgress(-10)}>
              -10%
            </Button>
            <Button size="small" type="primary" ghost onClick={() => onProgress(10)}>
              +10%
            </Button>
            <Button size="small" onClick={() => void onSave(sceneId, { progress: 100 })}>
              标记可上演
            </Button>
          </Space>
        </Space>
        <Progress percent={scene.progress} strokeColor="#7a1f1f" />
      </div>

      <Space wrap>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!dirty} onClick={() => void save()}>
          保存明细
        </Button>
        <Button icon={<TeamOutlined />} onClick={onRoles}>
          指派影人（操耍人档 {operatorCount} 人）
        </Button>
        <Button icon={<SoundOutlined />} onClick={onCues}>
          编排锣鼓点
        </Button>
        <Button danger onClick={onDelete}>
          删除本场
        </Button>
      </Space>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        当前影窗：{SHADOW_SCREEN_LABEL[scene.needsShadowScreen]}；修改场序请拖动左侧手柄，场序会自动重排并落库。
      </Typography.Text>
    </Space>
  );
}
