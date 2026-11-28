// ARN-169: owner-only candidate SQL adapter. No default transport, role or credentials.
import type { DocumentGrant, DocumentPorts, DocumentReceipt, DocumentRow } from "./document-deliverable.ts";
type Rpc=(fn:"ws_document_put"|"ws_document_get",args:Record<string,string>)=>Promise<unknown>;
const args=(g:Readonly<DocumentGrant>)=>({p_artifact:g.artifactId,p_task:g.taskId,p_project:g.projectId,p_thread:g.threadId,p_principal:g.principal,p_run:g.runId,p_expiry:new Date(g.expiresAt).toISOString()});
function response(v:unknown):Record<string,unknown>|null{
  if(!v||typeof v!=="object"||Array.isArray(v))throw Error("Unknown storage response");
  const x=v as Record<string,unknown>;
  if(x["ok"]===false)return null;
  if(x["ok"]!==true||!x["receipt"]||typeof x["receipt"]!=="object")throw Error("Unknown storage response");
  return x;
}
export function documentSqlStorage(rpc:Rpc):Pick<DocumentPorts,"put"|"get">{
  return {
    async put(g,row){
      const x=response(await rpc("ws_document_put",{...args(g),p_filename:row.receipt.filename,p_sha:row.receipt.sha256,p_data:row.data.toString("base64")}));
      if(!x)throw Error("Document storage refused");
      return x["receipt"] as DocumentReceipt; // capability verifies every receipt field against rendered bytes.
    },
    async get(g):Promise<DocumentRow|null>{
      const x=response(await rpc("ws_document_get",args(g)));
      if(!x)return null;
      if(typeof x["data"]!=="string"||x["data"].length>410000)throw Error("Unknown storage bytes");
      return {receipt:x["receipt"] as DocumentReceipt,data:Buffer.from(x["data"],"base64")};
    }
  };
}
