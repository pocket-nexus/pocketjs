async function child():Promise<void>{return;}
async function parent():Promise<void>{await child();}
export function press():void{parent();}
