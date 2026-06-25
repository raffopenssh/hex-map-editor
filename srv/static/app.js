/* Land Use Zonation editor */
(() => {
'use strict';

const USES = [
  {id:'settlement', label:'Permanent settlements', color:'#cccccc'},
  {id:'grazing',    label:'Cattle grazing',        color:'#8db05c'},
  {id:'hunting',    label:'Hunting',               color:'#d89146'},
  {id:'fishing',    label:'Fishing',               color:'#08a3e6'},
  {id:'farming',    label:'Farming',               color:'#f1ef62'},
  {id:'wildlife',   label:'Wildlife / occasional', color:'#dfe7c1'},
];
const USEMAP = Object.fromEntries(USES.map(u=>[u.id,u]));

// ---------- state ----------
let me = null;            // {authed, owner, name, hasSecret, ...}
let grid = null;          // {cells:[{id,r,c,ct,g}], bounds}
let cellById = new Map(); // id -> cell (with pre-split coords + bbox)
let state = new Map();    // id -> {u,w,grp,nt}
let rev = 0;
let activeUse = 'grazing';
let tool = 'draw';        // draw | erase
let selection = new Set();// selected cell ids (for group/note/delete)
let painting = false, paintErase = false, paintShift=false, lastPainted=null;

// ---------- map ----------
const map = L.map('map', {zoomControl:false, attributionControl:false, preferCanvas:true,
  minZoom:6, maxZoom:13, zoomSnap:0.5, wheelPxPerZoomLevel:120});
L.control.zoom({position:'bottomright'}).addTo(map);
L.control.attribution({position:'bottomright', prefix:false})
  .addAttribution('© OpenStreetMap, © CARTO').addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  {subdomains:'abcd', maxZoom:19}).addTo(map);

// custom canvas hex layer (manually redrawn, fixed to viewport)
const canvas = document.createElement('canvas');
canvas.style.position='absolute'; canvas.style.top='0'; canvas.style.left='0';
canvas.style.pointerEvents='none'; canvas.style.zIndex='400';
map.getContainer().appendChild(canvas);
const ctx = canvas.getContext('2d');
let dpr = window.devicePixelRatio||1;

function sizeCanvas(){
  const s = map.getSize();
  dpr = window.devicePixelRatio||1;
  canvas.width = s.x*dpr; canvas.height = s.y*dpr;
  canvas.style.width = s.x+'px'; canvas.style.height = s.y+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
}

let rafPending=false;
function scheduleDraw(){ if(rafPending) return; rafPending=true; requestAnimationFrame(()=>{rafPending=false; draw();}); }

function draw(){
  if(!grid) return;
  const s = map.getSize();
  ctx.clearRect(0,0,s.x,s.y);
  const b = map.getBounds().pad(0.1);
  const west=b.getWest(), east=b.getEast(), south=b.getSouth(), north=b.getNorth();
  const z = map.getZoom();
  const showOutline = z>=8.5;
  // first pass: filled uses
  for(const c of grid.cells){
    if(c.maxx<west||c.minx>east||c.maxy<south||c.miny>north) continue;
    const st = state.get(c.id);
    const pts = projectCell(c);
    if(st && st.u){
      ctx.beginPath(); pathPts(pts);
      ctx.fillStyle = USEMAP[st.u]? USEMAP[st.u].color : '#bbbbbb';
      ctx.globalAlpha = 0.82; ctx.fill(); ctx.globalAlpha=1;
    }
    if(showOutline){
      ctx.beginPath(); pathPts(pts);
      ctx.lineWidth=0.5; ctx.strokeStyle='rgba(90,90,80,.25)'; ctx.stroke();
    }
  }
  // second pass: wildlife range overlay (inset dark outline) + group + selection
  for(const c of grid.cells){
    if(c.maxx<west||c.minx>east||c.maxy<south||c.miny>north) continue;
    const st = state.get(c.id);
    if(st && st.w){
      const pts = projectCell(c, 0.72); // inset -> "second layer, slightly offset"
      ctx.beginPath(); pathPts(pts);
      ctx.lineWidth=1.6; ctx.strokeStyle='rgba(20,20,20,.9)'; ctx.stroke();
    }
  }
  // selection highlight
  if(selection.size){
    for(const id of selection){
      const c = cellById.get(id); if(!c) continue;
      if(c.maxx<west||c.minx>east||c.maxy<south||c.miny>north) continue;
      const pts = projectCell(c);
      ctx.beginPath(); pathPts(pts);
      ctx.fillStyle='rgba(58,125,92,.28)'; ctx.fill();
      ctx.lineWidth=2; ctx.strokeStyle='#2c5e44'; ctx.stroke();
    }
  }
}

function pathPts(pts){
  ctx.moveTo(pts[0],pts[1]);
  for(let i=2;i<pts.length;i+=2) ctx.lineTo(pts[i],pts[i+1]);
  ctx.closePath();
}

// project a cell's ring to container pixels; scale<1 insets toward centroid
function projectCell(c, scale){
  const ring=c.g, out=new Array(ring.length*2);
  const cp = map.latLngToContainerPoint([c.ct[1], c.ct[0]]);
  for(let i=0;i<ring.length;i++){
    const p = map.latLngToContainerPoint([ring[i][1], ring[i][0]]);
    let x=p.x, y=p.y;
    if(scale){ x = cp.x + (x-cp.x)*scale; y = cp.y + (y-cp.y)*scale; }
    out[i*2]=x; out[i*2+1]=y;
  }
  return out;
}

map.on('move zoom', scheduleDraw);
map.on('resize', ()=>{sizeCanvas(); scheduleDraw();});

// ---------- hit testing ----------
function cellAt(latlng){
  const x=latlng.lng, y=latlng.lat;
  for(const c of grid.cells){
    if(x<c.minx||x>c.maxx||y<c.miny||y>c.maxy) continue;
    if(pointInRing(x,y,c.g)) return c;
  }
  return null;
}
function pointInRing(x,y,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];
    if(((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}

// ---------- interaction ----------
const mapEl = map.getContainer();
function eventLatLng(e){
  const oe = e.touches&&e.touches[0] ? e.touches[0] : e;
  const rect = mapEl.getBoundingClientRect();
  return map.containerPointToLatLng([oe.clientX-rect.left, oe.clientY-rect.top]);
}

let pendingOps = [];   // queued cell ids per op for batching
let opAccum = {};      // op -> Set ids

function applyToCell(c, shift){
  if(!c) return;
  if(shift || tool==='select'){
    // toggle selection only
    if(selection.has(c.id)) selection.delete(c.id); else selection.add(c.id);
    updateStatusbar(); scheduleDraw(); return;
  }
  if(tool==='draw'){
    setLocal(c.id,{u:activeUse});
    selection.add(c.id);
    queueOp('setUse', c.id, activeUse);
  } else if(tool==='erase'){
    setLocal(c.id,{u:''});
    selection.delete(c.id);
    queueOp('clearUse', c.id, '');
  }
  updateStatusbar(); scheduleDraw();
}

function setLocal(id, patch){
  const cur = state.get(id) || {};
  const nx = Object.assign({}, cur, patch);
  // normalize
  if(nx.u==='') delete nx.u;
  if(!nx.w) delete nx.w;
  if(nx.grp==='') delete nx.grp;
  if(nx.nt==='') delete nx.nt;
  if(Object.keys(nx).length===0) state.delete(id); else state.set(id,nx);
}

// batch ops to the server
let opQueue = []; let flushTimer=null;
function queueOp(op, id, value, flag){
  opQueue.push({op,id,value,flag});
  if(!flushTimer) flushTimer=setTimeout(flushOps, 350);
}
async function flushOps(){
  flushTimer=null;
  if(!opQueue.length) return;
  // group consecutive same-op/value
  const groups=[]; 
  for(const o of opQueue){
    const last=groups[groups.length-1];
    if(last && last.op===o.op && last.value===o.value && last.flag===o.flag) last.ids.push(o.id);
    else groups.push({op:o.op, value:o.value, flag:o.flag, ids:[o.id]});
  }
  opQueue=[];
  for(const g of groups){
    try{
      const r = await api('/api/update','POST',{op:g.op, ids:g.ids, value:g.value||'', flag:!!g.flag});
      if(r && r.rev) rev=r.rev;
    }catch(err){ toast('Save failed'); }
  }
}

// pointer events
function onDown(e){
  if(!grid||!me||!me.authed) return;
  const shift = e.shiftKey;
  const c = cellAt(eventLatLng(e));
  if(!c){ return; }
  // prevent map drag while painting
  painting=true; paintShift=shift; lastPainted=c.id;
  map.dragging.disable();
  e.preventDefault();
  applyToCell(c, shift);
}
function onMove(e){
  if(!painting) return;
  const c = cellAt(eventLatLng(e));
  if(c && c.id!==lastPainted){ lastPainted=c.id; applyToCell(c, paintShift); }
}
function onUp(){
  if(painting){ painting=false; map.dragging.enable(); flushOps(); renderLegend(); }
}

mapEl.addEventListener('mousedown', e=>{ if(e.button===0) onDown(e); });
window.addEventListener('mousemove', onMove);
window.addEventListener('mouseup', onUp);
mapEl.addEventListener('touchstart', e=>{ if(e.touches.length===1) onDown(e); }, {passive:false});
mapEl.addEventListener('touchmove', e=>{ if(painting){ e.preventDefault(); onMove(e); } }, {passive:false});
window.addEventListener('touchend', onUp);

// ---------- legend ----------
function renderLegend(){
  const body=document.getElementById('legendBody'); body.innerHTML='';
  const counts={}; let wild=0;
  for(const st of state.values()){ if(st.u) counts[st.u]=(counts[st.u]||0)+1; if(st.w) wild++; }
  for(const u of USES){
    const row=document.createElement('div'); row.className='legend-row'+(u.id===activeUse?' active':'');
    row.innerHTML=`<span class="sw" style="background:${u.color}"></span>
      <span class="nm">${u.label}</span><span class="ct">${counts[u.id]||0}</span>`;
    row.onclick=()=>{ activeUse=u.id; if(tool==='erase') setTool('draw'); renderLegend();
      if(selection.size){ recolorSelection(u.id); } };
    body.appendChild(row);
  }
  const wrow=document.createElement('div'); wrow.className='legend-row';
  wrow.innerHTML=`<span class="sw wild"></span><span class="nm">Wildlife range</span><span class="ct">${wild}</span>`;
  wrow.onclick=()=>{ if(selection.size) toggleWildlifeSelection(); };
  body.appendChild(wrow);
}
document.getElementById('legendToggle').onclick=()=>{
  document.getElementById('legend').classList.toggle('collapsed');
};

// ---------- tools ----------
function setTool(t){
  tool=t;
  document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active', b.dataset.tool===t));
  mapEl.classList.remove('tool-draw','tool-erase');
  if(t==='draw'||t==='erase') mapEl.classList.add('tool-'+t);
}
document.querySelectorAll('.tool[data-tool]').forEach(b=>{
  b.onclick=()=>setTool(b.dataset.tool);
});
document.getElementById('menuBtn').onclick=openMenu;
document.getElementById('accountBtn').onclick=openMenu;

// ---------- status bar (selection actions) ----------
function updateStatusbar(){
  const sb=document.getElementById('statusbar');
  const n=selection.size;
  if(n===0){ sb.classList.add('hidden'); return; }
  sb.classList.remove('hidden');
  document.getElementById('selCount').textContent = n+' cell'+(n>1?'s':'')+' selected';
  // wildlife toggle state
  let allWild=true; for(const id of selection){ if(!(state.get(id)||{}).w){ allWild=false; break; } }
  document.getElementById('sbWildlife').classList.toggle('on', allWild);
}
document.getElementById('sbDone').onclick=()=>{ selection.clear(); updateStatusbar(); scheduleDraw(); };
document.getElementById('sbClear').onclick=()=>{
  const ids=[...selection];
  ids.forEach(id=>setLocal(id,{u:''}));
  api('/api/update','POST',{op:'clearUse', ids}).then(r=>{rev=r.rev;});
  renderLegend(); scheduleDraw();
};
document.getElementById('sbWildlife').onclick=()=>toggleWildlifeSelection();
document.getElementById('sbGroup').onclick=()=>groupSheet();
document.getElementById('sbNote').onclick=()=>noteSheet();

function recolorSelection(use){
  const ids=[...selection];
  ids.forEach(id=>setLocal(id,{u:use}));
  api('/api/update','POST',{op:'setUse', ids, value:use}).then(r=>{rev=r.rev;});
  renderLegend(); scheduleDraw();
}
function toggleWildlifeSelection(){
  const ids=[...selection]; if(!ids.length) return;
  let allWild=true; for(const id of ids){ if(!(state.get(id)||{}).w){ allWild=false; break; } }
  const flag=!allWild;
  ids.forEach(id=>setLocal(id,{w:flag?1:0}));
  api('/api/update','POST',{op:'setWildlife', ids, flag}).then(r=>{rev=r.rev;});
  renderLegend(); updateStatusbar(); scheduleDraw();
}

// ---------- sheets ----------
const sheet=document.getElementById('sheet'), overlay=document.getElementById('sheetOverlay');
function openSheet(html){ sheet.innerHTML=html; sheet.classList.remove('hidden'); overlay.classList.remove('hidden'); }
function closeSheet(){ sheet.classList.add('hidden'); overlay.classList.add('hidden'); }
overlay.onclick=closeSheet;

function groupSheet(){
  const ids=[...selection];
  const cur=(state.get(ids[0])||{}).grp||'';
  openSheet(`<h2>Group ${ids.length} cell${ids.length>1?'s':''}</h2>
    <p class="sub">Give these cells a shared label.</p>
    <label>Group name</label>
    <input type="text" id="grpInput" placeholder="e.g. Pibor cluster" value="${esc(cur)}">
    <div class="row end">
      <button class="btn ghost" id="grpClear">Remove group</button>
      <button class="btn primary" id="grpSave">Save</button>
    </div>`);
  document.getElementById('grpInput').focus();
  document.getElementById('grpSave').onclick=()=>{
    const v=document.getElementById('grpInput').value.trim();
    ids.forEach(id=>setLocal(id,{grp:v}));
    api('/api/update','POST',{op:'group', ids, value:v}).then(r=>{rev=r.rev;});
    closeSheet(); toast('Grouped'); scheduleDraw();
  };
  document.getElementById('grpClear').onclick=()=>{
    ids.forEach(id=>setLocal(id,{grp:''}));
    api('/api/update','POST',{op:'group', ids, value:''}).then(r=>{rev=r.rev;});
    closeSheet(); scheduleDraw();
  };
}
function noteSheet(){
  const ids=[...selection];
  const cur=(state.get(ids[0])||{}).nt||'';
  openSheet(`<h2>Annotate ${ids.length} cell${ids.length>1?'s':''}</h2>
    <p class="sub">Add a note to discuss this land use option.</p>
    <textarea id="noteInput" placeholder="Notes…">${esc(cur)}</textarea>
    <div class="row end">
      <button class="btn ghost" id="noteClear">Clear</button>
      <button class="btn primary" id="noteSave">Save</button>
    </div>`);
  document.getElementById('noteInput').focus();
  document.getElementById('noteSave').onclick=()=>{
    const v=document.getElementById('noteInput').value;
    ids.forEach(id=>setLocal(id,{nt:v}));
    api('/api/update','POST',{op:'note', ids, value:v}).then(r=>{rev=r.rev;});
    closeSheet(); toast('Note saved'); scheduleDraw();
  };
  document.getElementById('noteClear').onclick=()=>{
    ids.forEach(id=>setLocal(id,{nt:''}));
    api('/api/update','POST',{op:'note', ids, value:''}).then(r=>{rev=r.rev;});
    closeSheet();
  };
}

function openMenu(){
  openSheet(`<h2>${esc(me&&me.title||'Land Use Zonation')}</h2>
    <p class="sub">Signed in as <b>${esc(me&&me.name||'—')}</b>${me&&me.owner?' · owner':''}</p>
    <div class="row">
      <button class="btn primary block" id="mVersions">Versions &amp; share</button>
    </div>
    <div class="row">
      <button class="btn ghost" id="mImport">Import…</button>
      <button class="btn ghost" id="mExportCsv">Export CSV</button>
      <button class="btn ghost" id="mExportGeo">Export GPKG/GeoJSON</button>
    </div>
    <div class="row">
      <button class="btn ghost" id="mHelp">How it works</button>
      ${me&&me.owner?'<button class="btn ghost" id="mSecret">Change secret</button>':''}
      <button class="btn ghost" id="mLogout">Sign out</button>
    </div>`);
  document.getElementById('mVersions').onclick=versionsSheet;
  document.getElementById('mImport').onclick=importSheet;
  document.getElementById('mExportCsv').onclick=()=>{ window.location='/api/export?fmt=csv'; };
  document.getElementById('mExportGeo').onclick=()=>{ window.location='/api/export?fmt=geojson'; };
  document.getElementById('mHelp').onclick=helpSheet;
  document.getElementById('mLogout').onclick=async()=>{ await api('/api/logout','POST',{}); location.reload(); };
  const sb=document.getElementById('mSecret'); if(sb) sb.onclick=secretSheet;
}

function helpSheet(){
  openSheet(`<h2>How it works</h2>
    <p class="sub">Everything is the map.</p>
    <div class="hint">
      <b>Draw</b> — pick a use in the legend, then tap or drag across hexes to assign it.<br><br>
      <b>Rubber</b> — tap or drag to clear a hex's use.<br><br>
      <b>Select</b> — Shift-click (or shift-drag) hexes to select them without painting. Then group, annotate, add a wildlife range, recolour (tap a legend swatch) or clear them from the bar at the bottom.<br><br>
      <b>Wildlife range</b> sits as a second layer (dark outline) and can overlap any land use.<br><br>
      Each hex ≈ <b>10&nbsp;km²</b>. Changes save automatically and everyone with the secret edits the same map.
    </div>
    <div class="row end"><button class="btn primary" onclick="this.closest('.sheet').classList.add('hidden');document.getElementById('sheetOverlay').classList.add('hidden')">Got it</button></div>`);
}

async function versionsSheet(){
  openSheet(`<h2>Versions</h2><p class="sub">Save a named snapshot, share a link, or restore.</p>
    <div class="codebox"><input type="text" id="verName" placeholder="Version name (e.g. Option B)">
    <button class="btn primary" id="verSave">Save</button></div>
    <div id="verList" class="list"><div class="list-item"><div class="meta"><div class="s">Loading…</div></div></div></div>`);
  document.getElementById('verSave').onclick=async()=>{
    const name=document.getElementById('verName').value.trim();
    const r=await api('/api/versions','POST',{name});
    if(r&&r.token){ toast('Saved'); document.getElementById('verName').value=''; loadVersions(); }
  };
  loadVersions();
}
async function loadVersions(){
  const r=await api('/api/versions','GET');
  const list=document.getElementById('verList'); if(!list) return;
  const vs=(r&&r.versions)||[];
  if(!vs.length){ list.innerHTML='<div class="list-item"><div class="meta"><div class="s">No versions yet.</div></div></div>'; return; }
  list.innerHTML='';
  for(const v of vs){
    const url=location.origin+'/?v='+v.token;
    const item=document.createElement('div'); item.className='list-item';
    item.innerHTML=`<div class="meta"><div class="t">${esc(v.name)}</div>
      <div class="s">${esc(v.author||'')} · ${fmtDate(v.created)}</div></div>
      <button class="btn ghost mini" data-act="share">Link</button>
      <button class="btn ghost mini" data-act="restore">Restore</button>`;
    item.querySelector('[data-act="share"]').onclick=()=>{ copy(url); toast('Link copied'); };
    item.querySelector('[data-act="restore"]').onclick=async()=>{
      if(!confirm('Restore "'+v.name+'"? This replaces the current map.')) return;
      const rr=await api('/api/versions/'+v.token+'/restore','POST',{});
      if(rr&&rr.cells){ applyServerState(rr); toast('Restored'); closeSheet(); }
    };
    list.appendChild(item);
  }
}

function importSheet(){
  openSheet(`<h2>Import</h2><p class="sub">Load a hive CSV or GeoJSON of cell assignments.</p>
    <label>Mode</label>
    <select id="impMode"><option value="replace">Replace whole map</option><option value="merge">Merge into current</option></select>
    <label>Paste CSV or GeoJSON</label>
    <textarea id="impText" placeholder="cell_id,land_use,wildlife,group,note&#10;1,grazing,0,,"></textarea>
    <label>…or choose a file</label>
    <input type="file" id="impFile" accept=".csv,.geojson,.json">
    <div class="row end"><button class="btn primary" id="impGo">Import</button></div>
    <div class="hint">CSV columns: cell_id, land_use, wildlife (0/1), group, note. GeoJSON features need a <code>cell_id</code> property.</div>`);
  document.getElementById('impFile').onchange=e=>{
    const f=e.target.files[0]; if(!f) return;
    const rd=new FileReader(); rd.onload=()=>{ document.getElementById('impText').value=rd.result; }; rd.readAsText(f);
  };
  document.getElementById('impGo').onclick=async()=>{
    const text=document.getElementById('impText').value.trim();
    if(!text){ toast('Nothing to import'); return; }
    const mode=document.getElementById('impMode').value;
    const fmt = text[0]==='{' ? 'geojson' : 'csv';
    const r=await api('/api/import','POST',{format:fmt, text, mode});
    if(r&&r.cells){ applyServerState(r); toast('Imported '+(r.imported||0)+' cells'); closeSheet(); }
    else toast('Import failed');
  };
}

function secretSheet(){
  openSheet(`<h2>Change secret</h2><p class="sub">Editors need this to access the map.</p>
    <label>New secret</label><input type="text" id="secInput" placeholder="new shared secret">
    <div class="row end"><button class="btn primary" id="secSave">Update</button></div>`);
  document.getElementById('secSave').onclick=async()=>{
    const v=document.getElementById('secInput').value.trim(); if(!v) return;
    const r=await api('/api/reset-secret','POST',{secret:v});
    if(r&&r.ok){ toast('Secret updated'); closeSheet(); }
  };
}

// ---------- auth gate ----------
function setupSheet(){
  openSheet(`<h2>Set up your map</h2>
    <p class="sub">You're the owner. Choose a secret to share with collaborators.</p>
    <label>Map title</label><input type="text" id="suTitle" value="Land Use Zonation">
    <label>Shared secret</label><input type="text" id="suSecret" placeholder="choose a secret phrase">
    <label>Your editor name</label><input type="text" id="suName" placeholder="Owner">
    <div class="row end"><button class="btn primary" id="suGo">Start mapping</button></div>`);
  overlay.onclick=null;
  document.getElementById('suGo').onclick=async()=>{
    const secret=document.getElementById('suSecret').value.trim();
    if(!secret){ toast('Pick a secret'); return; }
    const title=document.getElementById('suTitle').value.trim();
    const name=document.getElementById('suName').value.trim();
    const r=await api('/api/setup','POST',{secret,title,name});
    if(r&&r.ok){ closeSheet(); overlay.onclick=closeSheet; boot(); } else toast('Setup failed');
  };
}
function loginSheet(){
  openSheet(`<h2>${esc(me.title||'Land Use Zonation')}</h2>
    <p class="sub">Enter the shared secret to join as an editor.</p>
    <label>Secret</label><input type="password" id="liSecret" placeholder="shared secret">
    <label>Your name <span style="font-weight:400">(optional — we'll pick one)</span></label>
    <input type="text" id="liName" placeholder="anonymous editor">
    <div class="row end"><button class="btn primary" id="liGo">Enter</button></div>`);
  overlay.onclick=null;
  const go=async()=>{
    const secret=document.getElementById('liSecret').value;
    const name=document.getElementById('liName').value.trim();
    const r=await api('/api/login','POST',{secret,name});
    if(r&&r.ok){ closeSheet(); overlay.onclick=closeSheet; boot(); } else toast(r&&r.error||'Wrong secret');
  };
  document.getElementById('liGo').onclick=go;
  document.getElementById('liSecret').addEventListener('keydown',e=>{if(e.key==='Enter')go();});
}

// ---------- data load ----------
function applyServerState(r){
  if(r.rev) rev=r.rev;
  if(r.changed){ // partial
    for(const [id,st] of Object.entries(r.changed)){
      const n=Number(id);
      if(!st || (!st.u&&!st.w&&!st.grp&&!st.nt)) state.delete(n);
      else state.set(n, normSt(st));
    }
  } else if(r.cells){ // full
    state.clear();
    for(const [id,st] of Object.entries(r.cells)) state.set(Number(id), normSt(st));
  }
  renderLegend(); updateStatusbar(); scheduleDraw();
}
function normSt(st){ const o={}; if(st.u)o.u=st.u; if(st.w)o.w=1; if(st.grp)o.grp=st.grp; if(st.nt)o.nt=st.nt; return o; }

async function loadGrid(){
  const res=await fetch('/static/data/grid.json'); grid=await res.json();
  for(const c of grid.cells){
    let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
    for(const p of c.g){ if(p[0]<minx)minx=p[0]; if(p[0]>maxx)maxx=p[0]; if(p[1]<miny)miny=p[1]; if(p[1]>maxy)maxy=p[1]; }
    c.minx=minx;c.miny=miny;c.maxx=maxx;c.maxy=maxy;
    cellById.set(c.id,c);
  }
  const bb=grid.bounds; // [w,s,e,n]
  map.fitBounds([[bb[1],bb[0]],[bb[3],bb[2]]], {padding:[20,20]});
}

async function boot(){
  me=await api('/api/me','GET');
  if(!me.hasSecret){ // unconfigured
    if(me.email && me.owner!==false){ setupSheet(); }
    else { setupSheet(); } // first visitor sets it up
    return;
  }
  if(!me.authed){ loginSheet(); return; }
  document.getElementById('legendTitle').textContent='Land use';
  if(!grid) await loadGrid();
  sizeCanvas();
  setTool('draw');
  const st=await api('/api/state','GET');
  if(st&&st.cells) applyServerState(st);
  // shared version view?
  const vtok=new URLSearchParams(location.search).get('v');
  if(vtok){ loadSharedVersion(vtok); }
  scheduleDraw();
  renderLegend();
}
async function loadSharedVersion(tok){
  const r=await api('/api/versions/'+tok,'GET');
  if(r&&r.cells){
    toast('Viewing version: '+(r.name||tok));
    openSheet(`<h2>${esc(r.name||'Shared version')}</h2>
      <p class="sub">by ${esc(r.author||'—')} · ${fmtDate(r.created)}</p>
      <p class="hint">You're viewing a saved snapshot. Restore it to make it the working map, or dismiss to keep editing the current one.</p>
      <div class="row end"><button class="btn ghost" id="svDismiss">Dismiss</button>
      <button class="btn primary" id="svRestore">Restore this version</button></div>`);
    // preview the snapshot
    const backup=new Map(state);
    state.clear(); for(const [id,s] of Object.entries(r.cells)) state.set(Number(id),normSt(s));
    renderLegend(); scheduleDraw();
    document.getElementById('svDismiss').onclick=()=>{ state=backup; renderLegend(); scheduleDraw(); closeSheet();
      history.replaceState({},'','/'); };
    document.getElementById('svRestore').onclick=async()=>{
      const rr=await api('/api/versions/'+tok+'/restore','POST',{});
      if(rr&&rr.cells){ applyServerState(rr); toast('Restored'); closeSheet(); history.replaceState({},'','/'); }
    };
  }
}

// ---------- utilities ----------
async function api(path, method, body){
  const opt={method, headers:{}};
  if(body!==undefined){ opt.headers['Content-Type']='application/json'; opt.body=JSON.stringify(body); }
  const res=await fetch(path, opt);
  try{ return await res.json(); }catch(e){ return null; }
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.classList.add('hidden'),2200); }
function copy(text){ navigator.clipboard&&navigator.clipboard.writeText(text); }
function fmtDate(s){ try{ const d=new Date(s); return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}); }catch(e){ return s; } }

sizeCanvas();
boot();
})();
