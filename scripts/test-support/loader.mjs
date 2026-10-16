// Explicit offline test doubles. Never included in runtime API imports.
export async function resolve(specifier,context,nextResolve){
 if(specifier==='@netlify/blobs')return {url:new URL('./memory-store.mjs',import.meta.url).href,shortCircuit:true};
 if(specifier==='date-holidays')return {url:new URL('./holidays.mjs',import.meta.url).href,shortCircuit:true};
 if(specifier==='exceljs')return {url:new URL('./exceljs.mjs',import.meta.url).href,shortCircuit:true};
 return nextResolve(specifier,context);
}
