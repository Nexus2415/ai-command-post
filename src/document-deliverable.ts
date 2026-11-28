// ARN-169: deterministic synthetic DOCX renderer; no network, filesystem path or default authority.
import { createHash } from "node:crypto";
import { harmCheck } from "./policy.ts";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const uuid = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(x);
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const text = (x: unknown, max: number): x is string => typeof x === "string" && x.trim().length>0 && x.length<=max && !/[\u0000-\u001f\u007f\ufffe\uffff\uD800-\uDFFF]/u.test(x);
const xml = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
const NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const paragraph = (s:string,bold=false,size=22) => '<w:p><w:r><w:rPr>'+ (bold?'<w:b/>':'') +'<w:sz w:val="'+size+'"/></w:rPr><w:t xml:space="preserve">'+xml(s)+'</w:t></w:r></w:p>';
const crc32 = (b:Buffer) => {let c=0xffffffff;for(const x of b){c^=x;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
// Fixed ZIP entries, stored without compression; no paths or relationships supplied by a model.
function zip(entries:readonly [string,string][]):Buffer {
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [name,value] of entries){
    const n=Buffer.from(name),b=Buffer.from(value),crc=crc32(b);
    const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50,0);h.writeUInt16LE(20,4);h.writeUInt16LE(33,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(b.length,18);h.writeUInt32LE(b.length,22);h.writeUInt16LE(n.length,26);
    const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50,0);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(33,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    local.push(h,n,b);central.push(c,n);offset+=h.length+n.length+b.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
export function renderDocx(input:unknown):{filename:string;mime:typeof DOCX_MIME;data:Buffer;sha256:string}{
  const fail=():never=>{throw new Error("Invalid or unsupported document specification");};
  if(!input || typeof input!=="object" || Array.isArray(input))return fail();
  const x=input as Record<string,unknown>;
  if(Object.keys(x).sort().join(",")!=="filename,sections,title" || typeof x["filename"]!=="string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.docx$/.test(x["filename"]) || !text(x["title"],200) || !Array.isArray(x["sections"]) || x["sections"].length<1 || x["sections"].length>12)return fail();
  const parts=[paragraph(x["title"],true,36)],all=[x["title"]];
  for(const row of x["sections"]){
    if(!row || typeof row!=="object" || Array.isArray(row) || Object.keys(row).sort().join(",")!=="heading,paragraphs" || !text(row.heading,200) || !Array.isArray(row.paragraphs) || row.paragraphs.length<1 || row.paragraphs.length>12 || !row.paragraphs.every((s:unknown)=>text(s,2500)))return fail();
    all.push(row.heading,...row.paragraphs);parts.push(paragraph(row.heading,true,28),...row.paragraphs.map((s:string)=>paragraph(s)));
  }
  if(Buffer.byteLength(all.join("\n"))>40000 || harmCheck(all.join("\n")))return fail();
  const data=zip([
    ["[Content_Types].xml",'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ["_rels/.rels",'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ["word/document.xml",'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="'+NS+'"><w:body>'+parts.join("")+'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>']
  ]);
  return {filename:x["filename"],mime:DOCX_MIME,data,sha256:digest(data)};
}
export type DocumentGrant = {artifactId:string;taskId:string;projectId:string;threadId:string;principal:string;expiresAt:number;syntheticOnly:true;maxBudgetMicros:0};
export type DocumentReceipt = {artifactId:string;taskId:string;projectId:string;threadId:string;filename:string;mime:typeof DOCX_MIME;bytes:number;sha256:string};
export type DocumentRow = {receipt:DocumentReceipt;data:Buffer};
export interface DocumentPorts {
  mode:"synthetic";
  now():number;
  stop():Promise<"off"|"on"|"error">;
  grant(taskId:string):Promise<DocumentGrant|null>;
  privateThread(projectId:string,threadId:string,principal:string):Promise<boolean>;
  // Must atomically recheck grant, stop, private scope, exact artifact identity and replay.
  put(expected:Readonly<DocumentGrant>,row:DocumentRow):Promise<DocumentReceipt>;
  get(expected:Readonly<DocumentGrant>):Promise<DocumentRow|null>;
}
export interface DocumentCapability {
  readonly taskId:string;
  create(input:unknown):Promise<DocumentReceipt>;
  retrieve(principal:string):Promise<DocumentRow>;
}
const keys=(g:DocumentGrant)=>JSON.stringify([g.artifactId,g.taskId,g.projectId,g.threadId,g.principal,g.expiresAt,g.syntheticOnly,g.maxBudgetMicros]);
function match(a:DocumentReceipt,b:DocumentReceipt){
  return a.artifactId===b.artifactId&&a.taskId===b.taskId&&a.projectId===b.projectId&&a.threadId===b.threadId&&a.filename===b.filename&&a.mime===b.mime&&a.bytes===b.bytes&&a.sha256===b.sha256;
}
export function documentCapability(taskId:string,p:DocumentPorts):DocumentCapability {
  async function current(){
    if(p.mode!=="synthetic"||!uuid(taskId)||await p.stop()!=="off")throw new Error("Document scope unavailable");
    const g=await p.grant(taskId),now=p.now();
    if(!g||g.taskId!==taskId||!uuid(g.artifactId)||!uuid(g.projectId)||!uuid(g.threadId)||!text(g.principal,200)||g.syntheticOnly!==true||g.maxBudgetMicros!==0||!Number.isSafeInteger(now)||!Number.isSafeInteger(g.expiresAt)||g.expiresAt<=now||g.expiresAt-now>86400000||await p.privateThread(g.projectId,g.threadId,g.principal)!==true||await p.stop()!=="off")throw new Error("Document scope unavailable");
    return structuredClone(g);
  }
  return Object.freeze({taskId,async create(input:unknown){
    const g=await current(),f=renderDocx(input);
    const receipt:DocumentReceipt={artifactId:g.artifactId,taskId:g.taskId,projectId:g.projectId,threadId:g.threadId,filename:f.filename,mime:f.mime,bytes:f.data.length,sha256:f.sha256};
    if(keys(await current())!==keys(g))throw new Error("Document scope changed");
    let saved:DocumentReceipt;
    try{saved=await p.put(g,{receipt,data:f.data});}catch{throw new Error("Document storage unconfirmed; reconcile same artifact, no new ID");}
    if(!saved||!match(receipt,saved))throw new Error("Document storage unconfirmed; reconcile same artifact, no new ID");
    if(keys(await current())!==keys(g))throw new Error("Document scope changed after storage");
    return receipt;
  },async retrieve(principal:string){
    const g=await current();
    if(principal!==g.principal)throw new Error("Document scope unavailable");
    const row=await p.get(g);
    if(!row||!Buffer.isBuffer(row.data)||row.receipt.artifactId!==g.artifactId||row.receipt.taskId!==g.taskId||row.receipt.projectId!==g.projectId||row.receipt.threadId!==g.threadId||row.receipt.mime!==DOCX_MIME||row.receipt.bytes!==row.data.length||row.receipt.sha256!==digest(row.data)||keys(await current())!==keys(g))throw new Error("Document unavailable or unverified");
    return {receipt:structuredClone(row.receipt),data:Buffer.from(row.data)};
  }});
}
