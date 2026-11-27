// Type surface of ui-layer.js for TypeScript consumers. The .js stays plain ESM
// so the browser loads it without a build step.

export interface UiLayer {
  present(scale?: number): boolean;
  claims(x: number, y: number): boolean;
  dispose(): void;
}

export declare function createUiLayer(canvas: any, instance: any): UiLayer;
