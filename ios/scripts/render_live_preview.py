"""Optional evidence figure. Requires numpy and matplotlib; not an app dependency."""
from pathlib import Path
import json, math
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
from matplotlib.lines import Line2D

root=Path(__file__).resolve().parents[1]/'evidence'
b=json.loads((root/'grid-bounds.json').read_text())
g=json.loads((root/'route.geojson').read_text())
p=np.array(g['geometry']['coordinates'])
mask=np.frombuffer((root/'grid-mask.bin').read_bytes(),dtype=np.uint8).reshape(b['rows'],b['columns'])
mapped=np.zeros_like(mask)
for i,v in enumerate([0,1,2,4,8]):mapped[mask==v]=i
fig=plt.figure(figsize=(8,9.7),dpi=150,facecolor='#fafbf9')
ax=fig.add_axes([.10,.18,.85,.64])
ax.imshow(mapped,extent=[b['west'],b['east'],b['south'],b['north']],origin='upper',
    cmap=ListedColormap(['#a3a8ae','#eaf4f8','#e4e1d7','#e78c7e','#ffdca5']),interpolation='nearest',vmin=0,vmax=4)
ax.plot(p[:,0],p[:,1],color='white',lw=5,zorder=4)
ax.plot(p[:,0],p[:,1],color='#007d79',lw=2.6,zorder=5)
for index,label,offset in [(0,'Datça açığı\nTest başlangıcı',(-14,-39)),(-1,'Bodrum açığı\nTest varışı',(12,10))]:
    x,y=p[index]
    ax.scatter([x],[y],s=65,c='#007d79',edgecolors='white',linewidths=2,zorder=6)
    ax.annotate(label,(x,y),xytext=offset,textcoords='offset points',fontsize=9,fontweight='bold',color='#173934',
        zorder=7,bbox=dict(boxstyle='round,pad=.35',fc='white',ec='none',alpha=.95))
ax.set_xlim(b['west'],b['east']);ax.set_ylim(b['south'],b['north'])
ax.set_aspect(1/math.cos(math.radians(36.85)))
ax.set_xlabel('Boylam (°D)',fontsize=9,color='#5a686b');ax.set_ylabel('Enlem (°K)',fontsize=9,color='#5a686b')
ax.tick_params(labelsize=8,colors='#5a686b')
for spine in ax.spines.values():spine.set_color('#b7c4c5')
fig.text(.10,.94,'DenizRota',fontsize=13,fontweight='bold',color='#007d79')
fig.text(.10,.905,'Datça açığı → Bodrum açığı',fontsize=21,fontweight='bold',color='#173934')
fig.text(.10,.875,'GERÇEK VERİ TESTİ  ·  08.09.2026',fontsize=9,color='#5a686b')
fig.text(.10,.835,'41,6 deniz mili     ·     5 kn → 8 sa 19 dk',fontsize=12,fontweight='bold',color='#173934')
legend=[Line2D([0],[0],color='#007d79',lw=3,label='Hesaplanan rota'),
    Line2D([0],[0],marker='s',ls='',mfc='#ffdca5',mec='none',label='Sığ model hücresi'),
    Line2D([0],[0],marker='s',ls='',mfc='#e78c7e',mec='none',label='Kıyı / engel')]
fig.legend(handles=legend,loc='lower left',bbox_to_anchor=(.09,.102),ncol=3,frameon=False,fontsize=8)
fig.text(.10,.076,'Örnek ayarlar: su çekimi 1,5 m + dip payı 1 m + model payı 5 m.\nKıyı/engel payı 150 m. Yolun en sığ model hücresi: 8,42 m.',fontsize=8,color='#5a686b',linespacing=1.5)
fig.text(.10,.032,'Kaynak: EMODnet DTM (GEBCO dolgusu dahil), © OpenStreetMap katkıcıları.\nC rota motoru testi; iPhone ekran görüntüsü veya seyir güvencesi değildir.',fontsize=7.5,color='#5a686b',linespacing=1.5)
fig.savefig(root/'Datca-Bodrum-Gercek-Veri-Testi.png',dpi=150,facecolor=fig.get_facecolor())
