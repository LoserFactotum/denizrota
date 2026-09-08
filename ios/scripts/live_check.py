#!/usr/bin/env python3
"""Opt-in real-service integration check of the app's shared C engine.
Uses only Python stdlib and a C compiler; does NOT compile/test Swift or iOS UI.
Cached files and reproducible request URLs go into the chosen output directory.
"""
import argparse, collections, ctypes as C, hashlib, json, math
from pathlib import Path
import subprocess, urllib.parse, urllib.request

ROOT = Path(__file__).resolve().parents[1]
class Point(C.Structure):
    _fields_ = [('x', C.c_double), ('y', C.c_double)]
class Segment(C.Structure):
    _fields_ = [('a', Point), ('b', Point)]
class Raster(C.Structure):
    _fields_ = [('rows', C.c_size_t), ('columns', C.c_size_t), ('west', C.c_double), ('north', C.c_double),
                ('dx', C.c_double), ('dy', C.c_double), ('values', C.POINTER(C.c_double))]
class Grid(C.Structure):
    _fields_ = [('rows', C.c_size_t), ('columns', C.c_size_t), ('cell', C.c_double),
                ('depth', C.POINTER(C.c_double)), ('uncertainty', C.POINTER(C.c_double)), ('flags', C.POINTER(C.c_uint8))]
class Vessel(C.Structure):
    _fields_ = [(x, C.c_double) for x in ['draft', 'ukc', 'allowance', 'level', 'buffer']]
class Result(C.Structure):
    _fields_ = [('status', C.c_int), ('count', C.c_size_t), ('distance', C.c_double)]

def library(directory):
    lib = directory / 'libmarine.so'
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror','-pedantic','-O2','-shared','-fPIC',
        str(ROOT/'DenizRota/Core/MarineGrid.c'),str(ROOT/'DenizRota/Core/AutoRouter.c'),'-lm','-lz','-o',str(lib)],check=True)
    l = C.CDLL(str(lib.resolve()))
    l.dm_read_geotiff.argtypes = [C.c_void_p, C.c_size_t, C.POINTER(Raster)]
    l.dm_free_raster.argtypes = [C.POINTER(Raster)]
    l.dm_coast_mask.argtypes = [C.c_size_t,C.c_size_t,C.c_double,C.POINTER(Segment),C.c_size_t,C.POINTER(C.c_uint8)]
    l.dm_block_shape.argtypes = [C.c_size_t,C.c_size_t,C.c_double,C.POINTER(Point),C.c_size_t,C.c_int,C.POINTER(C.c_uint8)]
    l.dm_min_depth.argtypes = [C.POINTER(Raster)] + [C.c_double]*4
    l.dm_min_depth.restype = C.c_double
    l.dr_plan.argtypes = [C.POINTER(Grid),C.POINTER(Vessel),C.c_size_t,C.c_size_t,C.POINTER(C.c_size_t),C.c_size_t]
    l.dr_plan.restype = Result
    return l

def fetch(url, directory, suffix, body=None):
    identity = hashlib.sha256(url.encode()+(body or b'')).hexdigest()
    path = directory/(identity+suffix)
    if not path.exists():
        request = urllib.request.Request(url,data=body,headers={'User-Agent':'DenizRota/0.2 integration check'})
        with urllib.request.urlopen(request,timeout=140) as response:
            assert response.status==200
            data=response.read(80_000_001)
            assert 0 < len(data) <= 80_000_000
        path.write_bytes(data)
    return path.read_bytes(),path

def run(directory, start, goal):
    directory.mkdir(parents=True,exist_ok=True)
    l=library(directory)
    cell=150.0; ky=6371000*math.pi/180
    kx=ky*math.cos(math.radians((start[0]+goal[0])/2))
    w=math.floor((min(start[1],goal[1])-.18)*20)/20
    s=math.floor((min(start[0],goal[0])-.18)*20)/20
    cols=math.ceil((math.ceil((max(start[1],goal[1])+.18)*20)/20-w)*kx/cell)
    rows=math.ceil((math.ceil((max(start[0],goal[0])+.18)*20)/20-s)*ky/cell)
    n=s+rows*cell/ky;e=w+cols*cell/kx;size=rows*cols
    assert size<=1_000_000
    bbox=','.join(map(str,[w-.01,s-.01,e+.01,n+.01]))
    params=dict(service='WCS',version='1.0.0',request='GetCoverage',coverage='emodnet:mean',crs='EPSG:4326',
        bbox=bbox,format='GeoTIFF',interpolation='nearest',resx=str(1/960),resy=str(1/960),compression='NONE')
    url='https://ows.emodnet-bathymetry.eu/wcs?'+urllib.parse.urlencode(sorted(params.items()))
    print('Fetching EMODnet',bbox,flush=True)
    data,raster_file=fetch(url,directory,'.tif')
    raster=Raster();code=l.dm_read_geotiff(data,len(data),C.byref(raster));assert code==0,('GeoTIFF',code)
    assert raster.dx<=1/900 and raster.dy<=1/900
    bbox_osm=','.join(map(str,[s-.01,w-.01,n+.01,e+.01]))
    query=f'''[out:json][timeout:90];(
way["natural"="coastline"]({bbox_osm});
nwr["seamark:type"~"^(rock|wreck|obstruction|restricted_area|military_area|marine_farm)$"]({bbox_osm});
nwr["man_made"~"^(pier|breakwater|groyne)$"]({bbox_osm});
nwr["natural"="reef"]({bbox_osm}););out body geom;'''
    print('Fetching OSM',flush=True)
    osm_data,osm_file=fetch('https://overpass-api.de/api/interpreter',directory,'.json',urllib.parse.urlencode({'data':query}).encode())
    osm=json.loads(osm_data);assert not osm.get('remark'),osm.get('remark')
    def project(p): return Point((p['lon']-w)*kx,(p['lat']-s)*ky)
    def geometry(el): return [project(el)] if el['type']=='node' else [project(p) for p in el['geometry']]
    def equal(a,b): return math.hypot(a.x-b.x,a.y-b.y)<.01
    coast=[];shapes=[];balance={};coastways=0
    for element in osm['elements']:
        if element.get('tags',{}).get('natural')=='coastline':
            coastways+=1;g=geometry(element);nodes=element['nodes'];assert len(nodes)==len(g)
            for i in range(1,len(g)):
                coast.append(Segment(g[i-1],g[i]))
                for node,p,direction in [(nodes[i-1],g[i-1],1),(nodes[i],g[i],0)]:
                    if node not in balance: balance[node]=[0,0,p]
                    balance[node][direction]+=1
        elif element['type']=='relation':
            pieces=[geometry(m) for m in element['members'] if m.get('role')!='inner']
            while pieces:
                ring=pieces.pop(0)
                while len(ring)>1 and not equal(ring[0],ring[-1]):
                    indexes=[i for i,p in enumerate(pieces) if equal(p[0],ring[-1]) or equal(p[-1],ring[-1])]
                    assert indexes,('unclosed relation',element['id'])
                    part=pieces.pop(indexes[0])
                    if equal(part[-1],ring[-1]):part.reverse()
                    ring+=part[1:]
                shapes.append((ring,len(ring)>=4))
        else:
            g=geometry(element);shapes.append((g,len(g)>=4 and equal(g[0],g[-1])))
    gaps=[i for i,(inc,out,p) in balance.items() if 0<p.x<cols*cell and 0<p.y<rows*cell and (inc!=1 or out!=1)]
    assert not gaps,('coast gaps',gaps[:10])
    mask=(C.c_uint8*size)();segs=(Segment*len(coast))(*coast)
    assert l.dm_coast_mask(rows,cols,cell,segs,len(segs),mask)==0
    for g,fill in shapes:l.dm_block_shape(rows,cols,cell,(Point*len(g))(*g),len(g),fill,mask)
    depths=(C.c_double*size)(*[float('nan')]*size);uncertainty=(C.c_double*size)();flags=(C.c_uint8*size)()
    print('Raster decoded; building grid',rows,cols,'coast segments',len(coast),'shapes',len(shapes),flush=True)
    for row in range(rows):
        north=n-row*cell/ky;south=north-cell/ky
        for col in range(cols):
            i=row*cols+col
            if mask[i] in [2,4]:flags[i]=2;continue
            if mask[i]!=1:continue
            west=w+col*cell/kx
            d=l.dm_min_depth(C.byref(raster),west,south,west+cell/kx,north)
            if not math.isfinite(d):mask[i]=0;continue
            depths[i]=d;flags[i]=1
            if d<7.5:mask[i]=8
    grid=Grid(rows,cols,cell,depths,uncertainty,flags);vessel=Vessel(1.5,1,5,0,150)
    def index(p):return (rows-1-int((p[0]-s)*ky/cell))*cols+int((p[1]-w)*kx/cell)
    start_index=index(start);goal_index=index(goal)
    path=(C.c_size_t*size)();result=l.dr_plan(C.byref(grid),C.byref(vessel),start_index,goal_index,path,size)
    indexes=list(path[:result.count])
    # Independent check of every returned cell, full buffer neighborhood, and edge.
    for i in indexes:
        r,c=divmod(i,cols)
        for dy in [-1,0,1]:
            for dx in [-1,0,1]:
                j=(r+dy)*cols+c+dx
                assert 0<=r+dy<rows and 0<=c+dx<cols and flags[j]==1 and depths[j]>=7.5
    for a,b in zip(indexes,indexes[1:]):
        ar,ac=divmod(a,cols);br,bc=divmod(b,cols);assert max(abs(ar-br),abs(ac-bc))==1
        if ar!=br and ac!=bc:
            for rr,cc in [(ar,bc),(br,ac)]:
                for dy in [-1,0,1]:
                    for dx in [-1,0,1]:
                        j=(rr+dy)*cols+cc+dx;assert flags[j]==1 and depths[j]>=7.5
    coords=[[s+(rows-1-i//cols+.5)*cell/ky,w+(i%cols+.5)*cell/kx] for i in indexes]
    report={'status':result.status,'grid_rows':rows,'grid_columns':cols,'cell_m':cell,'coast_ways':coastways,
        'coast_segments':len(coast),'obstacle_shapes':len(shapes),'mask_counts':dict(collections.Counter(mask)),
        'raster_rows':raster.rows,'raster_columns':raster.columns,'raster_step':raster.dy,
        'source':'EMODnet mean DTM including GEBCO infill; cell-level lineage not resolved',
        'osm_timestamp':osm.get('osm3s',{}).get('timestamp_osm_base'),'raster_sha256':hashlib.sha256(data).hexdigest(),
        'osm_sha256':hashlib.sha256(osm_data).hexdigest(),'raster_url':url,'osm_query':query,
        'path_cells':result.count,'grid_distance_nm':result.distance/1852 if result.status==0 else None,
        'grid_duration_at_5kn_hours':result.distance/1852/5 if result.status==0 else None,
        'minimum_model_depth':min((depths[i] for i in indexes),default=None),'start':start,'goal':goal,
        'validation':'C numeric decoder + C coast/obstacle mask + C A*: every path edge and buffer checked. Swift/iOS not built.'}
    (directory/'live-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    (directory/'route.geojson').write_text(json.dumps({'type':'Feature','properties':report,'geometry':{'type':'LineString','coordinates':[[lon,lat] for lat,lon in coords]}},ensure_ascii=False))
    (directory/'grid-mask.bin').write_bytes(bytes(mask))
    (directory/'grid-bounds.json').write_text(json.dumps(dict(west=w,south=s,east=e,north=n,rows=rows,columns=cols)))
    l.dm_free_raster(C.byref(raster))
    print(json.dumps({k:v for k,v in report.items() if k not in ['osm_query','raster_url']},ensure_ascii=False,indent=2),flush=True)
    assert result.status==0,('No route',result.status, 'start/goal masks',mask[start_index],mask[goal_index])
    print('PASS live route and independent edge/buffer validation',flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--start',type=float,nargs=2,default=[36.700,27.700]);parser.add_argument('--goal',type=float,nargs=2,default=[37.010,27.435])
    args=parser.parse_args();run(args.output,args.start,args.goal)
