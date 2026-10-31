export type Pt = [number, number];

export type ToolId =
  | 'select' | 'pan'
  | 'pen' | 'line' | 'arrow' | 'polyline' | 'polygon' | 'rect' | 'ellipse' | 'cloud'
  | 'text' | 'callout' | 'highlight'
  | 'm-length' | 'm-polylength' | 'm-perimeter' | 'm-area' | 'm-count'
  | 'calibrate';

export type MarkupType = Exclude<ToolId, 'select' | 'pan' | 'calibrate'>;

export type Dash = 'solid' | 'dashed' | 'dotted' | 'cloud';
export type Head = 'none' | 'open' | 'closed' | 'circle' | 'square' | 'slash';

export interface Style {
  stroke: string;
  fill: string | null;
  opacity: number; // stroke opacity 0..1
  fillOpacity: number; // 0..1
  width: number; // PDF points
  dash: Dash;
  startHead: Head;
  endHead: Head;
  fontSize: number;
  textColor: string;
}

export interface Markup {
  id: string;
  type: MarkupType;
  page: string; // PageRef.uid
  layer: string; // Layer.id
  pts: Pt[]; // PDF user space (unrotated page, y up)
  style: Style;
  text?: string;
  comment?: string;
  author?: string;
  created: number;
  modified: number;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  locked?: boolean;
}

export type Unit = 'in' | 'ft' | 'yd' | 'mi' | 'mm' | 'cm' | 'm' | 'km';

export interface ScaleCal {
  factor: number; // real `unit` per PDF point
  unit: Unit;
  label: string; // e.g. 1" = 20'
  precision: number;
}

export interface PageRef {
  uid: string;
  src: string; // Source id
  index: number; // 0-based page index in the source
  rot: number; // extra rotation added by user (0/90/180/270)
  scale?: ScaleCal;
}

export interface Doc {
  id: string;
  name: string;
  pages: PageRef[];
  markups: Markup[];
  layers: Layer[];
  activeLayer: string;
  ocgHidden: Record<string, string[]>; // source id -> hidden OCG ids (pdf.js ids)
  ocgShown: Record<string, string[]>; // source id -> ids forced visible
}

export interface SourceFile {
  id: string;
  name: string;
  bytes: Uint8Array; // cleaned bytes (PlanMark annotations removed)
}
