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
  Modal,
  Progress,
  Row,
  Select,
  Slider,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckSquareOutlined,
  PlusOutlined,
  SaveOutlined,
  SoundOutlined,
  TeamOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { SceneCard } from '../components/common/SceneCard';
import { EmptyState } from '../components/common/EmptyState';
import { useSceneOrder } from '../hooks/useSceneOrder';
import { usePlayStore } from '../stores/playStore';
import { useSceneStore } from '../stores/sceneStore';
import { useOperatorStore } from '../stores/operatorStore';
import { ROUTES } from '../router';
import { SHADOW_SCREEN_LABEL, SHADOW_SCREEN_OPTIONS, type SceneDraft, createEmptySceneDraft } from '../types/scene';
import { minutesToReadable } from '../utils/timecode';
import { formatStamp } from '../utils/uuid';
import type { MergePreviewResult, SceneRow } from '../utils/db';

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
  const onlySelected = useSceneStore((state) => state.onlySelected);
  const setOnlySelected = useSceneStore((state) => state.setOnlySelected);
  const mergeSnapshot = useSceneStore((state) => state.mergeSnapshot);
  const loadMergeSnapshot = useSceneStore((state) => state.loadMergeSnapshot);
  const previewMerge = useSceneStore((state) => state.previewMerge);
  const mergeScenes = useSceneStore((state) => state.mergeScenes);
  const previewUndo = useSceneStore((state) => state.previewUndo);
  const undoMerge = useSceneStore((state) => state.undoMerge);

  const operators = useOperatorStore((state) => state.operators);

  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<{ earlierId: string; laterId: string } | null>(null);
  const [mergePreview, setMergePreview] = useState<MergePreviewResult | null>(null);
  const [mergeTitle, setMergeTitle] = useState('');
  const [mergeSubmitting, setMergeSubmitting] = useState(false);

  const play = plays.find((item) => item.id === playId) ?? null;
  const playStat = statOf(playId);

  useEffect(() => {
    if (playId) selectPlay(playId);
  }, [playId, selectPlay]);

  useEffect(() => {
    if (scenes.length > 0 && (activeSceneId === null || !scenes.some((scene) => scene.id === activeSceneId))) {
      setActiveSceneId(scenes[0].id);
    }
    if (scenes.length === 0) setActiveSceneId(null);
  }, [scenes, activeSceneId]);

  useEffect(() => {
    if (playId && !loading) void syncSceneCount(playId);
  }, [playId, loading, syncSceneCount]);

  useEffect(() => {
    if (playId) void loadMergeSnapshot(playId);
  }, [playId, loadMergeSnapshot, scenes.length]);

  const activeItem = useMemo(() => items.find((item) => item.scene.id === activeSceneId) ?? null, [items, activeSceneId]);
  const visibleItems = onlySelected ? items.filter((item) => selectedSceneIds.includes(item.scene.id)) : items;
  const itemIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item, index) => map.set(item.scene.id, index));
    return map;
  }, [items]);

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

  /** 点击「与下一场合并」：先做冲突检测，冲突则拒绝并点明角色 */
  const handleMergeClick = async (earlierId: string, laterId: string) => {
    if (!playId) return;
    const earlier = scenes.find((scene) => scene.id === earlierId);
    const later = scenes.find((scene) => scene.id === laterId);
    if (!earlier || !later) return;
    const result = await previewMerge(playId, earlierId, laterId, earlier.title);
    if (!result.ok || !result.preview) {
      message.error('合并预览失败，请重试');
      return;
    }
    if (result.conflicts.length > 0) {
      const conflictLines = result.conflicts.map(
        (item) =>
          `操耍人「${item.operatorName}」在「${item.earlierSceneTitle}」担纲「${item.earlierRoleName}」，又在「${item.laterSceneTitle}」担纲「${item.laterRoleName}」`,
      );
      modal.error({
        title: '无法合并：同一操耍人兼顾两个角色',
        width: 560,
        content: (
          <Space direction="vertical" size={6} style={{ marginTop: 8 }}>
            <Typography.Text>
              合并后以下操耍人将在同一场次里同时操耍两个影偶，无法兼顾。请先到「角色指派」调整指派后再合并。
            </Typography.Text>
            {conflictLines.map((line, index) => (
              <Typography.Text key={index} type="danger" style={{ fontSize: 13 }}>
                · {line}
              </Typography.Text>
            ))}
          </Space>
        ),
        okText: '知道了',
      });
      return;
    }
    setMergeTarget({ earlierId, laterId });
    setMergePreview(result);
    setMergeTitle(earlier.title);
  };

  /** 确认合并：原子写入合并场次、角色、顺延鼓点 */
  const handleMergeConfirm = async () => {
    if (!playId || !mergeTarget) return;
    setMergeSubmitting(true);
    const result = await mergeScenes(playId, mergeTarget.earlierId, mergeTarget.laterId, mergeTitle);
    setMergeSubmitting(false);
    if (result.ok) {
      message.success('合并完成，可在未改动前撤回');
      setActiveSceneId(mergeTarget.earlierId);
      setMergeTarget(null);
      setMergePreview(null);
    } else {
      modal.error({
        title: '合并失败',
        content: result.conflictNames.length > 0 ? `冲突操耍人：${result.conflictNames.join('、')}` : '写入失败，请重试',
      });
    }
  };

  /** 撤回合并：未改动则可撤回，已改动则列出变化并拒绝 */
  const handleUndoClick = async () => {
    if (!playId) return;
    const preview = await previewUndo(playId);
    if (!preview.ok || !preview.snapshot) {
      message.info('没有可撤回的合并');
      return;
    }
    if (!preview.undoable) {
      modal.error({
        title: '无法撤回：合并后已有改动',
        width: 560,
        content: (
          <Space direction="vertical" size={6} style={{ marginTop: 8 }}>
            <Typography.Text>
              合并后的场次 / 角色 / 锣鼓点已被修改，撤回会丢失这些改动。如需撤回，请先手动恢复后再操作。
            </Typography.Text>
            {preview.changes.map((change, index) => (
              <Typography.Text key={index} type="warning" style={{ fontSize: 13 }}>
                · {change}
              </Typography.Text>
            ))}
          </Space>
        ),
        okText: '知道了',
      });
      return;
    }
    modal.confirm({
      title: '撤回上次合并？',
      content: '将恢复为合并前的两场独立场次，角色与锣鼓点一并还原。',
      okText: '撤回合并',
      cancelText: '取消',
      onOk: async () => {
        const result = await undoMerge(playId);
        if (result.ok) {
          message.success('已撤回，两场恢复原样');
          setActiveSceneId(preview.snapshot?.scenes[0]?.id ?? null);
        } else {
          message.error('撤回失败，请重试');
        }
      },
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
              icon={<UndoOutlined />}
              disabled={!mergeSnapshot}
              onClick={() => void handleUndoClick()}
            >
              撤回合并
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
                          onMergeNext={
                            (() => {
                              const idx = itemIndexMap.get(item.scene.id) ?? -1;
                              const next = idx >= 0 ? items[idx + 1] : undefined;
                              return next ? () => void handleMergeClick(item.scene.id, next.scene.id) : undefined;
                            })()
                          }
                          extraActions={
                            <Tag color={selectedSceneIds.includes(item.scene.id) ? '#7a1f1f' : 'default'}>
                              {selectedSceneIds.includes(item.scene.id) ? '本次排练' : '本次跳过'}
                            </Tag>
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

      <Modal
        open={mergeTarget !== null && mergePreview !== null}
        title="合并相邻场次"
        okText="确认合并"
        cancelText="取消"
        confirmLoading={mergeSubmitting}
        onCancel={() => {
          setMergeTarget(null);
          setMergePreview(null);
        }}
        onOk={() => void handleMergeConfirm()}
      >
        {mergePreview && mergeTarget && mergePreview.preview ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message={`将「${mergePreview.preview.earlier.title}」与「${mergePreview.preview.later.title}」合并为一场`}
              description="合并后可在未改动前撤回；角色与锣鼓点会一并保留，后一场的鼓点按前一场时长顺延。"
            />
            <div>
              <Typography.Text type="secondary">合并后场次标题</Typography.Text>
              <Input value={mergeTitle} maxLength={40} onChange={(event) => setMergeTitle(event.target.value)} />
            </div>
            <Row gutter={12}>
              <Col span={12}>
                <Statistic
                  title="合计时长"
                  value={mergePreview.preview.mergedScene.durationMin}
                  suffix="分钟"
                  valueStyle={{ fontSize: 18 }}
                />
              </Col>
              <Col span={12}>
                <Statistic
                  title="顺延鼓点"
                  value={mergePreview.preview.offsetSeconds}
                  suffix="秒"
                  valueStyle={{ fontSize: 18 }}
                />
              </Col>
            </Row>
            <Space size={6} wrap>
              <Tag color="gold">影人 {mergePreview.preview.mergedRoles.length} 个</Tag>
              <Tag color="blue">锣鼓点 {mergePreview.preview.mergedCues.length} 处</Tag>
              <Tag>影窗 {SHADOW_SCREEN_LABEL[mergePreview.preview.mergedScene.needsShadowScreen]}</Tag>
              <Tag>进度 {mergePreview.preview.mergedScene.progress}%</Tag>
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              前一场鼓点保持原秒点，后一场鼓点顺延 {mergePreview.preview.offsetSeconds} 秒；场序自动重排。
            </Typography.Text>
          </Space>
        ) : null}
      </Modal>
    </Space>
  );
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
