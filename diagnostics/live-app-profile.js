// Opt-in diagnostics for the complete application. No document mutations:
// traces use begin/extend/cancel, never endStroke; camera changes are quiet.
import { app } from '../src/core.js';
import { state } from '../src/doc.js';
import { view, applyView, shellRect } from '../src/view.js';
import { beginStroke, extendStroke, cancelStroke, inkSettings } from '../src/ink.js';
import { setMode } from '../src/canvas.js';
const r = n => +n.toFixed(3);
function stats(values) { if (!values.length) return null; const ordered=[...values].sort((a,b)=>a-b); const q=p=>r(ordered[Math.ceil(ordered.length*p)-1]); return {count:values.length,medianMs:q(.5),p95Ms:q(.95),maxMs:q(1)}; }
export function mountMeasurement() {
  const panel=document.createElement('aside'); panel.id='measurement'; panel.setAttribute('aria-label','Pomiar pełnej aplikacji');
  panel.style.cssText='position:fixed;z-index:10000;top:75px;left:270px;width:385px;max-height:75vh;overflow:auto;background:#fff;padding:16px;border:1px solid #ddd;border-radius:12px;box-shadow:0 4px 24px #0002;font:13px system-ui';
  panel.innerHTML='<h2 style="font-size:17px;margin:0 0 8px">Pomiar pełnej aplikacji</h2><p>Zoom 100%, 13%, 5%. Ślady pomiarowe są anulowane bez zapisu. Czas do poleceń Canvas nie obejmuje wyświetlenia na monitorze.</p><button id="measureAppRun">Zmierz pełną aplikację</button><p id="measureAppStatus" role="status">Gotowy</p><pre id="measureAppResults" style="white-space:pre-wrap;font-size:11px"></pre>';
  document.body.append(panel);
  const run=panel.querySelector('#measureAppRun'), status=panel.querySelector('#measureAppStatus'), output=panel.querySelector('#measureAppResults');
  run.onclick=async()=>{
    run.disabled=true;
    const originalRaf=window.requestAnimationFrame, originalTransform=CanvasRenderingContext2D.prototype.setTransform;
    const nextFrame=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Brak klatki przez 8 sekund')),8000); originalRaf.call(window,()=>{clearTimeout(timer);resolve(performance.now());});});
    const saved={view:{...view},serverless:state.serverless,snap:inkSettings.snap,mode:app.mode};
    const result={startedAt:new Date().toISOString(),boardId:state.board.id,objects:Object.keys(state.board.objects).length,strokes:Object.keys(state.board.strokes).length,viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,userAgent:navigator.userAgent,focusChanges:[],cases:[],method:'Complete Quanta page; real saved board; synthetic traces cancelled without document changes; endpoint is Canvas submission.'};
    const focus=()=>result.focusChanges.push({at:performance.now(),focused:document.hasFocus(),visibility:document.visibilityState}); focus(); window.addEventListener('focus',focus);window.addEventListener('blur',focus);document.addEventListener('visibilitychange',focus);
    let phase='idle', pending=null,touched=false,render=[],latencies=[],pan=[],surfaceSignatures=new Set(),baseSignatures=new Set();
    const live=document.querySelector('#inkLive').getContext('2d');
    try{
      state.serverless=true;inkSettings.snap=false;setMode('pen');
      CanvasRenderingContext2D.prototype.setTransform=function(...args){if(this===live)touched=true;return originalTransform.apply(this,args);};
      window.requestAnimationFrame=function(callback){return originalRaf.call(window,timestamp=>{const t0=performance.now();touched=false;callback(timestamp);const end=performance.now();if(phase==='ink'&&touched&&pending!==null){render.push(end-t0);latencies.push(end-pending);surfaceSignatures.add([live.canvas.width,live.canvas.height,live.canvas.style.left,live.canvas.style.top].join('|'));const base=document.querySelector('#inkCanvas');baseSignatures.add([base.width,base.height,base.style.left,base.style.top,base.style.transform].join('|'));pending=null;}if(phase==='pan'&&callback.name==='renderView')pan.push(end-t0);});};
      const rect=shellRect(), center={x:(rect.width/2-saved.view.x)/saved.view.zoom,y:(rect.height/2-saved.view.y)/saved.view.zoom};
      for(let repetition=1;repetition<=2;repetition++)for(const zoom of repetition===1?[1,.13,.05]:[.05,.13,1]){
        const entry={repetition,zoomPercent:zoom*100};result.cases.push(entry);
        view.zoom=zoom;view.x=rect.width/2-center.x*zoom;view.y=rect.height/2-center.y*zoom;applyView({quiet:true});await nextFrame();await nextFrame();
        phase='idle';status.textContent=`Seria ${repetition}/2 · ${zoom*100}% · bez rysowania`;
        let previous=await nextFrame(),start=performance.now();const idle=[];
        while(idle.length<48&&performance.now()-start<4500){const now=await nextFrame();idle.push(now-previous);previous=now;}
        entry.idle={frames:stats(idle),rawMs:idle.map(r),complete:idle.length===48,focused:document.hasFocus(),visibility:document.visibilityState};
        status.textContent=`Seria ${repetition}/2 · ${zoom*100}% · rysowanie`;
        render=[];latencies=[];surfaceSignatures=new Set();baseSignatures=new Set();let sample=0;const handler=[],intervals=[];
        const point=()=>({pointerType:'mouse',clientX:rect.left+rect.width*.4+sample++*.8,clientY:rect.top+rect.height*.55+Math.sin(sample*.02)*50});
        beginStroke(point(),'pen');await nextFrame();phase='ink';start=previous=performance.now();
        while(intervals.length<72&&performance.now()-start<6000){await new Promise(resolve=>setTimeout(resolve,4));const samples=Array.from({length:6},point);pending=performance.now();extendStroke({...samples.at(-1),getCoalescedEvents:()=>samples});handler.push(performance.now()-pending);const now=await nextFrame();intervals.push(now-previous);previous=now;}
        phase='idle';pending=null;cancelStroke();await nextFrame();
        entry.ink={handler:stats(handler),render:stats(render),inputToCanvas:stats(latencies),frames:stats(intervals),complete:intervals.length===72,surfaceSignatures:[...surfaceSignatures],baseSignatures:[...baseSignatures],stableInkOrigin:surfaceSignatures.size===1&&baseSignatures.size===1,raw:{handler:handler.map(r),render:render.map(r),submit:latencies.map(r),intervals:intervals.map(r)}};
        phase='pan';pan=[];status.textContent=`Seria ${repetition}/2 · ${zoom*100}% · przesuwanie`;start=previous=performance.now();const pans=[];
        while(pans.length<72&&performance.now()-start<6000){view.x+=4;applyView({quiet:true});const now=await nextFrame();pans.push(now-previous);previous=now;}
        phase='idle';entry.pan={callbacks:stats(pan),frames:stats(pans),complete:pans.length===72,rawMs:pans.map(r)};
        output.textContent=JSON.stringify({completedCases:result.cases.length,last:{zoomPercent:zoom*100,idle:entry.idle.frames,ink:entry.ink.render,inputToCanvas:entry.ink.inputToCanvas,pan:entry.pan.frames}},null,2);
      }
      status.textContent='Pomiar pełnej aplikacji zakończony.';
    }catch(error){result.error=error.message;status.textContent=error.message;}
    finally{
      phase='idle';pending=null;cancelStroke();window.requestAnimationFrame=originalRaf;CanvasRenderingContext2D.prototype.setTransform=originalTransform;inkSettings.snap=saved.snap;state.serverless=saved.serverless;Object.assign(view,saved.view);applyView({quiet:true});setMode(saved.mode);
      window.removeEventListener('focus',focus);window.removeEventListener('blur',focus);document.removeEventListener('visibilitychange',focus);
      result.incompleteCases=result.cases.filter(c=>!c.idle?.complete||!c.ink?.complete||!c.pan?.complete).length;
      output.textContent=JSON.stringify(result,null,2);run.disabled=false;
    }
  };
}
