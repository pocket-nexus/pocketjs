/** Model inference precedes view contracts and shares their checker and type names. */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { modelConfiguration } from "./aot-model-config.ts";
import { analyzeModel } from "./aot-model-frontend.ts";
import type { ModelModule, ModelProgram } from "./aot-model-ir.ts";
import { fail, location, type TypeEnvironment, type TypeMapper } from "./aot-types.ts";
import type { AotProgram } from "./aot-ir.ts";

export function analyzeViewModel(entry: string, views: { file: string; name: string; factory: boolean }[], sources: ReadonlyMap<string,string>, environment: TypeEnvironment, mapper: TypeMapper): ModelProgram | undefined {
  const config=modelConfiguration(entry);if(config.mode!=="compiled")return;
  const basename=(file:string)=>{const path=file.replace(/\.(tsx|vue)$/,".ts");return existsSync(path)?realpathSync(path):resolve(path);};
  const model=analyzeModel(basename(entry),{sources,environment,mapper,strict:mapper.strict,name:views.find(view=>view.file===entry)!.name,componentNames:views.map(view=>view.name),recursionLimit:config.recursionLimit,
    factories:views.filter(view=>view.file!==entry&&view.factory).map(view=>basename(view.file)),framework:entry.endsWith(".vue")?"vue":"solid"});
  for(const view of views){const module=viewModelModule(model,view.file);if(module&&module.kind!=="pure")module.name=view.name;}
  return model;
}

export function viewModelModule(model:ModelProgram|undefined,file:string):ModelModule|undefined {
  const path=file.replace(/\.(tsx|vue)$/,".ts"),canonical=existsSync(path)?realpathSync(path):resolve(path);
  return model?.modules.find(module=>module.file===canonical);
}

/** Render-time calls use immutable model receivers and cannot emit commands. */
export function validateViewModelBindings(program:AotProgram):void {
  if(!program.model)return;
  for(const component of program.components){
    const module=viewModelModule(program.model,component.file);if(!module)continue;
    for(const binding of component.functions.filter(fn=>fn.binding)){
      const fn=module.functions.find(fn=>fn.name===binding.sourceName);if(!fn)continue;
      if(fn.async||fn.ledger.writes.length||fn.ledger.external)fail(fn.loc??location(module.file,""),`view binding function ${fn.name} must be synchronous and pure; writes and external commands belong to handlers or lifecycle methods`);
    }
  }
}
