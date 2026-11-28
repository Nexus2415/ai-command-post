// ARN-169 candidate read-only owner download handler. Not registered in the live API.
// No database transport/role is supplied by default. Do not enable before owner authorization.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readSession, isSameOrigin } from "./site-auth.js";
const uuid=v=>typeof v==="string"&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export function documentOwnerPrincipal(req,env,now=Date.now()){
  const owner=typeof env.ACP_OWNER_EMAIL==="string"?env.ACP_OWNER_EMAIL.trim().toLowerCase():"";
  const s=readSession(req,env,now);
  if(!owner||!s||!equal(s.email.trim().toLowerCase(),owner))return null;
  // Same pseudonymous principal convention as the reviewed Build Mode candidate.
  return createHmac("sha256",env.ACP_SITE_PASSWORD).update("acp-build-owner-v1\u0000"+owner).digest("hex");
}
export async function ownerDocumentDownload(req,env,input,read,now=Date.now()){
  const fail=(status,error)=>({status,body:{error},headers:{"Cache-Control":"no-store"}});
  if(req.method!=="POST")return fail(405,"POST required");
  if(!isSameOrigin(req))return fail(403,"Same-origin request required");
  const principal=documentOwnerPrincipal(req,env,now);
  if(!principal)return fail(401,"Named owner sign-in required");
  if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).sort().join(",")!=="artifactId,projectId,threadId"||![input.artifactId,input.projectId,input.threadId].every(uuid))return fail(400,"Invalid artifact scope");
  if(typeof read!=="function")return fail(503,"Private document retrieval unavailable");
  let row;
  try{row=await read({p_artifact:input.artifactId,p_project:input.projectId,p_thread:input.threadId,p_principal:principal});}catch{return fail(503,"Private document retrieval unconfirmed");}
  if(row?.ok===false)return fail(404,"Document unavailable");
  const r=row?.receipt;
  if(row?.ok!==true||!r||r.artifactId!==input.artifactId||r.projectId!==input.projectId||r.threadId!==input.threadId||!uuid(r.taskId)||typeof r.filename!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.docx$/.test(r.filename)||r.mime!==mime||!Number.isSafeInteger(r.bytes)||r.bytes<1||r.bytes>300000||typeof r.sha256!=="string"||!/^[a-f0-9]{64}$/.test(r.sha256)||typeof row.data!=="string"||row.data.length>410000)return fail(503,"Document receipt unverified");
  const bytes=Buffer.from(row.data,"base64");
  if(bytes.length!==r.bytes||createHash("sha256").update(bytes).digest("hex")!==r.sha256||bytes.subarray(0,4).toString("hex")!=="504b0304")return fail(503,"Document integrity unverified");
  return {status:200,body:bytes,headers:{"Content-Type":mime,"Content-Disposition":'attachment; filename="'+r.filename+'"',"Content-Length":String(bytes.length),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}};
}
