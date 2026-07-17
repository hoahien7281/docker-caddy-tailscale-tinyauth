#!/usr/bin/env node
// Materialise SSH_* configuration and runtime key files for local/GitHub/Azure.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const args=process.argv.slice(2), dry=args.includes("--dry-run");
const envArg=args.indexOf("--env");
const ENV=envArg>=0?resolve(args[envArg+1]):resolve(ROOT,".env");
const runtime=resolve(ROOT,"ci-runtime/nodesync");
const truthy=(v)=>/^(1|true|yes|on)$/i.test(String(v??""));
const parse=(text)=>Object.fromEntries(text.split(/\r?\n/).map(x=>x.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)).filter(Boolean).map(m=>[m[1].toUpperCase(),m[2]]));
let content=existsSync(ENV)?readFileSync(ENV,"utf8"):"";
const fileEnv=parse(content), env={...fileEnv,...Object.fromEntries(Object.entries(process.env).map(([k,v])=>[k.toUpperCase(),v]))};
const generated=new Map();

function mask(value){
 if(!value)return;
 if(process.env.GITHUB_ACTIONS==="true") console.log(`::add-mask::${value}`);
 if(process.env.TF_BUILD==="True") console.log(`##vso[task.setsecret]${value}`);
}
function set(key,value,{secret=false}={}){
 key=key.toUpperCase(); value=String(value??""); env[key]=value; generated.set(key,value);
 if(secret) mask(value);
}
function writePrefix(prefix){
 if(dry)return;
 const lines=content.split(/\r?\n/), values=new Map();
 let first=-1;
 for(let i=0;i<lines.length;i++){
  const m=lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if(m&&m[1].toUpperCase().startsWith(prefix)){
   if(first<0)first=i;
   values.set(m[1].toUpperCase(),m[2]);
  }
 }
 for(const [key,value] of generated)if(key.startsWith(prefix))values.set(key,value);
 if(!values.size)return;
 const kept=lines.filter(line=>{const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);return !(m&&m[1].toUpperCase().startsWith(prefix));});
 const insertAt=first<0?kept.length-(kept.at(-1)===""?1:0):Math.min(first,kept.length);
 kept.splice(insertAt,0,...[...values].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`));
 content=kept.join("\n").replace(/\n*$/,"\n");
 writeFileSync(ENV,content,{mode:0o600});
}
function exportPublic(key,value){
 if(process.env.GITHUB_ENV)appendFileSync(process.env.GITHUB_ENV,`${key}=${value}\n`);
 if(process.env.TF_BUILD==="True")console.log(`##vso[task.setvariable variable=${key}]${value}`);
}

if(!truthy(env.SSH_ENABLE)){console.log("[ssh-env] SSH_ENABLE!=1; no SSH materialisation required");process.exit(0)}
mkdirSync(runtime,{recursive:true});
const indexes=new Set();
for(const key of Object.keys(env)){const m=key.match(/^SSH_(\d+)_(?:USER|PASS|PASSWORD|PUBLIC_KEY|PRIVATE_KEY)/i);if(m)indexes.add(Number(m[1]));}
if(!indexes.size){
 set("SSH_1_USER",env.SSH_DEFAULT_USER||"nodesync");
 set("SSH_1_PASS",randomBytes(24).toString("base64url"),{secret:true});
 indexes.add(1);
}
for(const i of [...indexes].sort((a,b)=>a-b)){
 const user=env[`SSH_${i}_USER`]||env[`SSH_${i}_user`.toUpperCase()]||`nodesync${i===1?"":i}`;
 const pass=env[`SSH_${i}_PASS`]||env[`SSH_${i}_PASSWORD`]||randomBytes(24).toString("base64url");
 set(`SSH_${i}_USER`,user); set(`SSH_${i}_PASS`,pass,{secret:true});
}
const keyFile=resolve(runtime,"id_ed25519"), pubFile=`${keyFile}.pub`;
let privateKey=env.SSH_1_PRIVATE_KEY?Buffer.from(env.SSH_1_PRIVATE_KEY,env.SSH_1_PRIVATE_KEY_B64==="1"?"base64":"utf8").toString("utf8"):"";
let publicKey=env.SSH_1_PUBLIC_KEY?Buffer.from(env.SSH_1_PUBLIC_KEY,env.SSH_1_PUBLIC_KEY_B64==="1"?"base64":"utf8").toString("utf8"):"";
if(!dry){
 if(privateKey){writeFileSync(keyFile,privateKey.trim()+"\n",{mode:0o600});}
 else if(!existsSync(keyFile))execFileSync("ssh-keygen",["-q","-t","ed25519","-N","","-C",`${env.ORCH_NODE_ID||userInfo().username}@nodesync`,"-f",keyFile],{stdio:"inherit"});
 chmodSync(keyFile,0o600);
 if(!publicKey)publicKey=existsSync(pubFile)?readFileSync(pubFile,"utf8").trim():execFileSync("ssh-keygen",["-y","-f",keyFile],{encoding:"utf8"}).trim();
 if(!existsSync(pubFile))writeFileSync(pubFile,publicKey+"\n",{mode:0o644});
 privateKey=readFileSync(keyFile,"utf8").trim();
 set("SSH_1_PRIVATE_KEY",Buffer.from(privateKey).toString("base64"),{secret:true}); set("SSH_1_PRIVATE_KEY_B64","1");
 set("SSH_1_PUBLIC_KEY",Buffer.from(publicKey).toString("base64")); set("SSH_1_PUBLIC_KEY_B64","1");
}
set("SSH_RUNTIME_DIR",env.SSH_RUNTIME_DIR||"/runtime");
set("SSH_KEY_FILE",env.SSH_KEY_FILE||"/runtime/id_ed25519");
set("SSH_PREDECESSOR_FILE",env.SSH_PREDECESSOR_FILE||"/runtime/predecessor.json");
if(truthy(env.SSH_SYNC_SMOKE_ENABLE))set("SSH_SYNC_PATHS",env.SSH_SYNC_PATHS||"ci-runtime/smoke-sync-data");
writePrefix("SSH_");
for(const [key,value] of generated)if(!/(PASS|PRIVATE_KEY|SECRET|TOKEN)/.test(key))exportPublic(key,value);
console.log(`[ssh-env] ready users=${indexes.size} env=${ENV} runtime=${runtime} keys=${[...generated.keys()].sort().join(",")}`);
