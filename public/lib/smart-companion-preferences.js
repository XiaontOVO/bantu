const PREFIX = 'bantu.smart-companion.v1:';
export function smartCompanionPreferences(owner) {
  try { const saved=JSON.parse(localStorage.getItem(PREFIX+(owner||'guest'))||'{}');return {enabled:saved.enabled===true,autoplay:saved.autoplay!==false}; }
  catch { return {enabled:false,autoplay:true}; }
}
export const smartCompanionEnabled = owner => Boolean(owner && smartCompanionPreferences(owner).enabled);
export function saveSmartCompanionPreference(owner,key,value) {
  if(!owner||!['enabled','autoplay'].includes(key)||typeof value!=='boolean')return false;
  try{localStorage.setItem(PREFIX+owner,JSON.stringify({...smartCompanionPreferences(owner),[key]:value}));return true;}catch{return false;}
}
