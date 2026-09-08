"""Numerical ingestion and geometric regressions using the app's compiled C."""
import ctypes as C
import math
from pathlib import Path
import random
import struct
import sys
import tempfile
import zlib
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from live_check import library, Raster, Point, Segment

checks=0
def check(condition):
    global checks
    assert condition
    checks+=1

def fixture(endian='>', compressed=False, pixel_point=False, matrix=False, signed=False):
    # 3x2 source pixels, top row north. Values include one land pixel and one unknown.
    values=[-10,-20,3,-40,-9999,-60]
    raw=struct.pack(endian+('6h' if signed else '6f'),*values)
    payload=zlib.compress(raw) if compressed else raw
    fields={256:(4,[3]),257:(4,[2]),258:(3,[16 if signed else 32]),259:(3,[8 if compressed else 1]),
            262:(3,[1]),273:(4,[0]),277:(3,[1]),278:(4,[2]),279:(4,[len(payload)]),339:(3,[2 if signed else 3]),
            34735:(3,[1,1,0,3,1024,0,1,2,1025,0,1,2 if pixel_point else 1,2048,0,1,4326]),42113:(2,b'-9999\0')}
    if matrix:fields[34264]=(12,[.01,0,0,27,0,-.01,0,37,0,0,0,0,0,0,0,1])
    else:fields.update({33550:(12,[.01,.01,0]),33922:(12,[0,0,0,27,37,0])})
    count=len(fields);start=8+2+count*12+4;extras=bytearray();entries=[]
    for tag,(typ,value) in sorted(fields.items()):
        b=value if typ==2 else struct.pack(endian+str(len(value))+{3:'H',4:'I',12:'d'}[typ],*value)
        if len(b)<=4:offset=b.ljust(4,b'\0')
        else:offset=struct.pack(endian+'I',start+len(extras));extras.extend(b)
        entries.append([tag,typ,len(value),offset])
    data_start=start+len(extras)
    for e in entries:
        if e[0]==273:e[3]=struct.pack(endian+'I',data_start)
    head=(b'MM' if endian=='>' else b'II')+struct.pack(endian+'HIH',42,8,count)
    for tag,typ,n,offset in entries:head+=struct.pack(endian+'HHI',tag,typ,n)+offset
    return head+struct.pack(endian+'I',0)+extras+payload

with tempfile.TemporaryDirectory() as temp:
    l=library(Path(temp))
    for endian in ['<','>']:
        for compression in [False,True]:
            for point in [False,True]:
                for matrix in [False,True]:
                    for signed in [False,True]:
                        data=fixture(endian,compression,point,matrix,signed);r=Raster()
                        check(l.dm_read_geotiff(data,len(data),C.byref(r))==0)
                        check((r.rows,r.columns)==(2,3));check(abs(r.west-(26.995 if point else 27))<1e-10)
                        check(abs(r.north-(37.005 if point else 37))<1e-10)
                        check(r.values[0]==-10 and r.values[2]==3 and math.isnan(r.values[4]))
                        # Half-cell inset avoids floating-point edge ambiguity in this test.
                        check(l.dm_min_depth(C.byref(r),r.west+.002,r.north-.008,r.west+.018,r.north-.002)==10)
                        check(l.dm_min_depth(C.byref(r),r.west+.022,r.north-.008,r.west+.028,r.north-.002)==-3)
                        check(math.isnan(l.dm_min_depth(C.byref(r),r.west+.012,r.north-.018,r.west+.018,r.north-.012)))
                        check(math.isnan(l.dm_min_depth(C.byref(r),r.west-.1,r.north-.02,r.west+.02,r.north)))
                        l.dm_free_raster(C.byref(r));check(not r.values)
    good=fixture(matrix=True)
    for n in range(len(good)):
        r=Raster();check(l.dm_read_geotiff(good[:n],n,C.byref(r))!=0)
    check(l.dm_read_geotiff(b'<ServiceException>error',23,C.byref(Raster()))!=0)
    random.seed(15)
    for _ in range(1000):
        data=random.randbytes(random.randrange(8,500));r=Raster()
        check(l.dm_read_geotiff(data,len(data),C.byref(r))!=0)
    rows=30;cols=30;cell=10
    mask=(C.c_uint8*(rows*cols))()
    def index(x,y):return (rows-1-int(y/cell))*cols+int(x/cell)
    # Counter-clockwise island: land left. All horizontal rows outside its
    # latitude range must remain sea through component propagation.
    p=[Point(100,100),Point(200,100),Point(200,200),Point(100,200),Point(100,100)]
    segments=(Segment*4)(*[Segment(a,b) for a,b in zip(p,p[1:])])
    check(l.dm_coast_mask(rows,cols,cell,segments,4,mask)==0)
    check(mask[index(150,150)]==2)
    for x,y in [(15,15),(285,285),(15,150),(285,150),(150,15),(150,285)]:check(mask[index(x,y)]==1)
    check(mask[index(105,105)]==4)
    # Open north-going mainland coast through both bbox edges: west land, east sea.
    segments=(Segment*1)(Segment(Point(150,-100),Point(150,400)))
    check(l.dm_coast_mask(rows,cols,cell,segments,1,mask)==0)
    check(mask[index(50,150)]==2 and mask[index(250,150)]==1)
    # Tiny island entirely within a cell cannot disappear through centre sampling.
    p=[Point(201,201),Point(203,201),Point(203,203),Point(201,203),Point(201,201)]
    l.dm_block_shape(rows,cols,cell,(Point*5)(*p),5,1,mask)
    check(mask[index(205,205)]==4)
    # Polygon interior, and a thin pier between centres, are blocked too.
    p=[Point(210,40),Point(270,40),Point(270,90),Point(210,90)]
    l.dm_block_shape(rows,cols,cell,(Point*4)(*p),4,1,mask)
    check(mask[index(245,65)]==4)
    p=[Point(260,100),Point(260,200)]
    l.dm_block_shape(rows,cols,cell,(Point*2)(*p),2,0,mask)
    check(mask[index(255,155)]==4 and mask[index(265,155)]==4)
    print(f'PASS: {checks} marine raster/geometry checks (32 TIFF encodings, truncation, malformed bytes, island/mainland/pier masks)')
