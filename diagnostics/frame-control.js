const stage = document.querySelector('#stage'), status = document.querySelector('#status'), output = document.querySelector('#results'), run = document.querySelector('#run');
const round = n => +n.toFixed(3);
function summary(values) { const ordered = [...values].sort((a,b) => a-b); return { count: values.length, medianMs: round(ordered[Math.ceil(values.length*.5)-1]), p95Ms: round(ordered[Math.ceil(values.length*.95)-1]), maxMs: round(ordered.at(-1)) }; }
const frame = () => new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error('No frame in 8 seconds')), 8000); requestAnimationFrame(() => { clearTimeout(timeout); resolve(performance.now()); }); });
run.onclick = async () => {
  run.disabled = true;
  const result = { startedAt: new Date().toISOString(), userAgent: navigator.userAgent, viewport: [innerWidth,innerHeight], devicePixelRatio, focusChanges: [], cases: [] };
  const focus = () => result.focusChanges.push({at: performance.now(), focused: document.hasFocus(), visibility: document.visibilityState});
  window.addEventListener('focus', focus); window.addEventListener('blur', focus); document.addEventListener('visibilitychange', focus); focus();
  try {
    for (let repetition = 1; repetition <= 2; repetition++) {
      for (const mode of ['empty', 'dom', 'canvas', 'canvas-desynchronized']) {
        status.textContent = `Seria ${repetition}/2 · ${mode}`;
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(stage.clientWidth * Math.min(2,devicePixelRatio)); canvas.height = 500 * Math.min(2,devicePixelRatio); canvas.style.width = '100%'; canvas.style.height = '500px';
        const ctx = mode.startsWith('canvas') ? canvas.getContext('2d', { desynchronized: mode === 'canvas-desynchronized' }) : null;
        if (mode.startsWith('canvas')) stage.append(canvas);
        const intervals = [], costs = [], started = performance.now();
        let previous = await frame(), count = 0;
        while (count < 72 && performance.now() - started < 6000) {
          const t0 = performance.now();
          if (mode === 'dom') document.querySelector('#dot').style.transform = `translateX(${count * 4}px)`;
          if (mode.startsWith('canvas')) { ctx.clearRect(0,0,canvas.width,canvas.height); ctx.fillStyle = '#2747d6'; ctx.fillRect(count*4,230,20,20); }
          costs.push(performance.now()-t0);
          const now = await frame(); intervals.push(now-previous); previous = now; count++;
        }
        result.cases.push({ repetition, mode, focused: document.hasFocus(), visibility: document.visibilityState, complete: count === 72, frames: summary(intervals), cpu: summary(costs), rawIntervals: intervals.map(round), contextAttributes: mode.startsWith('canvas') ? ctx.getContextAttributes?.() : undefined });
        canvas.remove(); output.textContent = JSON.stringify(result,null,2);
      }
    }
    status.textContent = 'Próba kontrolna zakończona.';
  } catch (error) { result.error = error.message; status.textContent = error.message; }
  finally { window.removeEventListener('focus',focus); window.removeEventListener('blur',focus); document.removeEventListener('visibilitychange',focus); output.textContent = JSON.stringify(result,null,2); run.disabled = false; }
};
document.querySelector('#geometry').onclick = async () => {
  const button = document.querySelector('#geometry'); button.disabled = run.disabled = true;
  const result = { startedAt: new Date().toISOString(), method: 'Full geometry + Canvas command submission; new stroke object on every call; GPU presentation excluded.', cases: [] };
  try {
    const { paintStroke } = await import('../src/stroke.js');
    const canvas = document.createElement('canvas'); canvas.width = 1536; canvas.height = 512; stage.append(canvas);
    const context = canvas.getContext('2d', { desynchronized: true });
    for (const zoom of [1,.13,.05]) for (const count of [1200,8000,12000]) {
      status.textContent = `Geometria · zoom ${zoom*100}% · ${count} próbek`;
      const points = Array.from({ length: count }, (_, i) => [40/zoom + 1000*i/(count-1)/zoom, (230+Math.sin(i/(count-1)*Math.PI*10)*90)/zoom,.5]);
      const costs = [];
      for (let i = 0; i < 35; i++) {
        const start = performance.now();
        context.setTransform(1,0,0,1,0,0); context.clearRect(0,0,canvas.width,canvas.height); context.setTransform(zoom,0,0,zoom,0,0);
        paintStroke(context,{id:'geometry-only',points,tool:'pen',style:'ballpoint',sim:true,color:'#222',size:3.5,captureZoom:zoom},{minWidth:.8/zoom});
        if (i >= 5) costs.push(performance.now()-start);
      }
      result.cases.push({zoomPercent:zoom*100,inputPoints:count,cpu:summary(costs),rawMs:costs.map(round)});
      output.textContent = JSON.stringify(result,null,2);
      await new Promise(resolve => setTimeout(resolve,0));
    }
    canvas.remove(); status.textContent = 'Pomiar długich pociągnięć zakończony.';
  } catch(error) {result.error=error.message; status.textContent=error.message;}
  finally {output.textContent=JSON.stringify(result,null,2); button.disabled=run.disabled=false;}
};
