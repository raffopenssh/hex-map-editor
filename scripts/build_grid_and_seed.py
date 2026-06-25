import fiona, rasterio, numpy as np, json, math, gzip
from pyproj import Transformer
from collections import Counter
GPKG='/tmp/drive/example hex grid.gpkg'; COL='/tmp/drive/example georef.tif'; BW='/tmp/drive/example georef bw.tif'
OUT='/home/exedev/landuse/srv/static/data'
LEGEND={'fishing':(8,163,230),'grazing':(141,176,92),'hunting':(216,145,70),'farming':(246,246,112),'settlement':(204,204,204),'wildlife':(227,234,200)}
BG=[(255,255,255),(240,240,240),(240,240,216),(216,216,216),(216,216,192),(216,216,168),(192,216,168),(192,192,192),(216,240,216),(192,192,168),(168,168,168),(255,255,236),(231,230,205),(245,245,245),(250,250,245)]
order=list(LEGEND.keys()); legcols=np.array([LEGEND[k] for k in order],float)
refall=np.vstack([legcols,np.array(BG,float)]); labels=order+['_bg']*len(BG)
t1=Transformer.from_crs('EPSG:3857','EPSG:3395',always_xy=True); t2=Transformer.from_crs('EPSG:3857','EPSG:4326',always_xy=True)
feats=[];cents=[];ids=[]
with fiona.open(GPKG) as src:
    for f in src:
        ring=f['geometry']['coordinates'][0];p=f['properties']
        xs=[c[0] for c in ring];ys=[c[1] for c in ring]
        cx3=sum(xs)/len(xs);cy3=sum(ys)/len(ys)
        cents.append((cx3,cy3));ids.append(p['id'])
        lon,lat=t2.transform(xs,ys)
        # drop duplicate closing point, round to 5 decimals (~1m)
        ringll=[[round(a,5),round(b,5)] for a,b in zip(lon,lat)]
        if ringll[0]==ringll[-1]: ringll=ringll[:-1]
        clon,clat=t2.transform([cx3],[cy3])
        feats.append({'id':p['id'],'r':p['row_index'],'c':p['col_index'],
                      'ct':[round(clon[0],5),round(clat[0],5)],'g':ringll})
cents=np.array(cents); cx,cy=t1.transform(cents[:,0],cents[:,1])
offs=[(0,0)]
for ring_r in (700,1300):
    for a in range(0,360,30): offs.append((ring_r*math.cos(math.radians(a)),ring_r*math.sin(math.radians(a))))
with rasterio.open(COL) as rc:
    samp=np.stack([np.array(list(rc.sample(np.c_[cx+ox,cy+oy])))[:,:3].astype(float) for ox,oy in offs],axis=1)
with rasterio.open(BW) as rb:
    kob=(np.array(list(rb.sample(np.c_[cx,cy])))[:,0]==1)
S=samp.shape[1]
def classify(P):
    d=np.linalg.norm(P[:,None,:]-refall[None,:,:],axis=2); nn=d.argmin(1)
    votes=[labels[k] for k in nn]; c=Counter(v for v in votes if v!='_bg')
    if not c: return None
    use,n=c.most_common(1)[0]
    return use if n>=max(5,S*0.35) else None
assigns={};counts=Counter()
for i,fid in enumerate(ids):
    use=classify(samp[i]); w=bool(kob[i])
    if use or w:
        d={}
        if use:d['u']=use
        if w:d['w']=1
        assigns[str(fid)]=d; counts[use]+=1
        if w: counts['_kob']+=1
# grid geographic bounds
allll=np.array([pt for f in feats for pt in f['g']])
bounds=[float(allll[:,0].min()),float(allll[:,1].min()),float(allll[:,0].max()),float(allll[:,1].max())]
grid={'crs':'EPSG:4326','bounds':bounds,'cellAreaKm2':10,'count':len(feats),'cells':feats}
gjson=json.dumps(grid,separators=(',',':'))
open(OUT+'/grid.json','w').write(gjson)
gzip.open(OUT+'/grid.json.gz','wt').write(gjson)
json.dump(assigns,open(OUT+'/initial.json','w'),separators=(',',':'))
print('cells',len(feats),'assigned',len(assigns),'counts',dict(counts))
print('bounds',bounds)
import os
print('grid.json',os.path.getsize(OUT+'/grid.json'),'gz',os.path.getsize(OUT+'/grid.json.gz'))
