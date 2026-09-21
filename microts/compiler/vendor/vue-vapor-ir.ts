/** @vue/compiler-vapor 3.6.0-rc.1: vendored analysis-facing shape, not a public upstream API. */
import type { RootNode, TemplateChildNode, SimpleExpressionNode } from "@vue/compiler-dom";
export interface VaporRootIR {
  type: 0;
  node: RootNode;
  source: string;
  component: Set<string>;
  directive: Set<string>;
  hasTemplateRef: boolean;
  block: VaporBlockIR;
}
export interface VaporBlockIR {
  type: 1;
  node: RootNode | TemplateChildNode;
  tempId: number;
  operation: VaporOperation[];
  dynamic: VaporDynamicInfo;
  effect: { expressions: SimpleExpressionNode[]; operations: VaporOperation[] }[];
  returns: number[];
}

export interface VaporDynamicInfo { id?: number; flags: number; children: VaporDynamicInfo[]; operation?: VaporOperation }
export interface VaporIfIR { type: 15; id: number; condition: SimpleExpressionNode; positive: VaporBlockIR; negative?: VaporBlockIR | VaporIfIR }
export interface VaporForIR { type: 16; id: number; source: SimpleExpressionNode; value?: SimpleExpressionNode; key?: SimpleExpressionNode; index?: SimpleExpressionNode; keyProp?: SimpleExpressionNode; render: VaporBlockIR }
export interface VaporCreateIR { type: 12; id: number; tag: string; useCreateElement: boolean; props: unknown[]; slots: unknown[] }
export type VaporOperation = VaporIfIR | VaporForIR | VaporCreateIR | { type: number };
