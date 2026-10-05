// Measure the local SVGs with the same font/layout engine used by the product.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const output = mkdtempSync(join(tmpdir(), 'bantu-floorplans-'));
const browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${output}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
async function until(check) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await check()) return; await pause(100); }
  throw new Error('Browser did not become ready');
}
try {
  await until(() => existsSync(join(output, 'DevToolsActivePort')));
  const port = readFileSync(join(output, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page' && target.url === 'about:blank').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data); const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id); clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
  };
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => reject(new Error(method)), 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const directory = join(process.cwd(), 'public/images/places/floorplan');
  const report = [];
  for (const file of readdirSync(directory).filter(file => file.endsWith('.svg'))) {
    const source = readFileSync(join(directory, file), 'utf8');
    const measurement = await evaluate(`(async()=>{
      document.body.innerHTML = ${JSON.stringify(source)};
      document.body.style.margin='0';
      const svg=document.querySelector('svg'); const vb=svg.viewBox.baseVal;
      svg.style.width=vb.width+'px'; svg.style.height=vb.height+'px';
      await document.fonts.ready;
      const polygon=node=>{
        const b=node.getBBox();const m=node.getScreenCTM();
        return [[b.x,b.y],[b.x+b.width,b.y],[b.x+b.width,b.y+b.height],[b.x,b.y+b.height]].map(([x,y])=>{const p=new DOMPoint(x,y).matrixTransform(m);return [p.x,p.y]});
      };
      const intersects=(a,b)=>{
        for(const p of [a,b])for(let i=0;i<4;i++){
          const q=p[(i+1)%4],axis=[-(q[1]-p[i][1]),q[0]-p[i][0]];
          const length=Math.hypot(...axis); if(!length)continue;
          const project=v=>v.map(([x,y])=>(x*axis[0]+y*axis[1])/length);
          const ap=project(a),bp=project(b);
          if(Math.min(Math.max(...ap),Math.max(...bp))-Math.max(Math.min(...ap),Math.min(...bp))<=.8)return false;
        }return true;
      };
      const texts=Array.from(svg.querySelectorAll('text')).filter(n=>getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden').map((n,index)=>({index,text:n.textContent.trim(),class:n.getAttribute('class'),font:getComputedStyle(n).fontSize,x:n.getAttribute('x'),y:n.getAttribute('y'),polygon:polygon(n)}));
      const collisions=[]; const outside=[]; const roomOverflow=[];
      for(let i=0;i<texts.length;i++){
        const a=texts[i]; if(a.polygon.some(([x,y])=>x<-.8||y<-.8||x>vb.width+.8||y>vb.height+.8))outside.push(a);
        for(let j=i+1;j<texts.length;j++){const b=texts[j];if(intersects(a.polygon,b.polygon))collisions.push([a,b]);}
      }
      for(const node of svg.querySelectorAll('text.label.exhibit,text.label.stair,text.label.passage')){
        const kind=['exhibit','stair','passage'].find(kind=>node.classList.contains(kind));
        let rooms=Array.from(svg.querySelectorAll('path.zone.'+kind));
        if(!rooms.length&&kind==='exhibit')rooms=Array.from(svg.querySelectorAll('path.zone.open-hall'));
        if(!rooms.length)continue;
        if(!polygon(node).every(([x,y])=>rooms.some(room=>room.isPointInFill(new DOMPoint(x,y).matrixTransform(room.getScreenCTM().inverse())))))roomOverflow.push(node.textContent.trim());
      }
      return {width:vb.width,height:vb.height,texts,collisions,outside,roomOverflow};
    })()`);
    report.push({ file, ...measurement });
    if (process.argv.includes('--screenshots')) {
      await command('Emulation.setDeviceMetricsOverride', { width: Math.ceil(measurement.width), height: Math.ceil(measurement.height), deviceScaleFactor: 1, mobile: false });
      const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(output, file.replace('.svg', '.png')), Buffer.from(shot.data, 'base64'));
    }
  }
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  if (process.argv.includes('--gallery')) {
    for (let page = 0; page < Math.ceil(report.length / 16); page++) {
      const cards = report.slice(page * 16, page * 16 + 16).map(item => {
        const svg = readFileSync(join(directory, item.file), 'utf8');
        return `<figure><figcaption>${item.file}</figcaption><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"/></figure>`;
      }).join('');
      await evaluate(`document.body.innerHTML=${JSON.stringify(`<style>body{margin:0;background:#e9efed;font-family:Arial,sans-serif}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:12px}figure{margin:0;background:white;border:1px solid #d8e0e4;border-radius:12px;height:324px;padding:8px}figcaption{font-size:12px;height:28px}img{width:100%;height:288px;object-fit:contain}</style><main class="grid">${cards}</main>`)};`);
      await evaluate('Promise.all(Array.from(document.images).map(img=>img.decode()))');
      await command('Emulation.setDeviceMetricsOverride', { width: 1780, height: 1440, deviceScaleFactor: 1, mobile: false });
      const shot = await command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(output, `gallery-${page+1}.png`), Buffer.from(shot.data, 'base64'));
    }
  }
  const failures = report.filter(item => item.collisions.length || item.outside.length || item.roomOverflow.length);
  console.log(JSON.stringify({ output, files: report.length, failures: failures.map(item => ({ file: item.file, collisions: item.collisions.map(pair => pair.map(text => text.text)), outside: item.outside.map(text => text.text), roomOverflow: item.roomOverflow })) }, null, 2));
  if (!process.argv.includes('--report')) assert.equal(failures.length, 0, 'Floorplan labels overlap or escape the canvas');
} finally { socket?.close(); browser.kill(); }
