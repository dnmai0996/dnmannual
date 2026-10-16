export class MemoryStore {
 constructor(){this.rows=new Map();this.version=0;}
 async getWithMetadata(key){const r=this.rows.get(key);return r?structuredClone(r):null;}
 async get(key){return this.rows.has(key)?structuredClone(this.rows.get(key).data):null;}
 async setJSON(key,data,options={}){
  const prior=this.rows.get(key);
  if(options.onlyIfNew&&prior)return {modified:false};
  if(options.onlyIfMatch!==undefined&&options.onlyIfMatch!==prior?.etag)return {modified:false};
  this.rows.set(key,{data:structuredClone(data),etag:String(++this.version),metadata:options.metadata||{}});return {modified:true};
 }
 async delete(key){this.rows.delete(key);}
}
export const stores=new Map();
export function getStore({name}){if(!stores.has(name))stores.set(name,new MemoryStore());return stores.get(name);}
