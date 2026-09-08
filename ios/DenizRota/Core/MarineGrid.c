#include "MarineGrid.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

typedef struct { const uint8_t *b; size_t n; int little; } Reader;
typedef struct { unsigned type; size_t count, pos; } Tag;
static uint64_t word(const Reader *r, size_t p, size_t n) {
    uint64_t v = 0;
    if (p > r->n || n > r->n-p || n > 8) return 0;
    for (size_t i=0; i<n; ++i) v |= (uint64_t)r->b[p+i] << (8*(r->little?i:n-i-1));
    return v;
}
static size_t type_size(unsigned t) {
    switch(t) { case 1: case 2: return 1; case 3: return 2;
        case 4: case 9: case 11: return 4; case 12: return 8; default: return 0; }
}
static double number(const Reader *r, Tag t, size_t i) {
    if(i>=t.count) return NAN;
    size_t s=type_size(t.type); uint64_t v=word(r,t.pos+i*s,s);
    if(t.type==12) { double d; memcpy(&d,&v,8); return d; }
    if(t.type==11) { uint32_t u=(uint32_t)v; float f; memcpy(&f,&u,4); return f; }
    if(t.type==9) return (int32_t)v;
    return (double)v;
}
static int tag(const Reader *r, unsigned id, Tag *t) {
    size_t p=(size_t)word(r,4,4);
    if(p>r->n || r->n-p<2) return 0;
    size_t n=(size_t)word(r,p,2);
    if(n>4096 || r->n-p-2<n*12+4) return 0;
    for(size_t i=0;i<n;++i) {
        size_t q=p+2+12*i;
        if(word(r,q,2)!=id) continue;
        t->type=(unsigned)word(r,q+2,2); t->count=(size_t)word(r,q+4,4);
        size_t s=type_size(t->type);
        if(!s || t->count>r->n/s) return 0;
        size_t bytes=t->count*s;
        t->pos=bytes<=4?q+8:(size_t)word(r,q+8,4);
        return t->pos<=r->n && bytes<=r->n-t->pos;
    }
    return 0;
}
static double scalar(const Reader *r, unsigned id, double fallback) {
    Tag t; return tag(r,id,&t)&&t.count==1&&(t.type==3||t.type==4)?number(r,t,0):fallback;
}
void dm_free_raster(DMRaster *r) { if(r) { free(r->values); memset(r,0,sizeof(*r)); } }
int dm_read_geotiff(const uint8_t *bytes,size_t length,DMRaster *out) {
    if(!out) return 1;
    memset(out,0,sizeof(*out));
    if(!bytes || length<8 || length>100000000) return 1;
    Reader r={bytes,length,bytes[0]=='I'};
    if(!((bytes[0]=='I'&&bytes[1]=='I')||(bytes[0]=='M'&&bytes[1]=='M')) || word(&r,2,2)!=42) return 2;
    size_t cols=(size_t)scalar(&r,256,0),rows=(size_t)scalar(&r,257,0);
    if(!cols || !rows || cols>8192 || rows>8192 || rows*cols>5000000) return 3;
    unsigned bits=(unsigned)scalar(&r,258,0),format=(unsigned)scalar(&r,339,1);
    unsigned compression=(unsigned)scalar(&r,259,1),predictor=(unsigned)scalar(&r,317,1);
    if(scalar(&r,277,1)!=1 || scalar(&r,274,1)!=1 || scalar(&r,284,1)!=1 ||
       scalar(&r,262,1)!=1 || (bits!=16&&bits!=32&&bits!=64) ||
       !((format==2&&(bits==16||bits==32))||(format==3&&(bits==32||bits==64)))) return 4;
    if((compression!=1&&compression!=8&&compression!=32946)||predictor!=1) return 5;
    Tag scale,tie,keys,offsets,counts,matrix;
    if(!tag(&r,34735,&keys)||keys.type!=3||keys.count<4) return 6;
    int geographic=0,area=1,model=0;
    size_t keyCount=(size_t)number(&r,keys,3);
    if(keyCount>(keys.count-4)/4) return 6;
    for(size_t i=0;i<keyCount;++i) {
        unsigned id=(unsigned)number(&r,keys,4+i*4);
        double location=number(&r,keys,5+i*4),count=number(&r,keys,6+i*4),v=number(&r,keys,7+i*4);
        if(location==0&&count==1) {
            if(id==2048) geographic=v==4326;
            if(id==1024) model=(int)v;
            if(id==1025) area=(int)v;
        }
    }
    if(!geographic || model!=2 || (area!=1&&area!=2)) return 7;
    double dx,dy,west,north;
    if(tag(&r,34264,&matrix)) {
        if(matrix.type!=12 || matrix.count!=16 || number(&r,matrix,1)!=0 ||
           number(&r,matrix,2)!=0 || number(&r,matrix,4)!=0 || number(&r,matrix,6)!=0 ||
           number(&r,matrix,12)!=0 || number(&r,matrix,13)!=0 || number(&r,matrix,14)!=0 ||
           number(&r,matrix,15)!=1) return 6;
        dx=number(&r,matrix,0);dy=-number(&r,matrix,5);
        west=number(&r,matrix,3);north=number(&r,matrix,7);
    } else {
        if(!tag(&r,33550,&scale)||scale.type!=12||scale.count<2 || !tag(&r,33922,&tie)||tie.type!=12||tie.count!=6) return 6;
        dx=number(&r,scale,0);dy=number(&r,scale,1);
        west=number(&r,tie,3)-number(&r,tie,0)*dx;
        north=number(&r,tie,4)+number(&r,tie,1)*dy;
    }
    if(area==2) { west-=dx/2; north+=dy/2; }
    if(!isfinite(dx)||!isfinite(dy)||dx<=0||dy<=0||dx>1||dy>1||
       !isfinite(west)||!isfinite(north)||west < -180||west+cols*dx>180.0001||
       north>90.0001||north-rows*dy < -90.0001) return 8;
    double noData=NAN; Tag nd;
    if(tag(&r,42113,&nd)) {
        if(nd.type!=2||nd.count==0||nd.count>128) return 8;
        char text[129]={0}; memcpy(text,bytes+nd.pos,nd.count);
        char *end; noData=strtod(text,&end); if(end==text) return 8;
    }
    int tiled=tag(&r,324,&offsets);
    if(!tiled && !tag(&r,273,&offsets)) return 9;
    if(!tag(&r,tiled?325:279,&counts)||offsets.count!=counts.count ||
       (offsets.type!=3&&offsets.type!=4)||(counts.type!=3&&counts.type!=4)) return 9;
    size_t bw=tiled?(size_t)scalar(&r,322,0):cols;
    size_t bh=(size_t)scalar(&r,tiled?323:278,(double)rows);
    if(!bw||!bh||bw>8192||bh>8192) return 9;
    size_t nx=(cols+bw-1)/bw,ny=(rows+bh-1)/bh;
    if(offsets.count!=nx*ny) return 9;
    double *values=malloc(rows*cols*sizeof(double));
    if(!values) return 10;
    size_t sample=bits/8;
    for(size_t b=0;b<nx*ny;++b) {
        size_t off=(size_t)number(&r,offsets,b),n=(size_t)number(&r,counts,b);
        size_t h=tiled?bh:(b*bh+bh>rows?rows-b*bh:bh),rawN=bw*h*sample;
        if(off>length||n>length-off||!n||rawN>100000000) { free(values); return 11; }
        uint8_t *raw=malloc(rawN);
        if(!raw) { free(values); return 10; }
        if(compression==1) {
            if(n!=rawN) { free(raw); free(values); return 11; }
            memcpy(raw,bytes+off,n);
        } else {
            uLongf size=(uLongf)rawN;
            if(uncompress(raw,&size,bytes+off,(uLong)n)!=Z_OK||size!=rawN) { free(raw); free(values); return 12; }
        }
        Reader chunk={raw,rawN,r.little};
        for(size_t y=0;y<h;++y) for(size_t x=0;x<bw;++x) {
            size_t row=(b/nx)*bh+y,col=(b%nx)*bw+x;
            if(row>=rows||col>=cols) continue;
            uint64_t v=word(&chunk,(y*bw+x)*sample,sample); double d;
            if(format==2) d=bits==16?(double)(int16_t)v:(double)(int32_t)v;
            else if(bits==32) { uint32_t u=(uint32_t)v; float f; memcpy(&f,&u,4); d=f; }
            else { memcpy(&d,&v,8); }
            values[row*cols+col]=!isfinite(d)||d==noData||fabs(d)>15000?NAN:d;
        }
        free(raw);
    }
    *out=(DMRaster){rows,cols,west,north,dx,dy,values}; return 0;
}

double dm_min_depth(const DMRaster *r,double w,double s,double e,double n) {
    if(!r||!r->values||!isfinite(w)||!isfinite(s)||!isfinite(e)||!isfinite(n)||
       w>=e||s>=n||w<r->west||e>r->west+r->columns*r->dx||n>r->north||s<r->north-r->rows*r->dy) return NAN;
    size_t c0=(size_t)floor((w-r->west)/r->dx),c1=(size_t)ceil((e-r->west)/r->dx);
    size_t r0=(size_t)floor((r->north-n)/r->dy),r1=(size_t)ceil((r->north-s)/r->dy);
    if(c1>r->columns) c1=r->columns;
    if(r1>r->rows) r1=r->rows;
    double depth=INFINITY;
    for(size_t y=r0;y<r1;++y) for(size_t x=c0;x<c1;++x) {
        double d=r->values[y*r->columns+x]; if(!isfinite(d)) return NAN;
        if(-d<depth) depth=-d;
    }
    return isfinite(depth)?depth:NAN;
}

int dm_cell_index(size_t rows,size_t cols,double cell,DMPoint p,size_t *index) {
    if(!index||!rows||!cols||!isfinite(cell)||cell<=0||!isfinite(p.x)||!isfinite(p.y)||
       p.x<0||p.y<0||p.x>=cols*cell||p.y>=rows*cell) return 0;
    *index=(rows-1-(size_t)floor(p.y/cell))*cols+(size_t)floor(p.x/cell); return 1;
}
static double segment_distance(DMPoint p,DMPoint a,DMPoint b) {
    double dx=b.x-a.x,dy=b.y-a.y,len=dx*dx+dy*dy;
    double t=len>0?((p.x-a.x)*dx+(p.y-a.y)*dy)/len:0;
    t=fmax(0,fmin(1,t)); return hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}
static int inside(DMPoint p,const DMPoint *v,size_t count) {
    int in=0;
    for(size_t i=0,j=count-1;i<count;j=i++)
        if((v[i].y>p.y)!=(v[j].y>p.y) && p.x<(v[j].x-v[i].x)*(p.y-v[i].y)/(v[j].y-v[i].y)+v[i].x) in=!in;
    return in;
}
void dm_block_shape(size_t rows,size_t cols,double cell,const DMPoint *p,size_t count,int fill,uint8_t *mask) {
    if(!p||!count||!mask||!rows||!cols||!isfinite(cell)||cell<=0) return;
    double w=p[0].x,e=w,s=p[0].y,n=s;
    for(size_t i=0;i<count;++i) { if(!isfinite(p[i].x)||!isfinite(p[i].y)) return;
        w=fmin(w,p[i].x);e=fmax(e,p[i].x);s=fmin(s,p[i].y);n=fmax(n,p[i].y); }
    double pad=cell*0.707106782;
    if(e+pad<0||w-pad>cols*cell||n+pad<0||s-pad>rows*cell) return;
    size_t x0=(size_t)fmax(0,floor((w-pad)/cell)),x1=(size_t)fmin(cols,ceil((e+pad)/cell));
    size_t y0=(size_t)fmax(0,floor((s-pad)/cell)),y1=(size_t)fmin(rows,ceil((n+pad)/cell));
    for(size_t y=y0;y<y1;++y) for(size_t x=x0;x<x1;++x) {
        DMPoint q={(x+0.5)*cell,(y+0.5)*cell}; int blocked=fill&&count>=3&&inside(q,p,count);
        if(count==1) blocked=hypot(q.x-p[0].x,q.y-p[0].y)<=pad;
        for(size_t i=1;!blocked&&i<count;++i) blocked=segment_distance(q,p[i-1],p[i])<=pad;
        if(fill&&!blocked&&count>=3) blocked=segment_distance(q,p[count-1],p[0])<=pad;
        if(blocked) mask[(rows-1-y)*cols+x]=4;
    }
}
typedef struct { double x; int north; } Crossing;
static int compare_crossing(const void *a,const void *b) {
    double x=((const Crossing *)a)->x,y=((const Crossing *)b)->x; return (x>y)-(x<y);
}
int dm_coast_mask(size_t rows,size_t cols,double cell,const DMSegment *coast,size_t count,uint8_t *mask) {
    if(!rows||!cols||rows>1000000/cols||!count||count>300000||!coast||!mask||!isfinite(cell)||cell<=0) return 1;
    size_t total=rows*cols;
    memset(mask,0,total);
    Crossing *cross=malloc(count*sizeof(*cross));
    size_t *queue=malloc(total*sizeof(*queue)); uint8_t *visited=calloc(total,1);
    if(!cross||!queue||!visited) { free(cross);free(queue);free(visited);return 2; }
    for(size_t i=0;i<count;++i) { DMPoint p[2]={coast[i].a,coast[i].b};
        if(!isfinite(p[0].x)||!isfinite(p[0].y)||!isfinite(p[1].x)||!isfinite(p[1].y)) { free(cross);free(queue);free(visited);return 1; }
        dm_block_shape(rows,cols,cell,p,2,0,mask);
    }
    for(size_t row=0;row<rows;++row) {
        double y=(rows-row-0.5)*cell; size_t c=0;
        for(size_t i=0;i<count;++i) {
            DMPoint a=coast[i].a,b=coast[i].b;
            if((a.y>y)!=(b.y>y)) cross[c++]=(Crossing){a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y),b.y>a.y};
        }
        if(!c) continue;
        qsort(cross,c,sizeof(*cross),compare_crossing);
        size_t next=0; int label=cross[0].north?2:1;
        for(size_t col=0;col<cols;++col) {
            double x=(col+0.5)*cell;
            while(next<c && cross[next].x<x) { label=cross[next].north?1:2; ++next; }
            /* Inconsistent adjacent orientations imply incomplete/broken geometry. */
            int valid=next==0||next==c||cross[next-1].north!=cross[next].north;
            if(mask[row*cols+col]!=4) mask[row*cols+col]=valid?(uint8_t)label:0;
        }
    }
    /* Fill rows without crossings, while detecting contradictory components.
       A coast barrier prevents sea and land from sharing a component. */
    for(size_t seed=0;seed<total;++seed) {
        if(visited[seed]||mask[seed]==4) continue;
        size_t head=0,tail=1; queue[0]=seed; visited[seed]=1; int bits=0;
        while(head<tail) {
            size_t i=queue[head++],r=i/cols,c=i%cols; bits|=mask[i];
            size_t neighbors[4]={r?i-cols:i,r+1<rows?i+cols:i,c?i-1:i,c+1<cols?i+1:i};
            for(size_t k=0;k<4;++k) { size_t j=neighbors[k];
                if(!visited[j]&&mask[j]!=4) { visited[j]=1;queue[tail++]=j; } }
        }
        uint8_t value=bits==1?1:bits==2?2:0;
        for(size_t i=0;i<tail;++i) mask[queue[i]]=value;
    }
    free(cross);free(queue);free(visited);return 0;
}
