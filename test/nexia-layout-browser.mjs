// Browser layout check. Real dashboard HTML/CSS, synthetic visible controls, no live API requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const pages = ["index.html","workspace.html","command.html","tools.html"];
const folder = new URL("../dashboard/",import.meta.url);
const profile = await mkdtemp(join(tmpdir(),"nexia-layout-"));
let chrome, socket;
const server = createServer(async(req,res)=>{
  const name = req.url === "/" ? "index.html" : req.url?.slice(1);
  try {
    if (!name || !/^[a-zA-Z0-9_-]+\.(html|css)$/.test(name)) { res.writeHead(404).end(); return; }
    let source = await readFile(new URL(name,folder),"utf8");
    if (name.endsWith(".html")) {
      source = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,"")
        .replace(/<link\b[^>]*href="https?:[^"]*"[^>]*>/gi,"");
      // Exercise real layout slots without credentials, stored data, provider calls or application code.
      source = source.replace('<div class="stopwrap" id="stopSwitch"></div>',
        '<div class="stopwrap" id="stopSwitch"><button class="stopbtn">Stop everything</button></div>');
      if(name==="index.html"){
        source=source.replace('id="eveConsole" class="cgrid" hidden','id="eveConsole" class="cgrid"')
          .replace(/<div class="wrap">/,'<style>[data-legacy]{display:none!important}</style><div class="wrap">');
      }
      if(name==="workspace.html"){
        source=source.replace('id="cForm" hidden','id="cForm"')
          .replace('id="welcome">','id="welcome" hidden>')
          .replace('id="cH">No conversation open','id="cH">Synthetic conversation');
      }
      res.setHeader("content-type","text/html; charset=utf-8");
    } else {
      source=source.replace(/@import\s+url\([^;]*\);/gi,"");
      res.setHeader("content-type","text/css; charset=utf-8");
    }
    res.end(source);
  } catch {res.writeHead(404).end();}
});
try{
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin="http://127.0.0.1:"+server.address().port;
  chrome=spawn(process.env.CHROME_BIN || "google-chrome",["--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--no-first-run","--no-default-browser-check","--disable-background-networking","--remote-debugging-port=0","--user-data-dir="+profile,"about:blank"],{stdio:"ignore"});
  let port;
  for(let i=0;i<80;i++){try{port=(await readFile(join(profile,"DevToolsActivePort"),"utf8")).split("\n")[0];break;}catch{await sleep(100);}}
  assert.ok(port,"browser started");
  const targets=await (await fetch("http://127.0.0.1:"+port+"/json/list")).json();
  socket=new WebSocket(targets.find(x=>x.type==="page").webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
  let seq=0;const pending=new Map();
  socket.addEventListener("message",e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>(await cdp("Runtime.evaluate",{expression,returnByValue:true})).result.value;
  await cdp("Page.enable");
  for(const [width,height] of [[320,568],[375,667],[390,844],[430,932],[1440,900]]){
    await cdp("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:width<700});
    for(const page of pages){
      const url=origin+"/"+page;
      await cdp("Page.navigate",{url});
      for(let i=0;i<60;i++){if(await evaluate("location.href === "+JSON.stringify(url)+" && document.readyState === 'complete'"))break;await sleep(100);}
      const result=await evaluate(`(()=>{
        const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom}};
        const nav=document.querySelector(".nexia-nav");
        const links=[...nav.querySelectorAll(".nexia-links a")].map(box);
        const composer=document.querySelector("#cForm");
        const stop=document.querySelector(".stopbtn");
        return {width:innerWidth,scroll:document.documentElement.scrollWidth,height:innerHeight,nav:box(nav),links,
          navPosition:getComputedStyle(nav).position,composer:composer?box(composer):null,
          stop:stop?box(stop):null,send:document.querySelector("#cSend")?box(document.querySelector("#cSend")):null,
          header:document.querySelector(".bar")?getComputedStyle(document.querySelector(".bar")).position:null};
      })()`);
      assert.ok(result, page+" layout evaluated");
      assert.ok(result.scroll<=width+1,page+" "+width+" horizontal overflow: "+JSON.stringify(result));
      if(width<700){
        assert.equal(result.navPosition,"fixed");
        assert.ok(Math.abs(result.nav.bottom-height)<=2,page+" nav at bottom");
        assert.ok(result.links.every(r=>r.h>=44 && r.w>=44),page+" touch targets");
        if(page==="workspace.html"){
          assert.ok(result.composer.h>0 && result.composer.bottom<=result.nav.y+1,"composer above bottom nav");
          assert.ok(result.send.h>=44,"send touch target");
        }
        if(page==="index.html"){assert.equal(result.header,"sticky");assert.ok(result.stop.h>=44 && result.stop.y>=0 && result.stop.bottom<result.nav.y,"emergency control visible");}
      }else{assert.equal(result.navPosition,"fixed");assert.ok(result.nav.x===0 && result.nav.w>=190,"desktop rail retained");}
      console.log("PASS",page,width+"x"+height);
    }
  }
}finally{
  socket?.close();chrome?.kill();server.close();await sleep(100);await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
