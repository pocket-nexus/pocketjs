/** Vue ref/computed/watch spellings share the bound Model IR and semantic passes. */
import { analyzeModel, type AnalyzeModelOptions } from "./aot-model-frontend.ts";
export function analyzeVueModel(entry: string, options: AnalyzeModelOptions = {}) { return analyzeModel(entry, { ...options, framework: "vue" }); }
export { analyzeModel };
