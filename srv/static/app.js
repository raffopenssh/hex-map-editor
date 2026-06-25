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
let tool = 'draw';        // draw | erase | select
let selection = new Set();// selected cell ids (for group/note/delete)
let painting = false, paintSelect=false, lastPainted=null;
let brushSize = 1;        // 1 = single hex, 2 = +ring, 3 = +2 rings
let hoverId = null;       // cell under pointer (desktop brush preview)
let dragMoved = false;    // pointer moved across cells since down
let downCell = null;      // cell id where the current stroke started
let selectAction = null;  // 'add' | 'remove' (consistent within a shift-drag)

// adjacency + dissolved-outline machinery
const adjacency = new Map();          // id -> [neighbour ids]
let outlinesDirty = true;             // wildlife/group outlines need rebuild
let selDirty = true;                  // selection outline needs rebuild
const outlineCache = {wild:[], groups:[], sel:[]};
let regionCache = {set:null, segs:null, use:null}; // contiguous same-use region (magic-wand / hover)
function markDirty(){ outlinesDirty=true; regionCache.set=null; }

// per-layer visibility (use ids + '__wild' for the wildlife-range overlay)
const hiddenLayers = new Set();

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
  const inView=(c)=>!(c.maxx<west||c.minx>east||c.maxy<south||c.miny>north);

  // pass 1: land-use fills. No per-cell boundaries (dissolved look); we stroke each
  // hex in its own fill colour only to seal antialiasing hairlines between neighbours.
  ctx.lineJoin='round';
  for(const c of grid.cells){
    if(!inView(c)) continue;
    const st = state.get(c.id);
    if(!(st && st.u)) continue;
    if(hiddenLayers.has(st.u)) continue;
    const col = USEMAP[st.u]? USEMAP[st.u].color : '#bbbbbb';
    const pts = projectCell(c);
    ctx.beginPath(); pathPts(pts);
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = col; ctx.fill();
    ctx.lineWidth = 0.9; ctx.strokeStyle = col; ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // very faint hex guide while actively editing & zoomed in (NOT a strong boundary)
  if(z>=9.5 && (tool==='draw'||tool==='erase'||tool==='select')){
    ctx.beginPath();
    for(const c of grid.cells){ if(!inView(c)) continue; const pts=projectCell(c); pathPts(pts); }
    ctx.lineWidth=0.5; ctx.strokeStyle='rgba(120,120,110,.10)'; ctx.stroke();
  }

  if(outlinesDirty) rebuildOutlines();

  // pass 2: group outlines — grouped cells dissolve into one region (internal
  // boundaries gone), drawn as a single dashed accent outline.
  if(outlineCache.groups.length){
    ctx.lineJoin='round'; ctx.lineCap='round'; ctx.setLineDash([5,4]);
    ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,.65)';
    for(const segs of outlineCache.groups) strokeSegs(segs,west,east,south,north);
    ctx.lineWidth=1.7; ctx.strokeStyle='rgba(58,125,92,.95)';
    for(const segs of outlineCache.groups) strokeSegs(segs,west,east,south,north);
    ctx.setLineDash([]);
  }

  // pass 3: wildlife layer — the ONLY layer with strong, visible boundaries.
  // Dissolved into merged regions with a bold dark outline (white halo for contrast).
  if(outlineCache.wild.length && !hiddenLayers.has('__wild')){
    ctx.lineJoin='round'; ctx.lineCap='round';
    ctx.lineWidth=3.6; ctx.strokeStyle='rgba(255,255,255,.75)';
    strokeSegs(outlineCache.wild,west,east,south,north);
    ctx.lineWidth=2.1; ctx.strokeStyle='rgba(18,18,18,.94)';
    strokeSegs(outlineCache.wild,west,east,south,north);
  }

  // pass 4: selection — translucent fill + single dissolved outline.
  if(selection.size){
    if(selDirty){ outlineCache.sel=computeOutline(selection); selDirty=false; }
    for(const id of selection){
      const c=cellById.get(id); if(!c||!inView(c)) continue;
      const pts=projectCell(c); ctx.beginPath(); pathPts(pts);
      ctx.fillStyle='rgba(58,125,92,.20)'; ctx.fill();
    }
    ctx.lineJoin='round'; ctx.lineCap='round';
    ctx.lineWidth=2.4; ctx.strokeStyle='#2c5e44';
    strokeSegs(outlineCache.sel,west,east,south,north);
  }

  // pass 5: brush / magic-wand hover preview (desktop)
  if(hoverId!=null && !painting && (tool==='draw'||tool==='erase'||tool==='select')){
    const pv = hoverPreview();
    if(pv){
      ctx.lineJoin='round'; ctx.lineCap='round'; ctx.setLineDash([4,3]);
      ctx.lineWidth=2; ctx.strokeStyle = tool==='erase' ? 'rgba(178,59,59,.9)' : 'rgba(44,94,68,.95)';
      strokeSegs(pv,west,east,south,north);
      ctx.setLineDash([]);
    }
  }
}

// stroke a list of geo segments [lng1,lat1,lng2,lat2] in container pixels
function strokeSegs(segs,west,east,south,north){
  if(!segs||!segs.length) return;
  ctx.beginPath();
  for(const g of segs){
    const x1=g[0],y1=g[1],x2=g[2],y2=g[3];
    if((x1<west&&x2<west)||(x1>east&&x2>east)||(y1<south&&y2<south)||(y1>north&&y2>north)) continue;
    const p1=map.latLngToContainerPoint([y1,x1]);
    const p2=map.latLngToContainerPoint([y2,x2]);
    ctx.moveTo(p1.x,p1.y); ctx.lineTo(p2.x,p2.y);
  }
  ctx.stroke();
}

// boundary edges of a set of cells (edges belonging to exactly one member)
function vkey(p){ return Math.round(p[0]*1e6)+','+Math.round(p[1]*1e6); }
function ekey(a,b){ const ka=vkey(a),kb=vkey(b); return ka<kb? ka+'|'+kb : kb+'|'+ka; }
function computeOutline(ids){
  const set = ids instanceof Set ? ids : new Set(ids);
  const cnt=new Map(), geo=new Map();
  for(const id of set){
    const c=cellById.get(id); if(!c) continue;
    const g=c.g, n=g.length;
    for(let i=0;i<n;i++){
      const a=g[i], bb=g[(i+1)%n], k=ekey(a,bb);
      cnt.set(k,(cnt.get(k)||0)+1);
      if(!geo.has(k)) geo.set(k,[a[0],a[1],bb[0],bb[1]]);
    }
  }
  const segs=[];
  for(const [k,c] of cnt){ if(c===1) segs.push(geo.get(k)); }
  return segs;
}
function rebuildOutlines(){
  const wild=[]; const groups=new Map();
  for(const [id,st] of state){
    if(st.w) wild.push(id);
    if(st.grp){ let a=groups.get(st.grp); if(!a){a=[];groups.set(st.grp,a);} a.push(id); }
  }
  outlineCache.wild = computeOutline(wild);
  outlineCache.groups = [];
  for(const ids of groups.values()) outlineCache.groups.push(computeOutline(ids));
  outlinesDirty=false;
}

// neighbours within (size-1) hex rings of a centre cell
function brushCells(centerId, size){
  if(size<=1) return [centerId];
  const seen=new Set([centerId]); let frontier=[centerId];
  for(let d=1; d<size; d++){
    const next=[];
    for(const id of frontier) for(const nb of (adjacency.get(id)||[])) if(!seen.has(nb)){ seen.add(nb); next.push(nb); }
    frontier=next;
  }
  return [...seen];
}
// contiguous patch of cells sharing the same land use as the seed (cached)
function contiguousRegion(id){
  if(regionCache.set && regionCache.set.has(id)) return regionCache;
  const u=(state.get(id)||{}).u||''; const seen=new Set([id]); const q=[id]; let cap=6000;
  while(q.length && cap-->0){ const x=q.pop();
    for(const nb of (adjacency.get(x)||[])){ if(seen.has(nb)) continue;
      if(((state.get(nb)||{}).u||'')===u){ seen.add(nb); q.push(nb); } } }
  regionCache={set:seen, segs:computeOutline(seen), use:u};
  return regionCache;
}
function hoverPreview(){
  if(hoverId==null) return null;
  if(tool==='select' && brushSize===1) return contiguousRegion(hoverId).segs;
  return computeOutline(brushCells(hoverId, brushSize));
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
// nearest cell by centroid — lets you draw "anywhere", even outside/between hexes
let nearestScale=null;
function nearestCell(latlng){
  const x=latlng.lng, y=latlng.lat;
  if(nearestScale==null){ const la=(grid.bounds[1]+grid.bounds[3])/2; nearestScale=Math.cos(la*Math.PI/180); }
  let best=null, bd=Infinity;
  for(const c of grid.cells){
    const dx=(c.ct[0]-x)*nearestScale, dy=c.ct[1]-y; const d=dx*dx+dy*dy;
    if(d<bd){ bd=d; best=c; }
  }
  return best;
}
// cell under the pointer, snapping to the nearest one if the point misses every hex
function pickCell(latlng){ return cellAt(latlng) || nearestCell(latlng); }
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

function applyToCell(c, isSelect, first){
  if(!c) return;
  if(isSelect || tool==='select'){
    // magic-wand: a single tap (brush=1, not dragged) grabs the whole same-use patch;
    // dragging switches to plain per-hex lasso selection.
    const ids = (first && brushSize===1)
      ? [...contiguousRegion(c.id).set]
      : brushCells(c.id, brushSize);
    // first cell of a drag decides whether we're adding or removing
    if(selectAction==null) selectAction = selection.has(c.id) ? 'remove' : 'add';
    for(const id of ids){ if(selectAction==='add') selection.add(id); else selection.delete(id); }
    selDirty=true; updateStatusbar(); scheduleDraw(); return;
  }
  const ids = brushCells(c.id, brushSize);
  if(tool==='draw'){
    for(const id of ids){ setLocal(id,{u:activeUse}); selection.add(id); queueOp('setUse', id, activeUse); }
    selDirty=true;
  } else if(tool==='erase'){
    for(const id of ids){ setLocal(id,{u:''}); selection.delete(id); queueOp('clearUse', id, ''); }
    selDirty=true;
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
  markDirty();
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
  const isSelect = e.shiftKey || tool==='select';
  const c = pickCell(eventLatLng(e));
  if(!c){ return; }
  painting=true; paintSelect=isSelect; lastPainted=c.id; downCell=c.id; dragMoved=false;
  selectAction=null;
  map.dragging.disable();
  e.preventDefault();
  applyToCell(c, isSelect, true);
}
function onMove(e){
  if(!painting) return;
  const c = pickCell(eventLatLng(e));
  if(c && c.id!==lastPainted){
    lastPainted=c.id; dragMoved=true;
    applyToCell(c, paintSelect, false);
  }
}
function onUp(){
  if(painting){ painting=false; map.dragging.enable(); selectAction=null; flushOps(); renderLegend(); }
}
// desktop hover preview for brush / magic-wand
function onHover(e){
  if(painting || !grid || !me || !me.authed) return;
  if(!(tool==='draw'||tool==='erase'||tool==='select')){ if(hoverId!=null){hoverId=null;scheduleDraw();} return; }
  const c = pickCell(eventLatLng(e));
  const id = c? c.id : null;
  if(id!==hoverId){ hoverId=id; scheduleDraw(); }
}

mapEl.addEventListener('mousedown', e=>{ if(e.button===0) onDown(e); });
window.addEventListener('mousemove', e=>{ onMove(e); onHover(e); });
window.addEventListener('mouseup', onUp);
mapEl.addEventListener('mouseleave', ()=>{ if(hoverId!=null){ hoverId=null; scheduleDraw(); } });
mapEl.addEventListener('touchstart', e=>{ if(e.touches.length===1) onDown(e); }, {passive:false});
mapEl.addEventListener('touchmove', e=>{ if(painting){ e.preventDefault(); onMove(e); } }, {passive:false});
window.addEventListener('touchend', onUp);

// ---------- legend ----------
function renderLegend(){
  const body=document.getElementById('legendBody'); body.innerHTML='';
  const counts={}; let wild=0;
  for(const st of state.values()){ if(st.u) counts[st.u]=(counts[st.u]||0)+1; if(st.w) wild++; }
  const mkRow=(id,label,swHTML,count,onPick)=>{
    const hidden=hiddenLayers.has(id);
    const row=document.createElement('div');
    row.className='legend-row'+(id===activeUse?' active':'')+(hidden?' hidden-layer':'');
    row.innerHTML=`<button class="eye" title="${hidden?'Show':'Hide'} layer">${hidden?'\u2298':'\u25c9'}</button>
      ${swHTML}<span class="nm">${label}</span><span class="ct">${count}</span>`;
    row.querySelector('.eye').onclick=(e)=>{ e.stopPropagation();
      if(hidden) hiddenLayers.delete(id); else hiddenLayers.add(id);
      renderLegend(); scheduleDraw(); };
    row.onclick=onPick;
    body.appendChild(row);
  };
  for(const u of USES){
    mkRow(u.id, u.label, `<span class="sw" style="background:${u.color}"></span>`, counts[u.id]||0,
      ()=>{ activeUse=u.id; if(tool==='erase') setTool('draw'); renderLegend();
        if(selection.size) recolorSelection(u.id); });
  }
  // Wildlife range — separate overlay layer. Tapping it (with a selection) toggles
  // wildlife on those cells; the eye hides/shows the layer.
  mkRow('__wild', 'Wildlife range', `<span class="sw wild"></span>`, wild,
    ()=>{ if(selection.size) toggleWildlifeSelection(); else toast('Select hexes, then tap to toggle wildlife'); });
}
document.getElementById('legendToggle').onclick=()=>{
  document.getElementById('legend').classList.toggle('collapsed');
};

// ---------- tools ----------
function setTool(t){
  tool=t;
  document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active', b.dataset.tool===t));
  mapEl.classList.remove('tool-draw','tool-erase','tool-select');
  if(t==='draw'||t==='erase'||t==='select') mapEl.classList.add('tool-'+t);
  // brush control is relevant to all three editing tools
  document.getElementById('brushctl').classList.toggle('hidden', !(t==='draw'||t==='erase'||t==='select'));
  hoverId=null; scheduleDraw();
}
document.querySelectorAll('.tool[data-tool]').forEach(b=>{
  b.onclick=()=>setTool(b.dataset.tool);
});
// brush size buttons
document.querySelectorAll('.bz[data-bz]').forEach(b=>{
  b.onclick=()=>{
    brushSize=Number(b.dataset.bz);
    document.querySelectorAll('.bz').forEach(x=>x.classList.toggle('on', x===b));
    scheduleDraw();
  };
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
}
document.getElementById('sbDone').onclick=()=>{ selection.clear(); selDirty=true; updateStatusbar(); scheduleDraw(); };
document.getElementById('sbClear').onclick=()=>{
  const ids=[...selection];
  ids.forEach(id=>setLocal(id,{u:''}));
  api('/api/update','POST',{op:'clearUse', ids}).then(r=>{rev=r.rev;});
  renderLegend(); scheduleDraw();
};
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
      <button class="btn ghost" id="mExportGeo">Export GeoJSON</button>
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
      <b>Draw</b> — pick a use in the legend, then tap or drag to paint hexes. You can draw <i>anywhere</i> on the map — it snaps to the nearest hex.<br><br>
      <b>Rubber</b> — tap or drag to clear a hex's use.<br><br>
      <b>Brush size</b> — the dots next to the tools paint 1, 7, or 19 hexes at once.<br><br>
      <b>Select</b> — tap a hex to grab its whole same-colour patch (magic wand), or drag to lasso. Shift-click works in any tool. Then group, annotate, recolour (tap a legend swatch) or clear them from the bottom bar.<br><br>
      <b>Layers</b> — tap the ◉ eye in the legend to hide/show a layer. <b>Wildlife range</b> is a separate overlay (the only layer with a bold outline) — select hexes then tap it in the legend to toggle. Grouped or wildlife cells <b>dissolve</b> into one region.<br><br>
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
    <label>Paste CSV or GeoJSON <span style="font-weight:400">(GeoJSON opens straight into QGIS → save as .gpkg)</span></label>
    <textarea id="impText" placeholder="cell_id,lat,lon,land_use,wildlife,group,note&#10;1,7.90,31.85,grazing,0,,"></textarea>
    <label>…or choose a file</label>
    <input type="file" id="impFile" accept=".csv,.geojson,.json">
    <div class="row end"><button class="btn primary" id="impGo">Import</button></div>
    <div class="hint">CSV columns are matched by header name: cell_id, land_use, wildlife (0/1), group, note. The exported lat/lon columns are ignored on import. GeoJSON features need a <code>cell_id</code> property.</div>`);
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
  markDirty(); selDirty=true;
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
  buildAdjacency();
  const bb=grid.bounds; // [w,s,e,n]
  map.fitBounds([[bb[1],bb[0]],[bb[3],bb[2]]], {padding:[20,20]});
}

// build hex adjacency from shared edges (vertices are exact across neighbours)
function buildAdjacency(){
  const edge=new Map(); // ekey -> [id,...]
  for(const c of grid.cells){
    const g=c.g, n=g.length;
    for(let i=0;i<n;i++){ const k=ekey(g[i],g[(i+1)%n]);
      let a=edge.get(k); if(!a){a=[];edge.set(k,a);} a.push(c.id); }
  }
  for(const c of grid.cells) adjacency.set(c.id,[]);
  for(const ids of edge.values()){
    if(ids.length===2){ adjacency.get(ids[0]).push(ids[1]); adjacency.get(ids[1]).push(ids[0]); }
  }
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
