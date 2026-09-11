import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AudioLines,
  BrainCircuit,
  Ear,
  Flag,
  GitBranch,
  GripVertical,
  Play,
  Plus,
  Repeat2,
  Trash2
} from "lucide-react";
import type { Clip, FlowDefinition, FlowNode, FlowNodeKind } from "../lib/domain";
import type { BranchCondition, FlowEdge } from "../lib/domain";
import { ClipPlayer } from "./ClipPlayer";

type CanvasNodeData = FlowNode["data"] & { kind: FlowNodeKind };
type CanvasNode = Node<CanvasNodeData, FlowNodeKind>;
type CanvasEdgeData = { condition?: BranchCondition };
type CanvasEdge = Edge<CanvasEdgeData>;

const nodeMeta: Record<FlowNodeKind, { label: string; icon: typeof Play; color: string }> = {
  start: { label: "Start", icon: Flag, color: "mint" },
  playClip: { label: "Play clip", icon: Play, color: "teal" },
  listen: { label: "Listen", icon: Ear, color: "blue" },
  classify: { label: "Classify", icon: BrainCircuit, color: "violet" },
  condition: { label: "Condition", icon: GitBranch, color: "orange" },
  retry: { label: "Retry", icon: Repeat2, color: "rose" },
  end: { label: "End", icon: Flag, color: "charcoal" }
};

function FlowNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const meta = nodeMeta[data.kind];
  const Icon = meta.icon;
  return (
    <div className={`flow-node flow-node--${meta.color} ${selected ? "is-selected" : ""}`}>
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <div className="flow-node__icon"><Icon size={14} strokeWidth={2.25} /></div>
      <div className="flow-node__copy">
        <span>{meta.label}</span>
        <strong>{data.label}</strong>
        {data.description && <small>{data.description}</small>}
      </div>
      <Handle type="source" position={Position.Right} className="flow-handle" />
    </div>
  );
}

const nodeTypes = {
  start: FlowNodeCard,
  playClip: FlowNodeCard,
  listen: FlowNodeCard,
  classify: FlowNodeCard,
  condition: FlowNodeCard,
  retry: FlowNodeCard,
  end: FlowNodeCard
};

const asCanvasNode = (node: FlowNode): CanvasNode => ({
  ...node,
  data: { ...node.data, kind: node.type }
});

const asFlowNode = (node: CanvasNode): FlowNode => {
  const { kind, ...data } = node.data;
  return { id: node.id, type: node.type, position: node.position, data };
};

const asCanvasEdge = (edge: FlowEdge): CanvasEdge => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
  label: edge.label,
  data: { condition: edge.condition ? { ...edge.condition } : undefined },
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed, color: "#6b7771" },
  style: { stroke: "#99a7a0", strokeWidth: 1.5 },
  labelStyle: { fill: "#52605a", fontSize: 11, fontWeight: 700 },
  labelBgStyle: { fill: "#f8faf8", fillOpacity: 0.96 }
});

const asFlowEdge = (edge: CanvasEdge): FlowEdge => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
  label: typeof edge.label === "string" ? edge.label : undefined,
  condition: edge.data?.condition ? { ...edge.data.condition } : undefined
});

const makeNode = (type: FlowNodeKind, position: { x: number; y: number }): FlowNode => {
  const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
  const defaults: Record<FlowNodeKind, FlowNode["data"]> = {
    start: { label: "Start call", description: "Call answered" },
    playClip: { label: "New clip", description: "Select an audio clip" },
    listen: { label: "Listen for reply", description: "Endpoint after 750 ms" },
    classify: { label: "Classify response", threshold: 0.7, description: "Intent + sentiment" },
    condition: { label: "Check condition", description: "Route by outcome" },
    retry: { label: "Clarify once", description: "Low confidence fallback" },
    end: { label: "End call" }
  };
  return { id, type, position, data: defaults[type] };
};

type Props = {
  flow: FlowDefinition;
  clips: Clip[];
  selectedNodeId?: string;
  onSelectedNodeChange: (id?: string) => void;
  onChange: (flow: FlowDefinition) => void;
};

export function FlowCanvas({ flow, clips, selectedNodeId, onSelectedNodeChange, onChange }: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [nodeMeasurements, setNodeMeasurements] = useState(() => new Map<string, CanvasNode["measured"]>());
  const nodes = useMemo(() => flow.nodes.map((node) => ({
    ...asCanvasNode(node),
    measured: nodeMeasurements.get(node.id),
    selected: node.id === selectedNodeId
  })), [flow.nodes, nodeMeasurements, selectedNodeId]);
  const edges = useMemo<CanvasEdge[]>(() => flow.edges.map((edge) => ({ ...asCanvasEdge(edge), selected: edge.id === selectedEdgeId })), [flow.edges, selectedEdgeId]);

  const updateNodes = useCallback(
    (nextNodes: CanvasNode[]) => onChange({ ...flow, nodes: nextNodes.map(asFlowNode) }),
    [flow, onChange]
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      // React Flow needs measured sizes to keep nodes and their handles visible.
      // Retain them across flow updates without putting them in the saved graph.
      if (changes.some((change) => change.type === "dimensions" || change.type === "remove")) {
        setNodeMeasurements((current) => {
          const next = new Map(current);
          for (const change of changes) {
            if (change.type === "dimensions" && change.dimensions) next.set(change.id, change.dimensions);
            if (change.type === "remove") next.delete(change.id);
          }
          return next;
        });
      }
      const edits = changes.filter((change) => change.type !== "dimensions" && change.type !== "select");
      if (edits.length) updateNodes(applyNodeChanges(edits, nodes) as CanvasNode[]);
    },
    [nodes, updateNodes]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      const edits = changes.filter((change) => change.type !== "select");
      if (!edits.length) return;
      const next = applyEdgeChanges(edits, edges);
      onChange({
        ...flow,
        edges: next.map(asFlowEdge)
      });
    },
    [edges, flow, onChange]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const next = addEdge(
        { ...connection, id: `edge-${crypto.randomUUID().slice(0, 8)}`, data: {} } as CanvasEdge,
        edges
      );
      onChange({
        ...flow,
        edges: next.map(asFlowEdge)
      });
    },
    [edges, flow, onChange]
  );

  const addNode = useCallback(
    (type: FlowNodeKind, clientPosition?: { x: number; y: number }) => {
      const bounds = wrapper.current?.getBoundingClientRect();
      const dropPosition = clientPosition ?? (bounds ? { x: bounds.left + bounds.width / 2 - 89, y: bounds.top + bounds.height / 2 - 35 } : undefined);
      const position = dropPosition && reactFlow
        ? reactFlow.screenToFlowPosition(dropPosition)
        : { x: 420 + (flow.nodes.length % 3) * 60, y: 520 + (flow.nodes.length % 2) * 75 };
      const node = makeNode(type, position);
      onChange({ ...flow, status: "draft", nodes: [...flow.nodes, node] });
      onSelectedNodeChange(node.id);
    },
    [flow, onChange, onSelectedNodeChange, reactFlow]
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const type = (event.dataTransfer.getData("application/mktr-flow-node") || event.dataTransfer.getData("text/plain")) as FlowNodeKind;
      if (Object.hasOwn(nodeMeta, type)) addNode(type, { x: event.clientX, y: event.clientY });
    },
    [addNode]
  );

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const selectedNode = flow.nodes.find((node) => node.id === selectedNodeId);
  const selectedClip = clips.find((clip) => clip.id === selectedNode?.data.clipId);
  const selectedEdge = flow.edges.find((edge) => edge.id === selectedEdgeId);

  const updateSelectedEdge = (changes: Partial<FlowEdge>) => {
    if (!selectedEdge) return;
    onChange({
      ...flow,
      status: "draft",
      edges: flow.edges.map((edge) => edge.id === selectedEdge.id ? { ...edge, ...changes } : edge)
    });
  };

  const updateSelectedCondition = (changes: Partial<BranchCondition>) => {
    if (!selectedEdge) return;
    const condition = { ...selectedEdge.condition, ...changes };
    Object.entries(condition).forEach(([key, value]) => {
      if (value === undefined || value === "") delete condition[key as keyof BranchCondition];
    });
    updateSelectedEdge({ condition: Object.keys(condition).length ? condition : undefined });
  };

  const updateSelected = (changes: Partial<FlowNode["data"]>) => {
    if (!selectedNode) return;
    onChange({
      ...flow,
      status: "draft",
      nodes: flow.nodes.map((node) => node.id === selectedNode.id ? { ...node, data: { ...node.data, ...changes } } : node)
    });
  };

  const removeSelected = () => {
    if (!selectedNode || selectedNode.type === "start") return;
    setNodeMeasurements((current) => {
      const next = new Map(current);
      next.delete(selectedNode.id);
      return next;
    });
    onChange({
      ...flow,
      status: "draft",
      nodes: flow.nodes.filter((node) => node.id !== selectedNode.id),
      edges: flow.edges.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id)
    });
    setSelectedEdgeId(undefined);
    onSelectedNodeChange(undefined);
  };

  return (
    <div className="flow-workspace">
      <aside className="node-palette" aria-label="Node palette">
        <div className="panel-heading">
          <span>Flow nodes</span>
          <small>Drag to canvas</small>
        </div>
        <div className="node-palette__items">
          {(Object.keys(nodeMeta) as FlowNodeKind[]).map((type) => {
            const meta = nodeMeta[type];
            const Icon = meta.icon;
            return (
              <button
                key={type}
                className="palette-item"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData("application/mktr-flow-node", type);
                  event.dataTransfer.setData("text/plain", type);
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => addNode(type)}
                title={`Add ${meta.label} node`}
              >
                <GripVertical size={14} />
                <span className={`palette-item__icon palette-item__icon--${meta.color}`}><Icon size={15} /></span>
                <span>{meta.label}</span>
                <Plus size={13} />
              </button>
            );
          })}
        </div>
        <div className="palette-note">
          <AudioLines size={15} />
          <span>Published flows use approved clips only.</span>
        </div>
      </aside>

      <div className="flow-canvas" ref={wrapper}>
        <ReactFlow<CanvasNode, CanvasEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => { setSelectedEdgeId(undefined); onSelectedNodeChange(node.id); }}
          onEdgeClick={(_, edge) => { onSelectedNodeChange(undefined); setSelectedEdgeId(edge.id); }}
          onPaneClick={() => { setSelectedEdgeId(undefined); onSelectedNodeChange(undefined); }}
          onInit={setReactFlow}
          onDrop={onDrop}
          onDragOver={onDragOver}
          fitView
          fitViewOptions={{ padding: 0.16 }}
          defaultEdgeOptions={{ type: "smoothstep" }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#d9e2dc" gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap nodeColor={(node) => {
            const kind = (node.data as CanvasNodeData).kind;
            return kind === "playClip" ? "#0b7a62" : kind === "classify" ? "#3e68a7" : "#6d756f";
          }} maskColor="rgba(245, 248, 246, 0.72)" />
        </ReactFlow>
      </div>

      <aside className="inspector" aria-label="Node inspector">
        {selectedNode ? (
          <>
            <div className="panel-heading panel-heading--split">
              <div>
                <span>{nodeMeta[selectedNode.type].label}</span>
                <small>Node settings</small>
              </div>
              {selectedNode.type !== "start" && (
                <button className="icon-button icon-button--danger" onClick={removeSelected} title="Delete node" aria-label="Delete node">
                  <Trash2 size={16} />
                </button>
              )}
            </div>
            <label className="field-label">
              Name
              <input value={selectedNode.data.label} onChange={(event) => updateSelected({ label: event.target.value })} />
            </label>
            {(["playClip", "retry"] as FlowNodeKind[]).includes(selectedNode.type) && (
              <label className="field-label">
                Audio clip
                <select value={selectedNode.data.clipId ?? ""} onChange={(event) => updateSelected({ clipId: event.target.value || undefined })}>
                  <option value="">Select clip</option>
                  {clips.filter((clip) => clip.status === "ready").map((clip) => <option value={clip.id} key={clip.id}>{clip.name}</option>)}
                </select>
              </label>
            )}
            {selectedNode.type === "classify" && (
              <label className="field-label">
                Confidence threshold
                <div className="range-field">
                  <input
                    type="range"
                    min="0.5"
                    max="0.95"
                    step="0.05"
                    value={selectedNode.data.threshold ?? 0.7}
                    onChange={(event) => updateSelected({ threshold: Number(event.target.value) })}
                  />
                  <output>{Math.round((selectedNode.data.threshold ?? 0.7) * 100)}%</output>
                </div>
              </label>
            )}
            {selectedClip && <ClipPlayer key={selectedClip.id} clip={selectedClip} />}
            <label className="field-label">
              Note
              <textarea value={selectedNode.data.description ?? ""} rows={4} onChange={(event) => updateSelected({ description: event.target.value })} />
            </label>
          </>
        ) : selectedEdge ? (
          <>
            <div className="panel-heading panel-heading--split">
              <div>
                <span>Route settings</span>
                <small>Decision rule</small>
              </div>
              <button
                className="icon-button icon-button--danger"
                onClick={() => {
                  onChange({ ...flow, status: "draft", edges: flow.edges.filter((edge) => edge.id !== selectedEdge.id) });
                  setSelectedEdgeId(undefined);
                }}
                title="Delete connection"
                aria-label="Delete connection"
              >
                <Trash2 size={16} />
              </button>
            </div>
            <label className="field-label">
              Route label
              <input value={selectedEdge.label ?? ""} onChange={(event) => updateSelectedEdge({ label: event.target.value || undefined })} placeholder="e.g. Interested" />
            </label>
            <label className="field-label">
              Intent
              <select value={selectedEdge.condition?.intent ?? ""} onChange={(event) => updateSelectedCondition({ intent: event.target.value || undefined })}>
                <option value="">Any intent</option>
                <option value="interested">Interested</option>
                <option value="callback">Callback</option>
                <option value="not_interested">Not interested</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label className="field-label">
              Sentiment
              <select value={selectedEdge.condition?.sentiment ?? ""} onChange={(event) => updateSelectedCondition({ sentiment: (event.target.value || undefined) as BranchCondition["sentiment"] })}>
                <option value="">Any sentiment</option>
                <option value="positive">Positive</option>
                <option value="neutral">Neutral</option>
                <option value="negative">Negative</option>
                <option value="uncertain">Uncertain</option>
              </select>
            </label>
            <label className="field-label">
              Confidence below
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={selectedEdge.condition?.confidenceBelow ?? ""}
                onChange={(event) => updateSelectedCondition({ confidenceBelow: event.target.value === "" ? undefined : Number(event.target.value) })}
                placeholder="0.70"
              />
            </label>
            <label className="check-field">
              <input type="checkbox" checked={selectedEdge.condition?.fallback ?? false} onChange={(event) => updateSelectedCondition({ fallback: event.target.checked || undefined })} />
              <span>Use as fallback route</span>
            </label>
          </>
        ) : (
          <div className="inspector-empty">
            <GitBranch size={25} />
            <strong>Flow checks</strong>
            <p>Published versions need a start node, ready clips, connected routes, and a fallback after each response.</p>
            <div className="check-list">
              <span><i className="check-dot check-dot--ok" /> {flow.nodes.length} nodes</span>
              <span><i className="check-dot check-dot--ok" /> {flow.edges.length} connections</span>
              <span><i className={`check-dot ${flow.status === "published" ? "check-dot--ok" : "check-dot--draft"}`} /> {flow.status}</span>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
