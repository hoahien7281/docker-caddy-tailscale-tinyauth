import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
const here=dirname(fileURLToPath(import.meta.url));
export function maybeB64(value,isB64){if(value==null)return value;return isB64?Buffer.from(String(value).trim(),"base64").toString("utf8"):value}
export function truthy(v,def="0"){return /^(1|true|yes|on)$/i.test(String(v??def))}
export function loadConfig(){
 const file=resolve(here,"../../config.jsonc"), defaults={channel_priority:["tailscale","cloudflare","hybrid"],sync_paths:[],rsync_options:["-az","--delete","--checksum","--safe-links","--stats","--human-readable"],ssh_connect_timeout_seconds:10,sync_timeout_seconds:600,diff_timeout_seconds:120};
 let cfg=defaults;try{if(existsSync(file))cfg={...defaults,...parseJsonc(readFileSync(file,"utf8"))}}catch{}
 const paths=process.env.SSH_SYNC_PATHS??process.env.SSH_SYNC_PATHS;
 if(paths!==undefined)cfg.sync_paths=String(paths).split(",").map(s=>s.trim()).filter(Boolean);
 return cfg;
}
export function workspaceDir(){return process.env.SSH_WORKSPACE||process.env.ORCH_REPO_DIR||"/workspace"}
export function enabledChannels(config=loadConfig(),env=process.env){const f={tailscale:truthy(env.SSH_CHANNEL_TAILSCALE_ENABLE,"1"),cloudflare:truthy(env.SSH_CHANNEL_CLOUDFLARE_ENABLE),hybrid:truthy(env.SSH_CHANNEL_HYBRID_ENABLE)};return(config.channel_priority||Object.keys(f)).filter(c=>f[c])}
export function nodesyncEnabled(env=process.env){return truthy(env.SSH_ENABLE)}
export function collectSshUsers(env=process.env){
 const ids=new Set();for(const k of Object.keys(env)){const m=k.match(/^SSH_(\d+)_(?:USER|PASS|PASSWORD|PUBLIC_KEY|PRIVATE_KEY)/i);if(m)ids.add(Number(m[1]))}
 return [...ids].sort((a,b)=>a-b).map(index=>{const p=`SSH_${index}_`;return{index,user:env[`${p}USER`],password:env[`${p}PASS`]||env[`${p}PASSWORD`],publicKey:maybeB64(env[`${p}PUBLIC_KEY`],truthy(env[`${p}PUBLIC_KEY_B64`])),privateKey:maybeB64(env[`${p}PRIVATE_KEY`],truthy(env[`${p}PRIVATE_KEY_B64`])),uid:env[`${p}UID`],shell:env[`${p}SHELL`]||"/bin/bash",privileged:truthy(env[`${p}PRIVILEGED`],"1")}}).filter(x=>x.user);
}
