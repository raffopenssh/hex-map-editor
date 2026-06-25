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
// A hex has independent facets: a land use (colour), a wildlife-range overlay, and
// a group. Each has its own visibility (land-use layers + the '__wild' overlay).
// A cell is "visible" — i.e. drawable / selectable / outline-worthy — if ANY of its
// facets is currently shown. This keeps the two-uses-per-hex case working: a hex
// that is hidden grazing but visible wildlife range is still there.
function useVisible(id){ const st=state.get(id); return !!(st && st.u && !hiddenLayers.has(st.u)); }
function wildVisible(id){ const st=state.get(id); return !!(st && st.w && !hiddenLayers.has('__wild')); }
function cellVisible(id){ return useVisible(id) || wildVisible(id); }

// geolocation: subtly flash the hex the user is standing in
let geoOn = false, geoWatchId = null, geoCellId = null, geoLatLng = null;
let geoAnimating = false;

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
    // only the OUTER boundary of each group is traced (computeOutline dissolves
    // shared inner edges); keep it subtle.
    ctx.lineJoin='round'; ctx.lineCap='round'; ctx.setLineDash([3,4]);
    ctx.lineWidth=2; ctx.strokeStyle='rgba(255,255,255,.45)';
    for(const segs of outlineCache.groups) strokeSegs(segs,west,east,south,north);
    ctx.lineWidth=1; ctx.strokeStyle='rgba(58,125,92,.55)';
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

  // pass 6: "you are here" — subtly flash the outline of the hex you're standing in
  if(geoOn && geoCellId!=null){
    const c = cellById.get(geoCellId);
    if(c && inView(c)){
      const t = (Math.sin(performance.now()/650)+1)/2; // 0..1 slow pulse
      const pts = projectCell(c);
      ctx.lineJoin='round';
      ctx.beginPath(); pathPts(pts);
      ctx.lineWidth = 2 + t*2.5;
      ctx.strokeStyle = `rgba(58,125,92,${0.35 + t*0.55})`;
      ctx.stroke();
    }
  }
}

// drive a gentle continuous redraw while location is shown (for the pulse)
function geoPulseLoop(){
  if(!(geoOn && geoCellId!=null)){ geoAnimating=false; return; }
  geoAnimating=true;
  scheduleDraw();
  requestAnimationFrame(geoPulseLoop);
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
    // outlines only trace cells that are actually visible (their use layer is on).
    // hidden layers contribute no boundaries — nothing should be drawn for them.
    if(!cellVisible(id)) continue;
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
  // in select mode you can only grab visible hexes — don't preview hidden patches.
  if(tool==='select'){
    if(!cellVisible(hoverId)) return null;
    if(brushSize===1) return contiguousRegion(hoverId).segs;
    return computeOutline(brushCells(hoverId, brushSize).filter(cellVisible));
  }
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
    // you can only select what you can see: hidden layers are not selectable.
    if(!cellVisible(c.id)){
      // allow de-selecting a stray hidden cell that's already in the selection,
      // but never add new hidden cells.
      if(selection.has(c.id)){ selection.delete(c.id); selDirty=true; updateStatusbar(); scheduleDraw(); }
      return;
    }
    // magic-wand: a single tap (brush=1, not dragged) grabs the whole same-use patch.
    // BUT a grouped hex is picked individually, so you can ungroup hexes one by one.
    // dragging switches to plain per-hex lasso selection.
    const grouped = !!(state.get(c.id)||{}).grp;
    const raw = (first && brushSize===1 && !grouped)
      ? [...contiguousRegion(c.id).set]
      : brushCells(c.id, brushSize);
    const ids = raw.filter(cellVisible); // never pull in hidden cells
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
  // Pan tool: leave the gesture to Leaflet so the map moves. Shift still selects.
  if(tool==='pan' && !e.shiftKey) return;
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
// desktop hover preview for brush / magic-wand + info tooltip
function onHover(e){
  if(painting || !grid || !me || !me.authed){ return; }
  const editing = (tool==='draw'||tool==='erase'||tool==='select');
  const c = cellAt(eventLatLng(e)); // exact cell (not snapped) for the tooltip
  const id = c? c.id : null;
  // brush / wand preview only for editing tools, and only when over a real hex
  let previewId=null; if(editing){ const pc=pickCell(eventLatLng(e)); previewId=pc?pc.id:null; }
  if(previewId!==hoverId){ hoverId=previewId; scheduleDraw(); }
  // tooltip: any tool, only when actually over an assigned/known cell
  updateHovertip(c, e);
}

function cellInfoHTML(c){
  const st=state.get(c.id)||{};
  const areaHa = (grid.cellAreaKm2||10)*100; // km² -> ha
  let html='';
  const use=st.u?USEMAP[st.u]:null;
  html+=`<div class="ht-row"><b>${use?esc(use.label):'Unassigned'}</b></div>`;
  if(st.grp){
    let cells=0; for(const s of state.values()) if(s.grp===st.grp) cells++;
    html+=`<div class="ht-row">Group: <b>${esc(st.grp)}</b> · ${cells} hex · ${fmtHa(cells*areaHa)}</div>`;
  } else {
    html+=`<div class="ht-row">${fmtHa(areaHa)}</div>`;
  }
  if(st.w) html+=`<div class="ht-row">Wildlife range</div>`;
  if(st.nt) html+=`<div class="ht-note">${esc(st.nt)}</div>`;
  return html;
}
function fmtHa(ha){
  if(ha>=100000) return (ha/100).toLocaleString(undefined,{maximumFractionDigits:0})+' km\u00b2';
  return ha.toLocaleString(undefined,{maximumFractionDigits:0})+' ha';
}
function updateHovertip(c, e){
  const tip=document.getElementById('hovertip');
  if(!c){ hideHovertip(); return; }
  const st=state.get(c.id);
  // only show when there's something worth showing (assigned, grouped, noted, wildlife)
  if(!st || (!st.u && !st.grp && !st.nt && !st.w)){ hideHovertip(); return; }
  tip.innerHTML=cellInfoHTML(c);
  tip.classList.remove('hidden');
  const oe = e.touches&&e.touches[0]?e.touches[0]:e;
  const pad=14; let x=oe.clientX+pad, y=oe.clientY+pad;
  const r=tip.getBoundingClientRect();
  if(x+r.width>window.innerWidth-8) x=oe.clientX-r.width-pad;
  if(y+r.height>window.innerHeight-8) y=oe.clientY-r.height-pad;
  tip.style.left=x+'px'; tip.style.top=y+'px';
}
function hideHovertip(){ const t=document.getElementById('hovertip'); if(t) t.classList.add('hidden'); }

mapEl.addEventListener('mousedown', e=>{ if(e.button===0) onDown(e); });
window.addEventListener('mousemove', e=>{ onMove(e); onHover(e); });
window.addEventListener('mouseup', onUp);
mapEl.addEventListener('mouseleave', ()=>{ if(hoverId!=null){ hoverId=null; scheduleDraw(); } hideHovertip(); });
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
  mapEl.classList.remove('tool-draw','tool-erase','tool-select','tool-pan');
  mapEl.classList.add('tool-'+t);
  // brush only matters when painting (draw / erase); it auto appears/disappears.
  document.getElementById('brushctl').classList.toggle('hidden', !(t==='draw'||t==='erase'));
  // in pan mode the map drags normally; editing tools capture the pointer.
  if(t==='pan'){ map.dragging.enable(); }
  hoverId=null; hideHovertip(); scheduleDraw();
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

// ---------- geolocation ("you are here") ----------
const geoBtn=document.getElementById('geoBtn');
if(!('geolocation' in navigator)) geoBtn.style.display='none';
geoBtn.onclick=()=>{ geoOn ? stopGeo() : startGeo(); };
function startGeo(){
  if(!('geolocation' in navigator)){ toast('Location not available'); return; }
  geoBtn.classList.add('locating');
  geoWatchId = navigator.geolocation.watchPosition(onGeo, onGeoErr,
    {enableHighAccuracy:true, maximumAge:10000, timeout:15000});
}
function stopGeo(){
  if(geoWatchId!=null){ navigator.geolocation.clearWatch(geoWatchId); geoWatchId=null; }
  geoOn=false; geoCellId=null; geoLatLng=null;
  geoBtn.classList.remove('on','locating');
  geoBtn.title='Show my location';
  scheduleDraw();
}
function onGeo(pos){
  const {latitude:lat, longitude:lng} = pos.coords;
  geoLatLng = [lat,lng];
  const c = cellAt(L.latLng(lat,lng));
  geoCellId = c ? c.id : null;
  const first = !geoOn;
  geoOn = true;
  geoBtn.classList.remove('locating'); geoBtn.classList.add('on');
  if(first){
    geoBtn.title = 'Hide my location';
    if(c) map.setView([lat,lng], Math.max(map.getZoom(), 10), {animate:true});
    else toast('You are outside the mapped area');
  }
  if(!geoAnimating) geoPulseLoop();
  scheduleDraw();
}
function onGeoErr(err){
  geoBtn.classList.remove('locating','on'); geoOn=false;
  toast(err && err.code===1 ? 'Location permission denied' : 'Could not get location');
}
// keep the highlighted hex in sync as the map / data moves
map.on('zoomend', ()=>{ if(geoOn && geoLatLng){ const c=cellAt(L.latLng(geoLatLng[0],geoLatLng[1])); geoCellId=c?c.id:null; } });

// ---------- status bar (selection actions) ----------
function updateStatusbar(){
  const sb=document.getElementById('statusbar');
  const n=selection.size;
  if(n===0){ sb.classList.add('hidden'); return; }
  sb.classList.remove('hidden');
  const areaHa=(grid&&grid.cellAreaKm2||10)*100*n;
  document.getElementById('selCount').textContent = n+' hex'+(n>1?'es':'')+' · '+fmtHa(areaHa);
}
document.getElementById('sbDone').onclick=()=>{ selection.clear(); selDirty=true; updateStatusbar(); scheduleDraw(); };
// Clear use: removes only the land-use colour (keeps group / note / wildlife).
document.getElementById('sbClear').onclick=()=>{
  const ids=[...selection];
  ids.forEach(id=>setLocal(id,{u:''}));
  api('/api/update','POST',{op:'clearUse', ids}).then(r=>{rev=r.rev;});
  renderLegend(); scheduleDraw();
};
// Delete: wipes everything for the selected cells (use, wildlife, group, note).
document.getElementById('sbDelete').onclick=()=>{
  const ids=[...selection];
  if(!ids.length) return;
  if(!confirm('Delete all data (use, wildlife, group, notes) for '+ids.length+' hex'+(ids.length>1?'es':'')+'?')) return;
  ids.forEach(id=>setLocal(id,{u:'',w:0,grp:'',nt:''}));
  api('/api/update','POST',{op:'delete', ids}).then(r=>{rev=r.rev;});
  renderLegend(); scheduleDraw();
};
// Ungroup: remove the group label from exactly the selected cells. Predictable
// — it acts on what you selected, nothing more.
document.getElementById('sbDissolve').onclick=()=>{
  const ids=[...selection].filter(id=>(state.get(id)||{}).grp);
  if(!ids.length){ toast('No grouped hexes in selection'); return; }
  ids.forEach(id=>setLocal(id,{grp:''}));
  api('/api/update','POST',{op:'group', ids, value:''}).then(r=>{rev=r.rev;});
  toast('Ungrouped '+ids.length+' hex'+(ids.length>1?'es':''));
  markDirty(); renderLegend(); scheduleDraw();
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
function openSheet(html){ hideHovertip(); sheet.innerHTML=html; sheet.classList.remove('hidden'); overlay.classList.remove('hidden'); }
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
      <button class="btn ghost" id="mLogout">Sign out</button>
    </div>`);
  document.getElementById('mVersions').onclick=versionsSheet;
  document.getElementById('mImport').onclick=importSheet;
  document.getElementById('mExportCsv').onclick=()=>{ window.location='/api/export?fmt=csv'; };
  document.getElementById('mExportGeo').onclick=()=>{ window.location='/api/export?fmt=geojson'; };
  document.getElementById('mHelp').onclick=helpSheet;
  document.getElementById('mLogout').onclick=doLogout;
}

async function doLogout(){
  await api('/api/logout','POST',{});
  // also clear any client-side mode state so the login sheet shows immediately
  document.body.classList.remove('boma-mode','global-mode');
  location.href='/';
}

function helpSheet(){
  openSheet(`<h2>How it works</h2>
    <p class="sub">Everything is the map.</p>
    <div class="hint">
      <b>Draw</b> — pick a use in the legend, then tap or drag to paint hexes. You can draw <i>anywhere</i> on the map — it snaps to the nearest hex.<br><br>
      <b>Rubber</b> — tap or drag to clear a hex's use.<br><br>
      <b>Brush size</b> — the dots next to the tools paint 1, 7, or 19 hexes at once.<br><br>
      <b>Pan</b> — the ✋ tool moves the map around without editing. (You can also pan in any tool by dragging on empty space, and shift-drag selects.)<br><br>
      <b>Select</b> — tap a hex to grab its whole same-colour patch (magic wand), or drag to lasso. Shift-click works in any tool. Then group, annotate, recolour (tap a legend swatch), <b>Clear use</b>, <b>Delete</b> (wipe everything), or <b>Ungroup</b> from the bottom bar.<br><br>
      <b>Hover</b> — point at a hex to see its land use, area (ha), group, and notes.<br><br>
      <b>Find me</b> — the ◉ button top-right asks for your location and gently flashes the hex you're standing in.<br><br>
      <b>Layers</b> — tap the ◉ eye in the legend to hide/show a layer. <b>Wildlife range</b> is a separate overlay (the only layer with a bold outline) — select hexes then tap it in the legend to toggle. Grouped or wildlife cells <b>dissolve</b> into one region.<br><br>
      <b>Versions</b> — every change autosaves. Open Versions to name one (keeps it) and share its link.<br><br>
      Each hex ≈ <b>10&nbsp;km²</b> (1000&nbsp;ha). Changes save automatically and everyone with the same secret edits the same map.
    </div>
    <div class="row end"><button class="btn primary" onclick="this.closest('.sheet').classList.add('hidden');document.getElementById('sheetOverlay').classList.add('hidden')">Got it</button></div>`);
}

async function versionsSheet(){
  openSheet(`<h2>Versions</h2><p class="sub">Every change is autosaved. Name a version to keep it, then share its link.</p>
    <div class="codebox"><input type="text" id="verName" placeholder="Name this version (e.g. Option B)">
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
    const auto=v.kind==='auto';
    const item=document.createElement('div'); item.className='list-item'+(auto?' auto':'');
    item.innerHTML=`<div class="meta"><div class="t">${esc(v.name)}${auto?' <span class=\"badge\">auto</span>':''}</div>
      <div class="s">${esc(v.author||'')} · ${fmtDate(v.created)}</div></div>
      <button class="btn ghost mini" data-act="name">${auto?'Name':'Rename'}</button>
      <button class="btn ghost mini" data-act="share">Link</button>
      <button class="btn ghost mini" data-act="restore">Restore</button>`;
    item.querySelector('[data-act="name"]').onclick=async()=>{
      const nm=prompt(auto?'Name this autosaved version to keep it:':'Rename version:', auto?'':v.name);
      if(nm==null) return; const t=nm.trim(); if(!t) return;
      const rr=await api('/api/versions/'+v.token,'POST',{name:t});
      if(rr&&rr.ok){ toast('Saved'); loadVersions(); } else toast('Failed');
    };
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

// ---------- auth gate ----------
function loginSheet(){
  openSheet(`<h2>${esc((me&&me.title)||'Land Use Zonation')}</h2>
    <p class="sub">Enter your name and a secret to start.</p>
    <label>Your name <span style="font-weight:400">(optional — we'll pick one)</span></label>
    <input type="text" id="liName" placeholder="anonymous editor">
    <label>Secret</label><input type="password" id="liSecret" placeholder="secret">
    <div class="row end"><button class="btn primary" id="liGo">Enter</button></div>`);
  overlay.onclick=null;
  const go=async()=>{
    const secret=document.getElementById('liSecret').value;
    if(!secret.trim()){ toast('Enter a secret'); return; }
    const name=document.getElementById('liName').value.trim();
    const r=await api('/api/login','POST',{secret,name});
    if(r&&r.ok){ closeSheet(); overlay.onclick=closeSheet; boot(); } else toast(r&&r.error||'Could not sign in');
  };
  document.getElementById('liGo').onclick=go;
  document.getElementById('liName').focus();
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

// install a grid object: cache per-cell bboxes, index by id, build adjacency.
function installGrid(g){
  grid=g; cellById=new Map(); nearestScale=null;
  for(const c of grid.cells){
    let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
    for(const p of c.g){ if(p[0]<minx)minx=p[0]; if(p[0]>maxx)maxx=p[0]; if(p[1]<miny)miny=p[1]; if(p[1]>maxy)maxy=p[1]; }
    c.minx=minx;c.miny=miny;c.maxx=maxx;c.maxy=maxy;
    cellById.set(c.id,c);
  }
  buildAdjacency();
}

async function loadGrid(){
  const res=await fetch('/static/data/grid.json'); installGrid(await res.json());
  const bb=grid.bounds; // [w,s,e,n]
  map.fitBounds([[bb[1],bb[0]],[bb[3],bb[2]]], {padding:[20,20]});
}

// ---------- dynamic ~10 km² hex grid (global mode) ----------
// Flat-top hexes on a global lattice. Pitch matches the original Boma grid so a
// hex is ~10 km² near the data's latitude. Cell ids are a stable function of
// (row,col), so drawings persist as you pan/zoom.
const DLON=0.0260618, DLAT=0.0298990; // column / row pitch in degrees
const GLOBAL_MIN_Z=8;                  // below this, the grid is too dense to draw
const MAX_CELLS=45000;                 // safety cap per viewport
function gid(r,c){ return (c+16384)*40000 + (r+16384); }
function ungid(id){ return {r:(id%40000)-16384, c:Math.floor(id/40000)-16384}; }
// centroid lon/lat of a cell id on the global lattice
function gidCentroid(id){ const {r,c}=ungid(id); const shift=(c&1)?DLAT/2:0; return [c*DLON, -(r*DLAT)-shift]; }
function genGrid(west,south,east,north){
  const R=DLON/1.5, halfR=R/2, halfH=DLAT/2;
  const w=west-DLON*2, e=east+DLON*2, s=south-DLAT*2, n=north+DLAT*2;
  const cmin=Math.floor(w/DLON), cmax=Math.ceil(e/DLON);
  if((cmax-cmin+1)*((n-s)/DLAT+2) > MAX_CELLS) return null;
  const rnd=v=>Math.round(v*1e5)/1e5;
  const cells=[];
  for(let c=cmin;c<=cmax;c++){
    const x=c*DLON, shift=(c&1)?halfH:0;
    const rmin=Math.floor((-n-shift)/DLAT), rmax=Math.ceil((-s-shift)/DLAT);
    for(let r=rmin;r<=rmax;r++){
      const y=-(r*DLAT)-shift;
      const g=[[rnd(x-R),rnd(y)],[rnd(x-halfR),rnd(y+halfH)],[rnd(x+halfR),rnd(y+halfH)],
              [rnd(x+R),rnd(y)],[rnd(x+halfR),rnd(y-halfH)],[rnd(x-halfR),rnd(y-halfH)]];
      cells.push({id:gid(r,c),r,c,ct:[rnd(x),rnd(y)],g});
    }
  }
  const latc=(s+n)/2;
  const area=(DLON*111.320*Math.cos(latc*Math.PI/180))*(DLAT*110.574); // km² at this latitude
  return {crs:'EPSG:4326',bounds:[w,s,e,n],cellAreaKm2:area,count:cells.length,cells};
}
// regenerate the grid for the current viewport, debounced. Used by BOTH modes:
// the grid is now a dynamic global lattice; Boma just starts focused on its data.
let regenTimer=null;
function scheduleRegen(){ clearTimeout(regenTimer); regenTimer=setTimeout(regenGlobalGrid,120); }
function regenGlobalGrid(){
  if(!me) return;
  const hint=document.getElementById('zoomhint');
  if(map.getZoom() < GLOBAL_MIN_Z){
    grid=null; cellById=new Map();
    ctx && ctx.clearRect(0,0,map.getSize().x,map.getSize().y);
    if(hint) hint.classList.remove('hidden');
    return;
  }
  const b=map.getBounds().pad(0.2);
  const g=genGrid(b.getWest(),b.getSouth(),b.getEast(),b.getNorth());
  if(!g){ if(hint) hint.classList.remove('hidden'); return; }
  if(hint) hint.classList.add('hidden');
  installGrid(g);
  scheduleDraw();
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
  if(!me.authed){ loginSheet(); return; }
  if(me.mode==='global'){ bootGlobal(); return; }
  bootBoma();
}

// Boma mode: the full hex land-use editor over the seeded data.
async function bootBoma(){
  document.body.classList.remove('global-mode');
  document.body.classList.add('boma-mode');
  document.getElementById('legendTitle').textContent='Land use';
  map.setMinZoom(2); map.setMaxZoom(19);
  sizeCanvas();
  setTool('draw');
  // zoom-in hint (shared with global mode)
  if(!document.getElementById('zoomhint')){
    const h=document.createElement('div'); h.id='zoomhint'; h.className='panel';
    h.textContent='Zoom in to draw the 10 km² hex grid';
    document.body.appendChild(h);
  }
  const st=await api('/api/state','GET');
  if(st&&st.cells) applyServerState(st);
  // fit to the extent of the loaded data (cell ids encode lat/lon on the lattice),
  // then generate the dynamic grid and keep it in sync on pan/zoom.
  fitToData();
  regenGlobalGrid();
  map.on('moveend zoomend', scheduleRegen);
  // shared version view?
  const vtok=new URLSearchParams(location.search).get('v');
  if(vtok){ loadSharedVersion(vtok); }
  scheduleDraw();
  renderLegend();
}

// fit the map to the bounding box of whatever cells are currently in `state`.
function fitToData(){
  if(!state.size){ map.setView([7,33.5], 9); return; }
  let w=Infinity,s=Infinity,e=-Infinity,n=-Infinity;
  for(const id of state.keys()){ const [lon,lat]=gidCentroid(id);
    if(lon<w)w=lon; if(lon>e)e=lon; if(lat<s)s=lat; if(lat>n)n=lat; }
  map.fitBounds([[s,w],[n,e]], {padding:[20,20], maxZoom:11});
}

// Global mode: a blank world map you can pan / zoom and jump to a country.
async function bootGlobal(){
  document.body.classList.remove('boma-mode');
  document.body.classList.add('global-mode');
  grid=null; cellById=new Map(); state.clear();
  map.setMinZoom(2); map.setMaxZoom(19);
  map.setView([20,0], 2);
  sizeCanvas(); setTool('pan');
  ctx && ctx.clearRect(0,0,map.getSize().x,map.getSize().y);
  // zoom-in hint shown when the viewport is too zoomed-out to draw the grid
  if(!document.getElementById('zoomhint')){
    const h=document.createElement('div'); h.id='zoomhint'; h.className='panel';
    h.textContent='Zoom in to draw the 10 km² hex grid';
    document.body.appendChild(h);
  }
  // a blank canvas: regenerate the dynamic grid for the current view, then keep
  // it in sync as the user pans / zooms. (Global mode shares the cell store with
  // Boma, so we don't preload it here — it stays a clean drawing surface.)
  regenGlobalGrid();
  map.on('moveend zoomend', scheduleRegen);
  // a simple country search box
  let bar=document.getElementById('countrybar');
  if(!bar){
    bar=document.createElement('div'); bar.id='countrybar'; bar.className='panel';
    bar.innerHTML='<input type="text" id="countryInput" placeholder="Zoom to a country…" autocomplete="off"><div id="countryResults"></div>';
    document.body.appendChild(bar);
    const inp=bar.querySelector('#countryInput');
    let t=null;
    inp.addEventListener('input',()=>{ clearTimeout(t); t=setTimeout(()=>countrySearch(inp.value.trim()),300); });
    inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ clearTimeout(t); countrySearch(inp.value.trim()); } });
  }
  bar.style.display='';
  renderLegend();
}

async function countrySearch(q){
  const box=document.getElementById('countryResults'); if(!box) return;
  if(!q){ box.innerHTML=''; return; }
  box.innerHTML='<div class="cr-item muted">Searching…</div>';
  try{
    const r=await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=6&q='+encodeURIComponent(q),{headers:{'Accept':'application/json'}});
    const list=await r.json();
    if(!list.length){ box.innerHTML='<div class="cr-item muted">No matches</div>'; return; }
    box.innerHTML='';
    for(const p of list){
      const it=document.createElement('div'); it.className='cr-item';
      it.textContent=p.display_name;
      it.onclick=()=>{
        box.innerHTML=''; document.getElementById('countryInput').value=p.display_name.split(',')[0];
        if(p.boundingbox){ const b=p.boundingbox.map(Number);
          map.fitBounds([[b[0],b[2]],[b[1],b[3]]],{padding:[20,20]});
        } else map.setView([+p.lat,+p.lon],6);
      };
      box.appendChild(it);
    }
  }catch(e){ box.innerHTML='<div class="cr-item muted">Search failed</div>'; }
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
