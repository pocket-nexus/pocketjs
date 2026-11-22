/** Model inference precedes view contracts and shares their checker and type names. */
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { modelConfiguration } from "./aot-model-config.ts";
import { analyzeModel } from "./aot-model-frontend.ts";
import type { ModelModule, ModelProgram } from "./aot-model-ir.ts";
import { fail, location, type TypeEnvironment, type TypeMapper } from "./aot-types.ts";
import type { AotProgram } from "./aot-ir.ts";

export function analyzeViewModel(entry: string, views: { file: string; name: string; factory: boolean }[], sources: ReadonlyMap<string,string>, environment: TypeEnvironment, mapper: TypeMapper): ModelProgram | undefined {
  const config=modelConfiguration(entry);if(config.mode!=="compiled")return;
  // The views' program holds the root model only when a view imports it.
  const root=modelFile(entry);
  if((sources.has(root)||existsSync(root))&&!environment.program.getSourceFile(root))
    fail(location(entry,sources.get(entry)??""),`${basename(entry)} does not import its model ${basename(root)}`);
  const model=analyzeModel(root,{sources,environment,mapper,strict:mapper.strict,name:views.find(view=>view.file===entry)!.name,componentNames:views.map(view=>view.name),recursionLimit:config.recursionLimit,
    factories:views.filter(view=>view.file!==entry&&view.factory).map(view=>modelFile(view.file)),framework:entry.endsWith(".vue")?"vue":"solid"});
  for(const view of views){const module=viewModelModule(model,view.file);if(module&&module.kind!=="pure")module.name=view.name;}
  return model;
}

/** A view's basename module, spelled like the view: the TypeScript program
 *  resolves the view's `./name` import relative to the view's own path, so a
 *  project reached through a symbolic link keeps the link's spelling. */
export function modelFile(view:string):string { return resolve(view.replace(/\.(tsx|vue)$/,".ts")); }

export function viewModelModule(model:ModelProgram|undefined,file:string):ModelModule|undefined {
  const path=modelFile(file);
  return model?.modules.find(module=>module.file===path);
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
