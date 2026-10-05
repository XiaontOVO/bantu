// Geometry is traced from the official East Museum leaflet (2025) and
// Wutopia Lab's published Xujiahui Library plans, not from a generic room grid.
import { writeFileSync } from 'node:fs';
import { standardStyle, restroom } from './lib/floorplan-design.mjs';
const directory = 'public/images/places/floorplan/';
const text = (x,y,label,cls='label',size=18) => `<text class="${cls}" x="${x}" y="${y}" font-size="${size}" text-anchor="middle" dominant-baseline="central">${label}</text>`;
const rect=(x,y,w,h,cls='room')=>`<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
const stairs=(x,y,w=45,h=60)=>`<g class="stairs">${rect(x,y,w,h,'service')}<path d="${Array.from({length:7},(_,i)=>`M${x+5} ${y+8+i*(h-16)/6}h${w-10}`).join(' ')}" fill="none" stroke="#748aa8" stroke-width="1.1"/><path d="M${x+w*.75} ${y+h-6}V${y+6}l-4 7m4-7 4 7" fill="none" stroke="#748aa8" stroke-width="1.3"/></g>`;
function frame(title,floor,desc,body,notes,height=760) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="title desc">
<title id="title">${title} ${floor} 平面示意图</title><desc id="desc">${desc}</desc>
<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#223a50" flood-opacity=".08"/></filter></defs>
<style>.label{font-weight:600}.small{font-size:13px}.shell{filter:url(#shadow)}.wall{fill:none;stroke-width:1.6}.panel-title{font-size:18px}.panel-text{font-size:14px}.note{font-size:12px}.detail{fill:none;stroke:#748aa8;stroke-width:1;opacity:.45}.exit-label{fill:#287c57;font-size:14px;font-weight:600}</style>
<rect class="canvas" width="1200" height="${height}"/>
<text class="title" x="48" y="59" font-size="30">${title}</text><text class="sub" x="50" y="89" font-size="15">${desc.split('。')[0]}</text>
<g><rect x="1066" y="35" width="86" height="44" rx="12" fill="#eaf0f2"/>${text(1109,58,floor,'floor',25)}</g>
${body}
<rect class="panel" x="875" y="140" width="277" height="${height-255}" rx="16"/>
<text class="panel-title" x="901" y="181">图面识别</text>
${['展厅 / 阅览空间','公共通道','交通与服务区'].map((label,i)=>`${rect(901,207+i*38,18,18,['room','public','service'][i])}<text class="panel-text" x="931" y="${222+i*38}">${label}</text>`).join('')}
${restroom(944,344,1)}<text class="panel-text" x="901" y="385">蓝色标记为卫生间</text>
<path d="M901 410H1126" stroke="#d8e0e4"/>
<text class="panel-title" x="901" y="448">读图说明</text>
${notes.map((line,i)=>`<text class="panel-text" x="901" y="${480+i*26}">${line}</text>`).join('')}
<text class="note" x="48" y="${height-31}">伴途本地重绘 · 保留公开原图的空间关系 · 非测绘比例 · 静态图不显示实时位置</text>
${standardStyle()}
</svg>`;
}

// The upper and lower gallery bars enclose an open centre; the east wing
// contains the circular vertical connection. Preserve that topology.
const eastShell='M60 75H160V25H225V75H270V0H620V75H655V280H690V365H540V345H160V365H115V280H30V145H60Z';
const eastCorridor='M160 80H620V120H190V285H540V105H620V315H160Z';
for(const floor of ['B1','1F','2F','3F','4F']) {
  let shapes='', labels='', facilities='', contour=eastShell;
  const room=(x,y,w,h,label,cls='room',size=18)=>{shapes+=rect(x,y,w,h,cls);labels+=text(x+w/2,y+h/2,label,'label',size);};
  if(floor==='B1') {
    contour='M390 0H480V85H535V65H625V180H560V270H625V300H520V345H410V325H170V360H25V310H170V300H220V160H390Z';
    shapes+=`<path class="public" d="${contour}"/>`;
    room(220,163,178,112,'学术报告厅');room(25,312,145,48,'多功能教室','room-light',16);room(510,300,112,46,'数字影院','room',16);
    shapes+=rect(394,0,82,82,'service'); labels+=text(435,40,'餐厅','small',15);
    labels+=text(590,132,'B1 东入口','exit-label',14)+text(343,323,'B1 南出口','exit-label',14);
    facilities+=restroom(398,112,.85)+restroom(460,333,.85)+stairs(402,249,48,45);
    shapes+='<ellipse class="detail" cx="473" cy="178" rx="20" ry="45"/>';
  } else {
    shapes+=`<path class="public" d="${eastCorridor}"/>`;
    if(floor==='1F') {
      room(30,145,130,135,'青铜馆');room(318,165,200,95,'第一特展厅');room(300,317,215,52,'雕塑馆');room(620,120,70,130,'上博文创','room-light',15);
      shapes+=rect(160,111,150,176,'public');labels+=text(240,211,'中央大厅','public-label',22)+text(195,55,'北入口','exit-label',15)+text(606,350,'东南出口','exit-label',14);
      facilities+=restroom(98,129,.85)+restroom(541,334,.85)+stairs(320,119,94,36)+stairs(515,266,30,32);
      shapes+='<ellipse class="detail" cx="581" cy="206" rx="18" ry="43"/>';
    }
    if(floor==='2F') {
      room(270,0,132,82,'玉器馆');room(402,0,126,82,'玺印篆刻馆','room',16);room(570,0,170,82,'书法馆');
      room(30,145,115,130,'第二特展厅','room-light',16);room(170,141,78,106,'数字馆','room-light',16);
      room(235,320,117,62,'海上书画馆','room-light',16);room(352,320,147,62,'绘画专题厅','room-light',16);room(499,300,241,82,'绘画馆');
      facilities+=restroom(160,58,.85)+restroom(683,270,.85)+stairs(342,136,102,34)+stairs(343,239,102,34);
      shapes+='<circle class="void" cx="633" cy="202" r="64"/>';labels+=text(633,202,'中庭','small',16);
    }
    if(floor==='3F') {
      room(270,0,308,82,'陶瓷馆');room(170,147,142,100,'陶瓷专题馆','room-light',16);room(235,320,214,62,'货币馆');room(449,320,103,62,'第三特展厅','room-light',15);room(585,304,190,92,'古代文明探索宫','room',16);
      shapes+=rect(621,20,125,125,'service');labels+=text(683,82,'餐饮区','small',16);
      facilities+=restroom(160,58,.85)+restroom(620,276,.85)+stairs(312,141,28,98)+stairs(404,216,84,30);
      shapes+='<circle class="void" cx="650" cy="219" r="58"/><path class="detail" d="M602 253A58 58 0 1 1 696 222"/>';
      labels+=text(655,219,'环形交通空间','small',13);
    }
    if(floor==='4F') {
      room(160,11,98,82,'创意工坊','room-light',16);room(280,0,310,100,'江南造物馆');room(136,155,132,112,'<tspan x="202" dy="-9">文物保护修复</tspan><tspan x="202" dy="21">体验馆</tspan>','room-light',16);room(192,320,179,80,'赵朴初艺术馆','room-light',16);room(371,320,214,80,'考古馆');room(638,300,165,105,'古代文明探索宫','room',16);
      facilities+=restroom(160,111,.85)+restroom(630,276,.85)+stairs(278,157,29,95);
      shapes+='<circle class="void" cx="650" cy="199" r="63"/><path class="detail" d="M600 237A63 63 0 1 1 704 206"/>';
      labels+=text(650,199,'环形交通空间','small',13)+text(661,60,'通往 5F','exit-label',14);
    }
    // The centre is an open court, not an invented enclosed gallery.
    if(floor!=='1F') shapes+=rect(315,127,204,151,'cutout');
  }
  const body=`<g transform="translate(69 215) scale(.93) rotate(-11 390 190)"><path class="shell" d="${contour}"/>${shapes}${labels}${facilities}</g>`;
  writeFileSync(directory+`shanghai-museum-east-${floor.toLowerCase()}.svg`,frame('上海博物馆东馆',floor,'依据官方导览折页（2025）重绘。展陈与开放范围以现场为准。',body,['保留展厅、通廊与中庭关系','扶梯以细线踏步表示','未标注实时位置与推荐路线','展厅名称按 2025 年折页']), 'utf8');
}

// The 5F diagram is a small unrotated inset on the same leaflet.
const roofBody=`<g transform="translate(80 230)"><path class="shell" d="M0 30H710V260H0Z"/>${rect(0,30,270,230,'service')}${rect(270,30,280,230,'garden')}${rect(330,80,120,110,'cutout')}<path class="wall" d="M570 120a78 78 0 1 1 15 105"/>${rect(350,0,155,50,'service')}${stairs(380,12,95,28)}${text(135,150,'平台','label',22)}${text(425,226,'屋顶花园','label',22)}${text(420,135,'挑空','small',16)}${text(634,142,'环形屋面步道','small',15)}${text(427,69,'江南造物馆上空','small',13)}</g>`;
writeFileSync(directory+'shanghai-museum-east-5f.svg',frame('上海博物馆东馆','5F','依据官方折页屋顶花园附图重绘。户外区域开放状态以现场为准。',roofBody,['平台、花园与环形步道','4F 上行连接位于北侧','此层未核实卫生间位置']), 'utf8');

for(const floor of [1,2,3]) {
  let shapes='',labels='',facilities='',detail='';
  const room=(d,x,y,name,cls='room',size=18)=>{shapes+=`<path class="${cls}" d="${d}"/>`;labels+=text(x,y,name,'label',size);};
  // Source plans taper at the south facade. Retain the service cores,
  // central atrium, and southern semicircular wing/lecture room.
  const shell='M40 0H760L650 660H160Z';
  shapes+=`<path class="public" d="${shell}"/>`;
  room('M47 9H137V120H67Z',98,64,['儿童阅览区','自习室','讨论室'][floor-1],'room-light',16);
  room('M663 9H751L732 120H663Z',707,64,['楼梯间','电子阅览室','办公区'][floor-1],'service',15);
  shapes+=rect(155,24,90,57,'service')+rect(555,24,90,57,'service')+stairs(164,31,69,42)+stairs(565,31,69,42);
  shapes+=rect(155,84,90,36,'service')+rect(555,84,90,36,'service');
  if(floor===1) {
    room('M252 14H549V120H252Z',400,66,'入口门厅','public',20);
    room('M73 130H245V427H123Z',167,260,'儿童阅读','room',20);
    room('M555 130H730L681 427H555Z',636,260,'咖啡茶饮','room-light',20);
  }
  if(floor===2) {
    room('M252 14H549V120H252Z',400,66,'北侧阅读区','room',20);
    room('M73 130H245V427H123Z',167,260,'西侧阅读区','room',20);
    room('M555 130H730L681 427H555Z',636,260,'东侧阅读区','room',20);
  }
  if(floor<3) {
    room('M286 140H345V437H286Z',315,315,'西侧展区','room-light',14);
    room('M455 140H514V437H455Z',485,315,'东侧展区','room-light',14);
    shapes+=rect(351,140,98,297,'cutout');labels+=text(400,276,'中庭','small',17);
    facilities+=stairs(293,148,43,53)+stairs(464,148,43,53)+stairs(293,376,43,53)+stairs(464,376,43,53);
  } else {
    room('M252 14H549V120H252Z',400,66,'期刊阅览区','room',20);
    room('M73 130H245V427H123Z',167,260,'珍贵文献阅读','room',19);
    room('M555 130H730L681 427H555Z',636,260,'展示空间','room-light',20);
    shapes+=rect(347,138,108,298,'void');labels+=text(400,276,'中庭挑空','small',17);
    labels+=text(299,284,'西侧休息区','small',13)+text(503,284,'东侧休息区','small',13);
    detail+='<path class="detail" d="M324 153a30 30 0 0 0 0 60M324 246a30 30 0 0 0 0 60M324 339a30 30 0 0 0 0 60M475 153a30 30 0 0 1 0 60M475 246a30 30 0 0 1 0 60M475 339a30 30 0 0 1 0 60"/>';
  }
  shapes+=rect(149,445,98,79,'service');labels+=text(198,485,'货梯厅','small',15);
  shapes+=rect(555,445,121,79,'service')+rect(570,548,90,50,'service');
  facilities+=restroom(620,486,.82)+restroom(615,573,.82);
  if(floor===1) {
    labels+=text(578,463,'客梯','small',13);
    shapes+='<path class="service" d="M263 542A150 150 0 0 1 537 650H263Z"/>';
    detail+='<path class="detail" d="M285 650A130 130 0 0 1 515 650M305 650A107 107 0 0 1 495 650"/>';
    labels+=text(400,627,'南侧弧形空间','small',14);
  }
  if(floor===2) {room('M267 542H546V648H267Z',405,594,'办公室','service',18);}
  if(floor===3) {room('M268 542H548V648H268Z',408,594,'报告厅','room',20);detail+=Array.from({length:6},(_,i)=>`<path class="detail" d="M285 ${554+i*14}H530"/>`).join('');}
  facilities+=stairs(171,585,67,59)+stairs(572,600,60,44);
  // Furniture cues only in the documented reading bands, away from labels.
  detail+=Array.from({length:3},(_,i)=>`${rect(142,154+i*82,78,10,'service')}${rect(593,154+i*82,61,10,'service')}`).join('');
  shapes+=`<path class="wall" d="${shell}"/><path class="detail" d="M245 130V428M555 130V428M255 525H553"/>`;
  const body=`<g transform="translate(65 133) scale(.94)"><path class="shell" d="${shell}"/>${shapes}${detail}${labels}${facilities}</g>`;
  writeFileSync(directory+`xujiahui-library-${floor}f.svg`,frame('徐家汇书院',`${floor}F`,'依据建筑师公开设计平面重绘。功能分区与运营现状可能调整。',body,['保留梯形轮廓与中央中庭','南侧服务区标出卫生间','展示、休息区保持通廊关系','家具仅用于辨认空间类型'],900),'utf8');
}
